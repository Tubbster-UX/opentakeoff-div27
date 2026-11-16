// Brink upload app. Plain JS, no build step, no CDN.
//
// Screens: #/ (projects), #/p/<id> (one project). Uploads go straight from
// this page to the object store in 16 MiB+ parts through presigned URLs:
// 4 parts at a time, each retried up to 5 times with backoff. Finished part
// ETags are kept in localStorage, so a failed or interrupted upload resumes
// with the same uploadId (pick the same file again after a reload).
"use strict";

const PARALLEL = 4;
const PART_TRIES = 5;
const URL_MAX_AGE_MS = 5 * 3600 * 1000; // presigned URLs live 6 h
const SAVE_KEY = "brink.uploads.v1";

const KIND_LABELS = {
  plan: "Plans",
  spec: "Specifications",
  sow: "SOW / solicitation",
  form: "Forms",
  doc: "Documents",
  sheet: "Spreadsheets",
  image: "Images",
  other: "Other files",
  output: "Made by Claude",
};
const KIND_ORDER = Object.keys(KIND_LABELS);

// ── tiny DOM helper (text only, never innerHTML) ─────────────────────────────

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k in el && k !== "list" && k !== "form") el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return Math.ceil(sec) + " s";
  if (sec < 3600) return Math.ceil(sec / 60) + " min";
  return (sec / 3600).toFixed(1) + " h";
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner(text) {
  const b = document.getElementById("banner");
  b.textContent = text || "";
  b.hidden = !text;
}

// ── API ─────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check the connection and try again.");
  }
  if (r.status === 401) {
    location.href = "/login?next=" + encodeURIComponent("/" + location.hash);
    throw new ApiError(401, "not_signed_in", "Signed out.");
  }
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new ApiError(r.status, data?.error || "error", data?.message || `The server answered ${r.status}.`);
  return data;
}

// ── saved (resumable) upload state ──────────────────────────────────────────

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
function writeSaved(all) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(all));
  } catch {
    /* private mode or full: resume within this page still works */
  }
}
function saveUpload(u) {
  const all = loadSaved();
  all[u.uploadId] = {
    projectId: u.projectId,
    fileName: u.file.name,
    size: u.file.size,
    lastModified: u.file.lastModified,
    partSize: u.partSize,
    partCount: u.partCount,
    etags: u.etags,
    saved: Date.now(),
  };
  writeSaved(all);
}
function forgetUpload(uploadId) {
  const all = loadSaved();
  delete all[uploadId];
  writeSaved(all);
}
function findSaved(projectId, file) {
  const all = loadSaved();
  for (const [uploadId, s] of Object.entries(all)) {
    if (s.projectId === projectId && s.fileName === file.name && s.size === file.size && s.lastModified === file.lastModified) return { uploadId, ...s };
  }
  return null;
}

// ── wake lock ───────────────────────────────────────────────────────────────

