// The Takeoff workspace: OpenTakeoff's plan canvas mounted directly in the app (same
// React tree, same document: no frame), framed by Brink chrome.
//
// What runs here:
//   - upstream's TakeoffCanvas (vendor/opentakeoff/src/pages/TakeoffCanvas.jsx), with
//     its storage seam pointed at the Brink store (store.ts, through upstream's own
//     setActiveStore) and a few modules swapped at build time (vite.config.ts; the list
//     and the reasons are in vendor/PATCHES.md). Its one source patch hands this page
//     its state and verbs every render (host.ts);
//   - the Brink chrome: a toolbar for the tools (brink/TakeoffToolbar.tsx), the sheets
//     panel on the left, conditions / inspector / edits on the right, and a status bar
//     (scale, zoom, selection, save state). Upstream's own rows are collapsed by its
//     focus mode (pinned on) and the rest hidden by design/ot-theme.css;
//   - the header: save status and the Project menu (marked PDF, DXF, reports, print,
//     the takeoff JSON), through lib/chrome.ts.
//
// Keyboard: upstream's single-letter shortcuts are window listeners and stay as upstream
// wrote them. Plain keys typed in Brink chrome ([data-bk-chrome]) are stopped before they
// reach those listeners, so typing in a menu or the condition picker never arms a tool.
import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import TakeoffCanvas from "../../../vendor/opentakeoff/src/pages/TakeoffCanvas.jsx";
import { GoogleAuthProvider } from "../../../vendor/opentakeoff/src/lib/google/AuthContext.jsx";
import { localStore, setActiveStore } from "../../../vendor/opentakeoff/src/lib/store.js";
import { setAuthorName } from "../../../vendor/opentakeoff/src/lib/provenance.js";
import type { RowChange } from "../../../src/shared/protocol.js";
import { Button, Icon, Status } from "../design/index.js";
import { setChrome, useChromeSlot } from "../lib/chrome.js";
import { loadMe } from "../lib/me.js";
import { takeoffApi } from "./api";
import { RightPanel } from "./brink/RightPanel";
import { SheetsPanel } from "./brink/SheetsPanel";
import { StatusBar } from "./brink/StatusBar";
import { TakeoffToolbar } from "./brink/TakeoffToolbar";
import { projectMenu } from "./brink/projectMenu";
import { getHost, useHost } from "./host";
import { addNotice, setSession, STATE_TEXT, STATE_TONE, useSession } from "./session";
import { createBrinkTakeoffStore, type LocalLibraries } from "./store";

export interface TakeoffWorkspaceProps {
  projectId: string;
  importId: string | null;
  projectName: string;
  subscribeChanges: (cb: (c: RowChange) => void) => () => void;
}



/** Save state in the app header. */
function SaveStatus() {
  const { status } = useSession();
  const st = status?.state ?? "loading";
  return (
    <span data-save-state={st} data-takeoff-save={st} title={status?.message ?? (status?.savedAt ? `Last saved ${new Date(status.savedAt).toLocaleTimeString()}` : undefined)} className="px-1.5">
      <Status tone={STATE_TONE[st]} pulse={st === "saving" || st === "loading"}>
        {STATE_TEXT[st]}
      </Status>
    </span>
  );
}

/** Plain keys typed in Brink chrome never reach the canvas's window shortcuts. */
function useChromeKeyGuard(): void {
  useEffect(() => {
    const guard = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const t = e.target as Element | null;
      if (t?.closest?.("[data-bk-chrome]")) e.stopPropagation();
    };
    document.addEventListener("keydown", guard);
    document.addEventListener("keyup", guard);
    return () => {
      document.removeEventListener("keydown", guard);
      document.removeEventListener("keyup", guard);
    };
  }, []);
}

