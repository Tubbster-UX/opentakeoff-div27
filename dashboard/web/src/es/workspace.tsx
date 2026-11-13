// The Schematic workspace: EasySchematic's editor mounted directly in the app
// (same React tree, same Tailwind build, same document: no frame).
//
// What runs here:
//   - upstream App (vendor/easyschematic/src/App.tsx), inside ReactFlowProvider and
//     its ErrorBoundary. Its MenuBar, side panels, toasts and theme hook are Brink
//     modules (vite.config.ts overrides; vendor/PATCHES.md lists them), so its layout
//     shows the Brink schematic toolbar, the Brink library / inspector panels and
//     the app's own toasts and theme;
//   - the edit-layer sync (sync.ts), exactly as in Phase 2: load, baseline, debounced
//     saves under the Access identity, live patches from other tabs, echo suppression;
//   - the header's save status, and the status bar (notices, unsaved changes).
//
// Keyboard: EasySchematic's shortcuts are window listeners; they stay as upstream
// wrote them. Plain keys typed in Brink chrome (header, toolbar, menus, Brink panels:
// [data-bk-chrome]) are stopped before they reach those listeners, so Space,
// Delete, Backspace, Escape or letters there never act on the canvas. Modifier
// shortcuts (Ctrl/Cmd+Z, S, C, V, A) keep working everywhere in the tab.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import App from "../../../vendor/easyschematic/src/App.tsx";
import ErrorBoundary from "../../../vendor/easyschematic/src/components/ErrorBoundary.tsx";
import { useSchematicStore } from "../../../vendor/easyschematic/src/store";
import type { RowChange } from "../../../src/shared/protocol.js";
import { Button, Icon, Status, type Tone } from "../design/index.js";
import { setChrome } from "../lib/chrome.js";
import type { EditorMessage, SaveState } from "../lib/esBridge.js";
import { loadMe } from "../lib/me.js";
import { setEditor } from "./identity";
import { addNotice, dismissNotice, setSession, useSession } from "./session";
import { resetEditorDocument } from "./storage";
import { EditorSync } from "./sync";

export interface SchematicWorkspaceProps {
  projectId: string;
  importId: string | null;
  projectName: string;
  /** Relayed rows of brink_schematic_edits (the project store's socket). */
  subscribeEdits: (cb: (c: RowChange) => void) => () => void;
  /** The read-only outline of the generated rows, shown in the Rows panel. */
  outline: ReactNode;
}

const STATE_TEXT: Record<SaveState, string> = {
  loading: "Loading…",
  saving: "Saving…",
  saved: "All changes saved",
  pending: "Unsaved changes",
  error: "Not saved",
  suspended: "Not saving",
};
const STATE_TONE: Record<SaveState, Tone> = { loading: "neutral", saving: "warn", saved: "ok", pending: "warn", error: "danger", suspended: "danger" };

/** Save state in the app header. */
function SaveStatus() {
  const { status } = useSession();
  const st = status?.state ?? "loading";
  return (
    <span data-save-state={st} title={status?.message ?? (status?.savedAt ? `Last saved ${new Date(status.savedAt).toLocaleTimeString()}` : undefined)} className="px-1.5">
      <Status tone={STATE_TONE[st]} pulse={st === "saving" || st === "loading"}>
        {STATE_TEXT[st]}
        {st === "pending" && status ? ` (${status.pending})` : ""}
      </Status>
    </span>
  );
}