let wakeLock = null;
async function holdWakeLock() {
  if (wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    /* not allowed (battery saver, iframe); uploads continue while the screen is on */
  }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ── upload engine ───────────────────────────────────────────────────────────

class UploadError extends Error {
  constructor(message, { fatal = false, cors = false, retriable = true } = {}) {
    super(message);
    this.fatal = fatal;
    this.cors = cors;
    this.retriable = retriable;
  }
}

const CORS_HELP =
  "The upload was blocked before it reached storage. If the connection is fine, the storage bucket's CORS setting does not allow this site yet: see “Allow uploads from your site” in docs/HOSTED.md.";

const uploads = []; // every Upload started in this tab
let pumping = false;

class Upload {
  constructor(projectId, file, saved) {
    this.projectId = projectId;
    this.file = file;
    this.uploadId = saved?.uploadId || null;
    this.partSize = saved?.partSize || 0;
    this.partCount = saved?.partCount || 0;
    this.etags = saved?.etags || {};
    this.urls = new Map(); // partNumber → { url, at }
    this.inflight = new Map(); // partNumber → bytes sent so far
    this.xhrs = new Set();
    this.status = "queued";
    this.message = saved ? "Will resume where it stopped." : "Waiting…";
    this.error = null;
    this.anyPartOk = Object.keys(this.etags).length > 0;
    this.samples = [];
    this.record = null;
    this.cancelled = false;
    this.el = null;
    this.build();
  }

  get doneBytes() {
    let n = 0;
    for (const p of Object.keys(this.etags)) n += this.partLength(Number(p));
    for (const v of this.inflight.values()) n += v;
    return Math.min(n, this.file.size);
  }

  partLength(n) {
    const start = (n - 1) * this.partSize;
    return Math.max(0, Math.min(this.partSize, this.file.size - start));
  }

  get active() {
    return ["queued", "starting", "uploading", "completing"].includes(this.status);
  }

  async run() {
    if (this.cancelled) return;
    this.error = null;
    try {
      this.set("starting", "Starting…");
      if (!this.uploadId) await this.create();
      this.set("uploading", "Uploading…");
      await this.sendParts();
      this.set("completing", "Finishing…");
      this.record = await api("POST", `/api/projects/${this.projectId}/uploads/${this.uploadId}/complete`, {
        parts: Object.entries(this.etags).map(([n, etag]) => ({ partNumber: Number(n), etag })),
      });
      forgetUpload(this.uploadId);
      this.set("processing", "Uploaded. Unpacking and reading…");
      refreshProjectSoon();
      await this.poll();
    } catch (e) {
      if (this.cancelled) return;
      this.error = e;
      const retriable = !(e instanceof UploadError && !e.retriable) && !(e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
      this.set("error", e.message || String(e), retriable);
    } finally {
      for (const x of this.xhrs) x.abort();
      this.xhrs.clear();
      this.inflight.clear();
      this.render();
    }
  }

  async create() {
    const r = await api("POST", `/api/projects/${this.projectId}/uploads`, {
      name: this.file.name,
      size: this.file.size,
      contentType: this.file.type || "application/octet-stream",
    });
    this.uploadId = r.uploadId;
    this.partSize = r.partSize;
    this.partCount = r.partCount;
    this.etags = {};
    const at = Date.now();
    for (const p of r.parts) this.urls.set(p.partNumber, { url: p.url, at });
    saveUpload(this);
  }

  async urlFor(n) {
    const have = this.urls.get(n);
    if (have && Date.now() - have.at < URL_MAX_AGE_MS) return have.url;
    // Fetch this part plus the next missing ones in one batch.
    const want = [];
    for (let p = n; p <= this.partCount && want.length < 100; p++) {
      const u = this.urls.get(p);
      if (!this.etags[p] && !(u && Date.now() - u.at < URL_MAX_AGE_MS)) want.push(p);
    }
    if (!want.includes(n)) want.unshift(n);
    const r = await api("POST", `/api/projects/${this.projectId}/uploads/${this.uploadId}/parts`, { partNumbers: want.slice(0, 100) });
    const at = Date.now();
    for (const p of r.parts) this.urls.set(p.partNumber, { url: p.url, at });
    return this.urls.get(n).url;
  }

  async sendParts() {
    const todo = [];
    for (let n = 1; n <= this.partCount; n++) if (!this.etags[n]) todo.push(n);
    let failure = null;
    const worker = async () => {
      while (todo.length && !failure && !this.cancelled) {
        const n = todo.shift();
        try {
          await this.sendPart(n);
        } catch (e) {
          failure = failure || e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    if (this.cancelled) throw new UploadError("Cancelled.", { retriable: false });
    if (failure) throw failure;
  }

  async sendPart(n) {
    const start = (n - 1) * this.partSize;
    const blob = this.file.slice(start, start + this.partLength(n));
    let last = null;
    for (let attempt = 1; attempt <= PART_TRIES; attempt++) {
      if (this.cancelled) return;
      try {
        const url = await this.urlFor(n);
        const etag = await this.put(url, blob, n);
        this.etags[n] = etag;
        this.anyPartOk = true;
        this.inflight.delete(n);
        saveUpload(this);
        this.render();
        return;
      } catch (e) {
        this.inflight.delete(n);
        last = e;
        if (e instanceof UploadError && e.fatal) throw e;
        if (e instanceof ApiError && e.status !== 0 && e.status < 500 && e.status !== 429) throw e;
        if (e.status === 403 || e.status === 400) this.urls.delete(n); // expired or bad signature: presign again
        if (attempt < PART_TRIES) {
          this.message = navigator.onLine === false ? "Offline: waiting for a connection…" : `Part ${n}: retrying (${attempt}/${PART_TRIES - 1})…`;
          this.render();
          await sleep(Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 1000);
          if (navigator.onLine === false) await waitOnline(60000);
          this.message = "Uploading…";
        }
      }
    }
    if (last && last.status === 0 && !this.anyPartOk) throw new UploadError(navigator.onLine === false ? "You are offline." : CORS_HELP, { cors: true });
    throw new UploadError(`Part ${n} failed ${PART_TRIES} times (${last?.message || "network error"}). Tap Resume to continue from where it stopped.`);
  }

  put(url, blob, n) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhrs.add(xhr);
      xhr.open("PUT", url);
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.onprogress = (e) => {
        this.inflight.set(n, e.loaded);
        this.sample();
      };
      const finish = () => this.xhrs.delete(xhr);
      xhr.onload = () => {
        finish();
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader("ETag");
          if (!etag) {
            reject(
              new UploadError(
                "Storage accepted the data but hid its ETag, so the upload cannot be finished. The bucket's CORS setting must expose the ETag header: see “Allow uploads from your site” in docs/HOSTED.md.",
                { fatal: true, cors: true, retriable: false },
              ),
            );
          } else resolve(etag);
        } else {
          const err = new Error(`storage answered ${xhr.status}`);
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => {
        finish();
        const err = new Error("network error");
        err.status = 0;
        reject(err);
      };
      xhr.ontimeout = () => {
        finish();
        const err = new Error("timed out");
        err.status = 0;
        reject(err);
      };
      xhr.onabort = () => {
        finish();
        const err = new Error("stopped");
        err.status = 0;
        reject(err);
      };
      xhr.send(blob);
    });
  }

  sample() {
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.t < 500) return;
    this.samples.push({ t: now, b: this.doneBytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 15000) this.samples.shift();
    this.render();
  }

  get speed() {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    return b.t > a.t ? ((b.b - a.b) * 1000) / (b.t - a.t) : 0;
  }

  async poll() {
    let delay = 1500;
    for (;;) {
      await sleep(delay);
      delay = Math.min(delay * 1.3, 8000);
      let r;
      try {
        r = await api("GET", `/api/projects/${this.projectId}/uploads/${this.uploadId}`);
      } catch (e) {
        if (e.status === 0) continue;
        throw e;
      }
      this.record = r;
      if (r.status === "done") {
        const n = r.files?.length || 0;
        this.set("done", `Done: ${n} file${n === 1 ? "" : "s"}${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}.`);
        refreshProjectSoon();
        return;
      }
      if (r.status === "error") {
        this.set("failed", `Uploaded, but reading it failed: ${r.error || "unknown error"}`, false);
        refreshProjectSoon();
        return;
      }
      this.set("processing", r.status === "processing" ? "Unpacking and reading…" : "Uploaded. Waiting its turn to be read…");
    }
  }

  resume() {
    if (this.active) return;
    this.status = "queued";
    this.message = "Will resume where it stopped.";
    this.render();
    pump();
  }

  async cancel() {
    this.cancelled = true;
    for (const x of this.xhrs) x.abort();
    if (this.uploadId && ["queued", "starting", "uploading", "error"].includes(this.status)) {
      try {
        await api("POST", `/api/projects/${this.projectId}/uploads/${this.uploadId}/abort`, {});
      } catch {
        /* already gone */
      }
      forgetUpload(this.uploadId);
    }
    this.set("cancelled", "Cancelled.");
    const i = uploads.indexOf(this);
    if (i >= 0) uploads.splice(i, 1);
    this.el.remove();
    updateWakeLock();
  }

  set(status, message, retriable) {
    this.status = status;
    this.message = message;
    if (retriable !== undefined) this.retriable = retriable;
    this.render();
    updateWakeLock();
  }

  build() {
    this.$name = h("div", { class: "name" }, this.file.name);
    this.$bar = h("progress", { max: 1, value: 0 });
    this.$line = h("div", { class: "small muted" });
    this.$msg = h("div", { class: "small" });
    this.$resume = h("button", { type: "button", class: "primary", onclick: () => this.resume() }, "Resume");
    this.$cancel = h("button", { type: "button", class: "danger", onclick: () => this.cancel() }, "Cancel");
    this.el = h("div", { class: "upload" }, this.$name, this.$bar, this.$line, this.$msg, h("div", { class: "row" }, this.$resume, this.$cancel));
    this.render();
  }

  render() {
    if (!this.el) return;
    const size = this.file.size;
    const done = this.status === "processing" || this.status === "done" || this.status === "failed" ? size : this.doneBytes;
    this.$bar.value = size ? done / size : 1;
    let line = `${fmtBytes(done)} of ${fmtBytes(size)}`;
    if (this.status === "uploading") {
      const sp = this.speed;
      if (sp > 0) line += ` · ${fmtBytes(sp)}/s · ${fmtDuration((size - done) / sp)} left`;
    }
    this.$line.textContent = line;
    this.$msg.textContent = this.message || "";
    this.$msg.className = "small " + (this.status === "error" || this.status === "failed" ? "error" : this.status === "done" ? "ok" : "");
    this.$resume.hidden = !(this.status === "error" && this.retriable !== false);
    this.$cancel.hidden = !["queued", "starting", "uploading", "error"].includes(this.status);
  }
}

function waitOnline(maxMs) {
  return new Promise((resolve) => {
    const t = setTimeout(done, maxMs);
    function done() {
      clearTimeout(t);
      window.removeEventListener("online", done);
      resolve();
    }
    window.addEventListener("online", done);
  });
}

function updateWakeLock() {
  if (uploads.some((u) => u.active)) holdWakeLock();
  else releaseWakeLock();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = uploads.find((u) => u.status === "queued");
      if (!next) break;
      await next.run();
    }
  } finally {
    pumping = false;
    updateWakeLock();
  }
}

async function startUploads(projectId, files) {
  for (const file of files) {
    if (uploads.some((u) => u.projectId === projectId && u.file.name === file.name && u.file.size === file.size && u.active)) continue;
    let saved = findSaved(projectId, file);
    if (saved) {
      // Only resume if the server still has it open.
      try {
        const r = await api("GET", `/api/projects/${projectId}/uploads/${saved.uploadId}`);
        if (r.status !== "uploading") {
          forgetUpload(saved.uploadId);
          saved = null;
        }
      } catch {
        forgetUpload(saved.uploadId);
        saved = null;
      }
    }
    const u = new Upload(projectId, file, saved);
    uploads.push(u);
    if (currentProject === projectId) mountUploadRows();
  }
  updateWakeLock();
  pump();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  updateWakeLock();
  // Back from a locked screen: pick up uploads that failed while asleep.
  let resumed = false;
  for (const u of uploads) {
    if (u.status === "error" && u.retriable !== false && !(u.error instanceof UploadError && u.error.cors)) {
      u.status = "queued";
      u.message = "Resuming…";
      u.render();
      resumed = true;
    }
  }
  if (resumed) pump();
  if (currentProject) refreshProjectSoon();
});