const newClientRef = (): string => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `ot-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
};

async function countPages(bytes: ArrayBuffer): Promise<number | null> {
  try {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return n;
  } catch {
    return null;
  }
}

/** Over the canvas while the project has no plan file: what to do, in the app's voice. */
function EmptyPlans() {
  const has = useHost((h) => ({ sheets: h.sheets.length, status: h.status, shapes: h.shapes.length }), { sheets: -1, status: "loading", shapes: 0 });
  const { status } = useSession();
  if (has.sheets !== 0 || has.status === "loading") return null;
  const ids = [...new Set((getHost()?.shapes ?? []).map((s) => s.sheet_id.split("#")[0]!))];
  return (
    <div data-bk-chrome data-takeoff-empty className="absolute inset-0 z-[45] flex items-center justify-center bg-[var(--bk-surface-2)] p-6">
      <div className="max-w-md rounded-panel border border-line bg-panel p-6 text-center shadow-sm">
        <Icon name="plan" size={32} className="mx-auto text-ink-3" />
        <h2 className="mt-3 mb-1 text-lg font-bold">No plan uploaded yet</h2>
        <p className="m-0 text-sm text-ink-2">
          Upload the plan PDF and we draw this project&apos;s takeoff over it.
          {has.shapes > 0 && ids.length > 0 && (
            <>
              {" "}
              The takeoff has <span className="num">{has.shapes}</span> measurements on <span className="font-num">{ids.join(", ")}</span>; upload a file with that name to see them.
            </>
          )}
        </p>
        <Button variant="primary" icon="upload" className="mt-4" disabled={!status?.editor} onClick={() => getHost()?.fileInputRef.current?.click()} data-action="upload-plan">
          Upload plan PDF
        </Button>
        {!status?.editor && <p className="mt-2 mb-0 text-xs text-ink-3">Uploading needs your Cloudflare Access sign-in.</p>}
      </div>
    </div>
  );
}

/** Upstream lands on its plan gallery when a project has no open tab: the Brink sheets panel is the gallery, so open the first sheet. */
function useOpenFirstSheet(): void {
  const s = useHost((h) => ({ view: h.view, n: h.sheets.length, tabs: h.openTabs.length, status: h.status }), { view: "", n: 0, tabs: 0, status: "" });
  const done = useRef(false);
  useEffect(() => {
    const h = getHost();
    if (!h || done.current || !s.n) return;
    if (s.view === "gallery" || s.view === "picker") {
      done.current = true;
      const key = h.openTabs[0] ?? h.sheets[0]!.name;
      h.openSheets([key], false);
    } else if (s.view === "canvas" && s.tabs) done.current = true;
  }, [s]);
  // With no plan file yet, the Brink empty state stands in for upstream's gallery landing.
  useEffect(() => {
    const h = getHost();
    if (h && !s.n && s.status !== "loading" && (s.view === "gallery" || s.view === "picker")) h.setView("canvas");
  }, [s]);
}

export function TakeoffWorkspace({ projectId, importId, projectName, subscribeChanges }: TakeoffWorkspaceProps) {
  const session = useSession();
  const clientRef = useMemo(newClientRef, [projectId]);
  const store = useMemo(
    () =>
      createBrinkTakeoffStore({
        projectId,
        api: takeoffApi(projectId),
        local: localStore as unknown as LocalLibraries,
        clientRef,
        projectName,
        countPages,
        onStatus: (status) => setSession({ status }),
        onNotice: (tone, text) => addNotice(tone, text),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, clientRef],
  );
  const [ready, setReady] = useState(false);
  useChromeKeyGuard();

  // Point upstream's storage seam at this project's store before the canvas mounts (its mount effects read it).
  useEffect(() => {
    setActiveStore(store);
    setSession({ store, status: store.getStatus(), notices: [], projectId, projectName });
    setChrome({ status: <SaveStatus /> });
    setReady(true);
    let live = true;
    void loadMe().then((me) => {
      if (!live) return;
      const email = me?.email ?? null;
      store.setEditor(email);
      // Upstream stamps `author` / `updated_by` on shapes from a declared name: the Access identity.
      if (email) setAuthorName(email);
    });
    return () => {
      live = false;
      setReady(false);
      store.dispose();
      setActiveStore();
      setSession({ store: null, status: null, notices: [] });
      setChrome({ status: null });
    };
  }, [store, projectId, projectName]);

  // Relayed rows: other tabs' takeoff edits and plan uploads.
  useEffect(
    () =>
      subscribeChanges((c) => {
        if (c.table === "brink_takeoff_edits") store.onEditRow(c.type, c.record);
        else if (c.table === "brink_sheets") void store.onSheetRow(c.record).then((changed) => changed && void getHost()?.refreshSheets());
      }),
    [subscribeChanges, store],
  );

  // A re-import (another tab's save, or brink-merge) moved current_import_id.
  const lastImport = useRef(importId);
  useEffect(() => {
    if (lastImport.current === importId) return;
    lastImport.current = importId;
    store.onImportChanged(importId);
  }, [importId, store]);

  useEffect(() => {
    document.title = `${projectName} · Takeoff · Brink Design`;
  });

  const menu = useMemo(() => projectMenu(), []);
  useChromeSlot("menu", menu);
  useOpenFirstSheet();

  return (
    <div className="bk-ot flex min-h-0 flex-1 flex-col bg-[var(--bk-canvas)]" data-ot-root data-project={projectId}>
      <TakeoffToolbar />
      <div className="flex min-h-0 flex-1">
        {/* At phone width the side panels are left out (the canvas needs the width); the toolbar scrolls. */}
        {session.sheets && (
          <div className="hidden min-h-0 md:flex">
            <SheetsPanel />
          </div>
        )}
        <div className="bk-ot-stage relative flex min-h-0 min-w-0 flex-1 flex-col" data-ot-stage>
          {ready && (
            <GoogleAuthProvider>
              <TakeoffCanvas key={projectId} />
            </GoogleAuthProvider>
          )}
          <EmptyPlans />
        </div>
        {session.right && (
          <div className="hidden min-h-0 md:flex">
            <RightPanel />
          </div>
        )}
      </div>
      <StatusBar />
    </div>
  );
}

export default TakeoffWorkspace;