/** The bar under the canvas: who is editing, last save, what will not be saved, notices. */
function StatusBar() {
  const { status, notices, sync } = useSession();
  const st = status?.state ?? "loading";
  const unsupported = status?.unsupported ?? [];
  return (
    <section data-bk-chrome data-print-hide aria-label="Schematic editor status" className="shrink-0 border-t border-line bg-panel text-xs">
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1">
        <span className="sm:hidden" data-save-state-mobile={st}>
          <Status tone={STATE_TONE[st]}>{STATE_TEXT[st]}</Status>
        </span>
        <span className="text-ink-3" data-editor={status?.editor ?? ""}>
          {status?.editor ? (
            <>
              Editing as <span className="text-ink-2">{status.editor}</span>
            </>
          ) : status ? (
            "No editor identity: changes cannot be saved"
          ) : (
            ""
          )}
        </span>
        {status?.savedAt && <span className="num text-ink-3">last saved {new Date(status.savedAt).toLocaleTimeString()}</span>}
        <span className="hidden text-ink-3 md:inline">Saved here: moves, renames, room changes and connections. Device counts and cable lengths come from the takeoff.</span>
        {(st === "suspended" || st === "error" || unsupported.length > 0) && (
          <Button size="sm" icon="refresh" className="ml-auto" onClick={() => void sync?.load("Reloaded the saved schematic.")} data-action="reload-schematic">
            Discard unsaved and reload
          </Button>
        )}
      </div>
      {status?.message && (
        <p role="alert" className="m-0 border-t border-line bg-danger-soft px-3 py-1.5 text-danger">
          {status.message}
        </p>
      )}
      {unsupported.length > 0 && (
        <details className="border-t border-line px-3 py-1.5" data-unsupported={unsupported.length}>
          <summary className="cursor-pointer font-medium text-warn">
            {unsupported.length} change{unsupported.length === 1 ? "" : "s"} in the editor will not be saved
          </summary>
          <ul className="m-0 mt-1 pl-4 text-ink-2">
            {unsupported.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </details>
      )}
      {notices.length > 0 && (
        <ul className="m-0 max-h-24 list-none overflow-y-auto border-t border-line p-0" aria-live="polite">
          {notices.map((n) => (
            <li key={n.id} data-notice={n.tone} className={`flex items-start gap-2 px-3 py-1 ${n.tone === "warn" ? "text-warn" : n.tone === "error" ? "text-danger" : "text-ink-2"}`}>
              <Icon name={n.tone === "info" ? "info" : n.tone === "warn" ? "warn" : "error"} size={14} className="mt-0.5 shrink-0" />
              <span className="flex-1 [overflow-wrap:anywhere]">{n.text}</span>
              <button type="button" className="bk-focus cursor-pointer rounded-ctl text-ink-3 hover:text-ink" aria-label="Dismiss" onClick={() => dismissNotice(n.id)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Plain keys typed in Brink chrome never reach EasySchematic's window shortcuts. */
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

export function SchematicWorkspace({ projectId, importId, projectName, subscribeEdits, outline }: SchematicWorkspaceProps) {
  const syncRef = useRef<EditorSync | null>(null);
  // Before upstream App first renders (and hydrates from its autosave key): start from an empty
  // document, so a previously opened project never flashes in. The workspace is keyed by project.
  useState(() => resetEditorDocument());
  useChromeKeyGuard();

  // One sync per mounted workspace (the tab is keyed by project). Created in an effect, after
  // upstream App's own mount effects (its localStorage hydrate) have run: a parent's effects run
  // after its children's, so the project's load always lands last.
  useEffect(() => {
    const sync = new EditorSync(projectId, null, (m: EditorMessage) => {
      if (m.type === "es:status") setSession({ status: m });
      else addNotice(m.tone, m.text);
    });
    syncRef.current = sync;
    setSession({ sync, status: null, notices: [] });
    setChrome({ status: <SaveStatus /> });
    // Who is editing: the Cloudflare Access identity (or the local dev identity). Without one the editor opens, but saves are refused.
    void loadMe().then((me) => {
      const editor = me?.email ? { email: me.email, auth: me.auth } : null;
      setEditor(editor);
      sync.setEditor(editor?.email ?? null);
      void sync.load();
    });
    return () => {
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
      setSession({ sync: null, status: null, notices: [] });
      setChrome({ status: null });
    };
  }, [projectId]);

  useEffect(() => {
    setSession({ outline });
  }, [outline]);

  // Relayed edit-layer rows -> sync.
  useEffect(() => subscribeEdits((change) => void (change.table === "brink_schematic_edits" && syncRef.current?.onEditChange(change))), [subscribeEdits]);

  // A re-import (or re-merge) moved current_import_id: reload.
  const lastImport = useRef(importId);
  useEffect(() => {
    if (lastImport.current === importId) return;
    lastImport.current = importId;
    syncRef.current?.onImportChanged(importId);
  }, [importId]);

  // The browser tab's title stays the app's. Upstream App sets "<name> — EasySchematic" in an effect;
  // this parent effect runs after it in the same commit, and again on every rename.
  const schematicName = useSchematicStore((s) => s.schematicName);
  useEffect(() => {
    document.title = `${projectName} · Schematic · Brink Design`;
  }, [projectName, schematicName]);

  return (
    <div className="bk-es flex min-h-0 flex-1 flex-col bg-[var(--bk-paper)]" data-es-root data-project={projectId}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ErrorBoundary>
          <ReactFlowProvider>
            <App />
          </ReactFlowProvider>
        </ErrorBoundary>
      </div>
      <StatusBar />
    </div>
  );
}

export default SchematicWorkspace;