window.addEventListener("beforeunload", (e) => {
  if (uploads.some((u) => ["starting", "uploading", "completing"].includes(u.status))) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ── screens ─────────────────────────────────────────────────────────────────

const $app = document.getElementById("app");
let currentProject = null;
let pollTimer = null;
let refreshTimer = null;
let view = null; // nodes of the project screen

function route() {
  clearTimeout(pollTimer);
  banner("");
  const m = /^#\/p\/([a-z0-9][a-z0-9-]{0,62})$/.exec(location.hash);
  if (m) showProject(m[1]);
  else showProjects();
}

async function showProjects() {
  currentProject = null;
  view = null;
  document.title = "Brink";
  const listBox = h("div", { class: "card" }, h("p", { class: "muted" }, "Loading…"));
  const formBox = newProjectForm();
  $app.replaceChildren(
    h("div", { class: "row" }, h("h1", { class: "grow" }, "Projects"), h("button", { type: "button", class: "primary", onclick: () => (formBox.hidden = !formBox.hidden) }, "New project")),
    formBox,
    listBox,
  );
  try {
    const { projects } = await api("GET", "/api/projects");
    if (!projects.length) {
      listBox.replaceChildren(h("p", { class: "muted" }, "No projects yet. Tap “New project” to start one, then upload its bid package."));
      formBox.hidden = false;
      return;
    }
    listBox.replaceChildren(
      h(
        "ul",
        { class: "list" },
        projects.map((p) =>
          h(
            "li",
            null,
            h(
              "a",
              { class: "project-link", href: `#/p/${p.id}` },
              h("strong", null, p.name, " ", p.processing ? h("span", { class: "badge warn" }, "reading") : null),
              p.notes ? h("span", { class: "small muted" }, p.notes.split("\n")[0].slice(0, 140)) : null,
              h("span", { class: "small muted" }, ` ${p.files} file${p.files === 1 ? "" : "s"}${p.outputs ? ` · ${p.outputs} from Claude` : ""} · updated ${fmtDate(p.updated)}`),
            ),
          ),
        ),
      ),
    );
  } catch (e) {
    listBox.replaceChildren(h("p", { class: "error" }, e.message));
  }
}

function newProjectForm() {
  const name = h("input", { type: "text", id: "np-name", maxLength: 200, required: true, autocomplete: "off", placeholder: "e.g. Hangar 4 low voltage" });
  const notes = h("textarea", { id: "np-notes", maxLength: 20000, placeholder: "Solicitation number, due date, owner/GC, site visit, anything to remember" });
  const err = h("p", { class: "error", hidden: true });
  const btn = h("button", { type: "submit", class: "primary" }, "Create project");
  const form = h(
    "form",
    {
      class: "card",
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.hidden = true;
        try {
          const p = await api("POST", "/api/projects", { name: name.value, notes: notes.value });
          location.hash = `#/p/${p.id}`;
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h("h2", null, "New project"),
    h("label", { htmlFor: "np-name" }, "Name"),
    name,
    h("label", { htmlFor: "np-notes" }, "Notes"),
    notes,
    err,
    h("div", { class: "row" }, btn),
  );
  return form;
}

async function showProject(id) {
  currentProject = id;
  const title = h("h1", null, "…");
  const infoBox = h("div", { class: "card" });
  const picker = h("input", {
    type: "file",
    multiple: true,
    onchange: () => {
      const files = [...picker.files];
      picker.value = "";
      if (files.length) startUploads(id, files);
    },
  });
  const uploadRows = h("div");
  const unfinishedBox = h("div");
  const historyBox = h("div");
  const filesBox = h("div");
  const bidBox = h("div");
  view = { id, title, infoBox, bidBox, uploadRows, unfinishedBox, historyBox, filesBox, notesDirty: false, manifest: null };
  $app.replaceChildren(
    h("p", null, h("a", { href: "#/" }, "‹ All projects")),
    title,
    infoBox,
    bidBox,
    h(
      "section",
      { class: "card" },
      h("h2", null, "Upload"),
      h("label", { class: "picker" }, "Choose files or a zip", picker),
      h("p", { class: "small muted" }, "Pick one or many files, or the whole bid package zip. Keep this page open while it uploads; if it stops, tap Resume (after a reload, pick the same file again to continue)."),
      unfinishedBox,
      uploadRows,
    ),
    historyBox,
    filesBox,
  );
  mountUploadRows();
  await refreshProject();
}

function mountUploadRows() {
  if (!view) return;
  view.uploadRows.replaceChildren(...uploads.filter((u) => u.projectId === view.id).map((u) => u.el));
}

function refreshProjectSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => view && refreshProject(), 300);
}

async function refreshProject() {
  if (!view) return;
  const v = view;
  clearTimeout(pollTimer);
  let m;
  try {
    m = await api("GET", `/api/projects/${v.id}`);
  } catch (e) {
    if (view !== v) return;
    if (e.status === 404) {
      $app.replaceChildren(h("p", { class: "error" }, "That project does not exist."), h("p", null, h("a", { href: "#/" }, "‹ All projects")));
      return;
    }
    banner(e.message);
    pollTimer = setTimeout(refreshProject, 10000);
    return;
  }
  if (view !== v) return;
  banner("");
  v.manifest = m;
  document.title = `${m.name} · Brink`;
  v.title.textContent = m.name;
  renderInfo(v, m);
  renderUnfinished(v, m);
  renderHistory(v, m);
  renderFiles(v, m);
  await refreshBid(v, m);
  const busy = m.uploads.some((u) => u.status === "received" || u.status === "processing");
  pollTimer = setTimeout(refreshProject, busy ? 3000 : 30000);
}

function renderInfo(v, m) {
  if (v.notesDirty) return;
  const name = h("input", { type: "text", id: "p-name", value: m.name, maxLength: 200, oninput: () => (v.notesDirty = true) });
  const notes = h("textarea", { id: "p-notes", value: m.notes, maxLength: 20000, placeholder: "Solicitation number, due date, owner/GC, site visit…", oninput: () => (v.notesDirty = true) });
  const status = h("span", { class: "small muted" });
  const save = h("button", { type: "submit", class: "primary" }, "Save");
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await api("PATCH", `/api/projects/${v.id}`, { name: name.value, notes: notes.value });
          v.notesDirty = false;
          status.textContent = "Saved.";
          refreshProjectSoon();
        } catch (ex) {
          status.textContent = ex.message;
          status.className = "small error";
        } finally {
          save.disabled = false;
        }
      },
    },
    h("label", { htmlFor: "p-name" }, "Name"),
    name,
    h("label", { htmlFor: "p-notes" }, "Notes"),
    notes,
    h("div", { class: "row" }, save, status),
  );
  v.infoBox.replaceChildren(h("details", { open: !m.files.length && !m.notes }, h("summary", null, m.notes ? m.notes.split("\n")[0].slice(0, 80) : "Notes"), form));
}

