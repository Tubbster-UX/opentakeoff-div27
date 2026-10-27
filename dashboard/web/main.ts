// Brink dashboard page: read-only, live. Reads a snapshot over /api, then
// applies row changes relayed by the Worker's Durable Object. Holds no keys.
import { rowKey, type ClientMessage, type Row, type RowChange, type ServerMessage, type Snapshot, type TableName, type UpstreamStatus } from "../src/shared/protocol.js";
import { applyChange, summarize } from "../src/shared/state.js";

const app = document.getElementById("app")!;
const liveEl = document.getElementById("live")!;
const liveText = document.getElementById("live-text")!;

type Child = Node | string | number | null | undefined | false;
function el(tag: string, attrs: Record<string, string | undefined> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

const fmt = (v: unknown, digits = 2): string => (v == null || v === "" ? "" : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }));
const short = (id: unknown): string => (typeof id === "string" ? id.slice(0, 8) : "");
const when = (v: unknown): string => {
  if (!v) return "";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};

function setLive(state: UpstreamStatus | "offline", detail?: string): void {
  liveEl.dataset.state = state;
  liveText.textContent = { live: "Live", connecting: "Connecting", down: "Realtime down", unconfigured: "Realtime not configured", offline: "Offline" }[state];
  liveEl.title = detail ?? "";
}

// ---------- project list ----------

async function showProjects(): Promise<void> {
  document.title = "Brink Dashboard";
  setLive("offline");
  const res = await fetch("/api/projects");
  if (!res.ok) return void app.replaceChildren(el("p", { class: "notice error" }, `Could not read projects (${res.status}).`));
  const rows = ((await res.json()) as { projects: Row[] }).projects;
  app.replaceChildren(
    el("h1", {}, "Projects"),
    el(
      "section",
      { class: "panel projects" },
      el("div", { class: "scroll" },
        el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, "Project"), el("th", {}, "Current import"), el("th", {}, "Imported"), el("th", { class: "num" }, "Errors"), el("th", { class: "num" }, "Warnings"))),
          el("tbody", {}, ...(rows.length
            ? rows.map((p) => el("tr", {}, el("td", {}, el("a", { href: `/p/${p.id}` }, String(p.name))), el("td", { class: "code" }, short(p.current_import_id)), el("td", {}, when(p.imported_at)), el("td", { class: "num" }, fmt(p.errors)), el("td", { class: "num" }, fmt(p.warnings))))
            : [el("tr", {}, el("td", { class: "empty", colspan: "5" }, "No projects yet. Import one with brink-merge --db."))])),
        ),
      ),
    ),
  );
}

// ---------- one project, live ----------

interface FeedItem { at: string; text: string }

class ProjectView {
  private snap: Snapshot | null = null;
  private loading = false;
  private resyncAgain = false;
  private buffer: RowChange[] = [];
  private ws: WebSocket | null = null;
  private retry = 0;
  private feed: FeedItem[] = [];
  private flashKeys = new Set<string>();
  private renderQueued = false;
  private pingTimer: number | undefined;

  constructor(private readonly projectId: string) {}

  start(): void {
    void this.resync();
    this.connect();
  }