function renderUnfinished(v, m) {
  const saved = loadSaved();
  const activeIds = new Set(uploads.map((u) => u.uploadId).filter(Boolean));
  const rows = [];
  for (const p of m.pendingUploads || []) {
    if (activeIds.has(p.uploadId)) continue;
    const local = saved[p.uploadId];
    const doneParts = local ? Object.keys(local.etags || {}).length : 0;
    rows.push(
      h(
        "div",
        { class: "upload" },
        h("div", { class: "name" }, p.name),
        h(
          "div",
          { class: "small muted" },
          local
            ? `Stopped at ${doneParts} of ${p.partCount} parts (${fmtBytes(Math.min(doneParts * p.partSize, p.size))} of ${fmtBytes(p.size)}). Pick the same file above to continue.`
            : `Unfinished upload of ${fmtBytes(p.size)} started ${fmtDate(p.added)} (another device or browser).`,
        ),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              type: "button",
              class: "danger",
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  await api("POST", `/api/projects/${v.id}/uploads/${p.uploadId}/abort`, {});
                } catch {
                  /* already gone */
                }
                forgetUpload(p.uploadId);
                refreshProjectSoon();
              },
            },
            "Discard",
          ),
        ),
      ),
    );
  }
  // Local leftovers the server no longer knows about.
  const pendingIds = new Set((m.pendingUploads || []).map((p) => p.uploadId));
  for (const [uploadId, s] of Object.entries(saved)) {
    if (s.projectId === v.id && !pendingIds.has(uploadId) && !activeIds.has(uploadId)) forgetUpload(uploadId);
  }
  v.unfinishedBox.replaceChildren(...(rows.length ? [h("h3", null, "Unfinished uploads"), ...rows] : []));
}

const STATUS_TEXT = { received: "waiting to be read", processing: "reading", done: "done", error: "failed" };

function renderHistory(v, m) {
  if (!m.uploads.length) {
    v.historyBox.replaceChildren();
    return;
  }
  const items = [...m.uploads].reverse().map((u) =>
    h(
      "li",
      null,
      h(
        "div",
        null,
        h(
          "a",
          { href: `/api/projects/${v.id}/download?upload=${encodeURIComponent(u.uploadId)}` },
          u.name,
        ),
        h("div", { class: "small muted" }, `${fmtBytes(u.size)} · ${fmtDate(u.added)}${u.files?.length ? ` · ${u.files.length} file${u.files.length === 1 ? "" : "s"}` : ""}`),
        u.error ? h("div", { class: "small error" }, u.error) : null,
        u.skipped?.length
          ? h("details", { class: "small" }, h("summary", null, `${u.skipped.length} skipped`), h("ul", null, u.skipped.slice(0, 200).map((s) => h("li", null, `${s.name}: ${s.reason}`))))
          : null,
      ),
      h("span", { class: "meta" }, h("span", { class: `badge ${u.status === "done" ? "ok" : u.status === "error" ? "bad" : "warn"}` }, STATUS_TEXT[u.status] || u.status)),
    ),
  );
  v.historyBox.replaceChildren(h("section", { class: "card" }, h("h2", null, "Uploads"), h("ul", { class: "files" }, items)));
}