  private connect(): void {
    setLive("offline");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/projects/${this.projectId}/live`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.sendWatch();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage | { type: "pong" };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "status") {
        setLive(msg.upstream, msg.detail);
        // Changes made before the relay's subscription was live were not delivered: read again.
        if (msg.upstream === "live") void this.resync();
      } else if (msg.type === "change") {
        this.onChange(msg.change);
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      setLive("offline");
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private sendWatch(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg: ClientMessage = { type: "watch", importId: (this.snap?.import?.id as string | undefined) ?? null };
    this.ws.send(JSON.stringify(msg));
  }

  private async resync(): Promise<void> {
    if (this.loading) {
      this.resyncAgain = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.resyncAgain = false;
        const res = await fetch(`/api/projects/${this.projectId}`, { cache: "no-store" });
        if (res.status === 404) {
          this.snap = null;
          app.replaceChildren(el("p", { class: "notice error" }, "No such project."));
          return;
        }
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const prevImport = this.snap?.import?.id;
        this.snap = (await res.json()) as Snapshot;
        if (prevImport && prevImport !== this.snap.import?.id) this.log(`switched to import ${short(this.snap.import?.id)} (current_import_id changed)`);
        this.sendWatch();
        // Replay what arrived while reading (upserts by primary key, in order: idempotent).
        const pending = this.buffer;
        this.buffer = [];
        for (const c of pending) this.applyOne(c, false);
      } while (this.resyncAgain);
    } catch (e) {
      app.replaceChildren(el("p", { class: "notice error" }, `Could not read the project: ${(e as Error).message}. Retrying…`));
      setTimeout(() => void this.resync(), 3000);
    } finally {
      this.loading = false;
      this.queueRender();
    }
  }

  private onChange(c: RowChange): void {
    if (this.loading || !this.snap) {
      this.buffer.push(c);
      return;
    }
    this.applyOne(c, true);
    this.queueRender();
  }

  private applyOne(c: RowChange, flash: boolean): void {
    if (!this.snap) return;
    const r = applyChange(this.snap, c);
    if (r.kind === "applied") {
      this.snap = r.snapshot;
      if (r.key && flash) this.flashKeys.add(`${c.table}:${r.key}`);
      this.log(`${c.type.toLowerCase()} ${c.table.replace("brink_", "")} ${r.key ?? ""}`);
    } else if (r.kind === "resync") {
      this.log(`${r.reason}: reloading`);
      if (this.loading) this.resyncAgain = true;
      else void this.resync();
    }
  }

  private log(text: string): void {
    this.feed.unshift({ at: new Date().toLocaleTimeString(), text });
    this.feed.length = Math.min(this.feed.length, 12);
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const s = this.snap;
    if (!s) return;
    document.title = `${String(s.project.name)} · Brink Dashboard`;
    const sum = summarize(s);
    const nodeLabel = new Map(s.nodes.map((n) => [n.node_id, String(n.label ?? n.node_id)]));
    const roomOf = (n: Row): string => (n.parent_id ? nodeLabel.get(n.parent_id) ?? String(n.parent_id) : "");
    const bom = s.bom.filter((l) => l.kind !== "issue");
    const devices = s.nodes.filter((n) => n.node_type === "device");
    const rooms = s.nodes.filter((n) => n.node_type === "room");
    const lfByRoom = new Map<string, number>();
    const devRoom = new Map(devices.map((d) => [d.node_id, d.parent_id]));
    for (const c of s.connections) {
      const room = devRoom.get(c.source_node);
      if (room) lfByRoom.set(String(room), (lfByRoom.get(String(room)) ?? 0) + (Number(c.cable_length_ft) || 0));
    }

    const row = (table: TableName, r: Row, ...cells: HTMLElement[]): HTMLElement => {
      const k = `${table}:${rowKey(table, r)}`;
      return el("tr", { "data-k": k, class: this.flashKeys.has(k) ? "flash" : undefined }, ...cells);
    };
    const td = (v: Child, cls?: string) => el("td", { class: cls }, v);
    const tag = (v: unknown) => (v ? el("span", { class: `tag ${String(v)}` }, String(v)) : "");
    const panel = (title: string, count: number, head: string[], numeric: Set<number>, body: HTMLElement[], empty: string) =>
      el("section", { class: "panel" },
        el("header", {}, el("h2", {}, title), el("span", { class: "count" }, String(count))),
        el("div", { class: "scroll" },
          el("table", {},
            el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", { class: numeric.has(i) ? "num" : undefined }, h)))),
            el("tbody", {}, ...(body.length ? body : [el("tr", {}, el("td", { class: "empty", colspan: String(head.length) }, empty))])),
          ),
        ),
      );
    const stat = (k: string, v: string, cls?: string) => el("div", { class: `stat ${cls ?? ""}` }, el("div", { class: "k" }, k), el("div", { class: "v" }, v));

    app.replaceChildren(
      el("h1", {}, String(s.project.name)),
      el("div", { class: "meta" },
        s.import
          ? `import ${String(s.import.id)} · imported ${when(s.import.imported_at)} · ${String(s.import.ot_schema ?? "")} · EasySchematic v${String(s.import.es_schema_version ?? "")}`
          : "no current import",
      ),
      el("div", { class: "stats" },
        stat("BOM lines", fmt(sum.bomLines)),
        stat("Devices", fmt(sum.devices)),
        stat("Rooms", fmt(sum.rooms)),
        stat("Connections", fmt(sum.connections)),
        stat("Cable LF (per-cable sum)", fmt(sum.cableLf)),
        stat("Errors", fmt(sum.errors), sum.errors ? "error" : undefined),
        stat("Warnings", fmt(sum.warnings), sum.warnings ? "warn" : undefined),
      ),
      panel("Bill of materials", bom.length, ["#", "Kind", "Condition", "Description", "Qty", "Unit", "Net LF", "Order LF", "Mapping"], new Set([0, 4, 6, 7]),
        bom.map((l) => row("brink_bom_lines", l, td(l.line_no as number, "num"), td(String(l.kind), "code"), td(String(l.condition_key), "code"), td(String(l.description), "desc"), td(fmt(l.qty), "num"), td(String(l.unit ?? "")), td(fmt(l.net_lf), "num"), td(fmt(l.order_lf), "num"), td(tag(l.mapping_status)))),
        "No BOM lines."),
      panel("Issues", s.issues.length, ["#", "Severity", "Code", "Condition", "Message"], new Set([0]),
        s.issues.map((i) => row("brink_issues", i, td(i.seq as number, "num"), td(tag(i.severity)), td(String(i.code), "code"), td(String(i.condition_key ?? ""), "code"), td(String(i.message), "desc"))),
        "No issues."),
      el("div", { class: "grid2" },
        panel("Rooms", rooms.length, ["Room", "Devices", "Cable LF"], new Set([1, 2]),
          rooms.map((r) => row("brink_schematic_nodes", r, td(String(r.label ?? r.node_id)), td(fmt(devices.filter((d) => d.parent_id === r.node_id).length), "num"), td(fmt(lfByRoom.get(String(r.node_id)) ?? 0), "num"))),
          "No rooms."),
        panel("Devices", devices.length, ["Label", "Type", "Condition", "Room"], new Set(),
          devices.map((d) => row("brink_schematic_nodes", d, td(String(d.label ?? d.node_id)), td(String(d.device_type ?? ""), "code"), td(String(d.condition_key ?? ""), "code"), td(roomOf(d)))),
          "No devices."),
      ),
      panel("Connections", s.connections.length, ["#", "From", "To", "Signal", "Cable", "Length ft", "Run"], new Set([0, 5]),
        s.connections.map((c) => row("brink_schematic_connections", c, td(c.seq as number, "num"), td(nodeLabel.get(c.source_node) ?? String(c.source_node)), td(nodeLabel.get(c.target_node) ?? String(c.target_node)), td(String(c.signal_type ?? ""), "code"), td(String(c.cable_type ?? "")), td(fmt(c.cable_length_ft), "num"), td(short(String(c.run_id ?? "").replace(/^run-/, "")), "code"))),
        "No connections."),
      el("section", { class: "panel" },
        el("header", {}, el("h2", {}, "Live changes"), el("span", { class: "count" }, `read ${when(s.readAt)}`)),
        el("ul", { class: "feed", id: "feed" }, ...(this.feed.length ? this.feed.map((f) => el("li", {}, el("b", {}, f.at), " ", f.text)) : [el("li", {}, "Waiting for changes…")])),
      ),
    );
    this.flashKeys.clear();
  }
}

// ---------- routing ----------

const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i);
if (m) new ProjectView(m[1]!).start();
else void showProjects();