const TEXT_STATUS = { ok: "text", none: "no text", pending: "reading…", error: "text error" };

function renderFiles(v, m) {
  if (!m.files.length) {
    v.filesBox.replaceChildren(h("section", { class: "card" }, h("h2", null, "Files"), h("p", { class: "muted" }, "No files yet. Upload the bid package above.")));
    return;
  }
  const groups = new Map();
  for (const f of m.files) {
    if (!groups.has(f.kind)) groups.set(f.kind, []);
    groups.get(f.kind).push(f);
  }
  const sections = [];
  for (const kind of [...KIND_ORDER, ...[...groups.keys()].filter((k) => !KIND_ORDER.includes(k))]) {
    const list = groups.get(kind);
    if (!list) continue;
    list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    const pages = list.reduce((n, f) => n + (f.pages || 0), 0);
    sections.push(
      h(
        "section",
        { class: "card" },
        h("h2", null, `${KIND_LABELS[kind] || kind} `, h("span", { class: "badge" }, `${list.length} ${list.length === 1 ? "file" : "files"}${pages ? ` · ${pages} ${pages === 1 ? "page" : "pages"}` : ""}`)),
        h(
          "ul",
          { class: "files" },
          list.map((f) =>
            h(
              "li",
              null,
              h("a", { href: `/api/projects/${v.id}/download?path=${encodeURIComponent(f.path)}` }, f.path),
              h(
                "span",
                { class: "meta" },
                [fmtBytes(f.size), f.pages ? `${f.pages} p` : null].filter(Boolean).join(" · "),
                f.kind === "output" ? null : h("br"),
                // Claude's outputs are not read back, so their text status means nothing to the owner.
                f.kind === "output" ? null : h("span", { class: f.text === "error" ? "error" : f.text === "none" ? "warn" : "", title: f.textError || "" }, f.text === "none" ? "no text (scanned)" : TEXT_STATUS[f.text] || f.text),
              ),
            ),
          ),
        ),
      ),
    );
  }
  v.filesBox.replaceChildren(...sections);
}

// ── boot ────────────────────────────────────────────────────────────────────

document.getElementById("logout").addEventListener("click", async () => {
  if (uploads.some((u) => u.active) && !confirm("Uploads are still running. Sign out anyway?")) return;
  try {
    await api("POST", "/logout", {});
  } catch {
    /* signed out anyway */
  }
  location.href = "/login";
});

window.addEventListener("hashchange", route);
route();

// ── the bid: review first, then approve (only the owner can; Claude cannot) ──

const money = (n) => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const REVIEW_FIRST = new Set(["long_link", "over_295", "floor_crossing"]);

async function refreshBid(v, m) {
  let bid = null;
  try {
    bid = await api("GET", `/api/projects/${v.id}/bid`);
  } catch (e) {
    if (e.status !== 404) {
      v.bidBox.replaceChildren(h("section", { class: "card" }, h("h2", null, "Bid"), h("p", { class: "error" }, e.message)));
      return;
    }
  }
  if (view !== v) return;
  renderBid(v, m, bid);
}

function renderBid(v, m, bid) {
  if (!bid) {
    v.bidBox.replaceChildren(h("section", { class: "card" }, h("h2", null, "Bid"), h("p", { class: "muted" }, "No bid yet. Ask Claude to take off and price this project.")));
    return;
  }
  const approved = bid.status === "approved" && bid.approved && bid.approved.revision === bid.revision;
  const t = bid.totals || {};
  const review = (bid.flags || []).filter((f) => REVIEW_FIRST.has(f.kind));
  const other = (bid.flags || []).filter((f) => !REVIEW_FIRST.has(f.kind));
  const gaps = bid.gaps || [];
  const docs = m.files.filter((f) => f.kind === "output" && /^(outputs\/)?bid\//.test(f.path) && !/\.json$/.test(f.path));
  const msg = h("p", { class: "small", role: "status" });

  const list = (items, cls) =>
    h("ul", { class: `flags ${cls}` }, ...items.map((f) => h("li", null, f.message || f.description || String(f))));

  const approveBtn = h(
    "button",
    {
      type: "button",
      class: "primary",
      disabled: approved || t.baseBid == null || gaps.length > 0,
      onclick: async () => {
        if (!confirm(`Approve revision ${bid.revision} at ${money(t.baseBid)}?\n\nThe documents are re-made without DRAFT. If Claude re-prices later, that is a new draft for you to approve again.`)) return;
        approveBtn.disabled = true;
        msg.textContent = "Approving…";
        try {
          const r = await api("POST", `/api/projects/${v.id}/bid/approve`, { revision: bid.revision });
          msg.textContent = r.warning || `Approved revision ${bid.revision}.${r.rerendered && r.rerendered.length ? " Final documents are ready below." : ""}`;
          refreshProjectSoon();
        } catch (e) {
          msg.textContent = e.message;
          approveBtn.disabled = false;
        }
      },
    },
    approved ? "Approved" : "Approve this bid",
  );
  const withdraw = approved
    ? h(
        "button",
        {
          type: "button",
          class: "link",
          onclick: async () => {
            if (!confirm(`Withdraw your approval of revision ${bid.revision}? The bid goes back to draft.`)) return;
            try {
              await api("POST", `/api/projects/${v.id}/bid/withdraw`, { revision: bid.revision });
              refreshProjectSoon();
            } catch (e) {
              msg.textContent = e.message;
            }
          },
        },
        "Withdraw approval",
      )
    : null;
  const why = approved
    ? null
    : t.baseBid == null || gaps.length
      ? h("p", { class: "small warn" }, `Can't approve yet: ${gaps.length} unpriced item${gaps.length === 1 ? "" : "s"}${t.baseBid == null ? " and no base bid" : ""}. Ask Claude to fill the gaps and re-price.`)
      : null;

  v.bidBox.replaceChildren(
    h(
      "section",
      { class: "card bid" },
      h("h2", null, "Bid ", h("span", { class: `badge ${approved ? "ok" : "draft"}` }, approved ? `Approved · r${bid.revision}` : `Draft · r${bid.revision}`)),
      h("p", { class: "price" }, money(t.baseBid)),
      t.bond ? h("p", { class: "small muted" }, `Bond ${money(t.bond)} · with bond ${money(t.totalWithBond)}`) : null,
      approved ? h("p", { class: "small muted" }, `Approved ${fmtDate(bid.approved.at)}`) : null,
      review.length
        ? h("div", null, h("h3", null, `Check these first (${review.length})`), list(review, "review"))
        : h("p", { class: "small muted" }, "No links over 250 ft and no floor crossings."),
      gaps.length ? h("div", null, h("h3", null, `Unpriced (${gaps.length})`), list(gaps.map((g) => ({ message: `${g.description}: ${g.reason}` })), "gaps")) : null,
      h(
        "dl",
        { class: "stats" },
        h("dt", null, "Labor hours"), h("dd", null, String(t.laborHours ?? "—")),
        h("dt", null, "Links"), h("dd", null, String(bid.ratios?.links ?? "—")),
        h("dt", null, "$ per link"), h("dd", null, money(bid.ratios?.dollarsPerLink)),
        h("dt", null, "Hours per link"), h("dd", null, String(bid.ratios?.hoursPerLink ?? "—")),
        h("dt", null, "Sell rate / hr"), h("dd", null, money(t.effectiveSellRate)),
      ),
      other.length ? h("details", null, h("summary", null, `Other notes (${other.length})`), list(other, "other")) : null,
      docs.length
        ? h("div", null, h("h3", null, "Documents"), h("ul", { class: "files" }, ...docs.map((f) => h("li", null, h("a", { href: `/api/projects/${v.id}/download?path=${encodeURIComponent(f.path)}` }, f.path.replace(/^(outputs\/)?bid\//, ""))))))
        : h("p", { class: "small muted" }, "No bid documents yet. Ask Claude to export the workbook and proposal."),
      why,
      h("div", { class: "row" }, approveBtn, withdraw),
      msg,
    ),
  );
}
