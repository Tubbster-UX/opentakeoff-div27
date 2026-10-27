// Mount upstream EasySchematic (vendor/easyschematic, unmodified) in the
// frame, load the project's schematic into its store with importFromJSON,
// and connect the store to the edit layer (sync.ts) and to the page around
// the frame (esBridge.ts).
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "../../../vendor/easyschematic/src/index.css";
import App from "../../../vendor/easyschematic/src/App.tsx";
import ErrorBoundary from "../../../vendor/easyschematic/src/components/ErrorBoundary.tsx";
import type { Me } from "../../../src/shared/protocol.js";
import type { FrameMessage, PageMessage } from "../lib/esBridge.js";
import { setEditor } from "./identity";
import { EditorSync } from "./sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toPage(m: FrameMessage): void {
  if (window.parent !== window) window.parent.postMessage(m, location.origin);
}

/** Runs once EasySchematic's own mount effects (its localStorage hydrate) have run: it is rendered after <App />. */
function AfterApp({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    onReady();
  }, [onReady]);
  return null;
}

export async function start(): Promise<void> {
  const projectId = new URLSearchParams(location.search).get("project") ?? "";
  if (!UUID.test(projectId)) {
    document.body.textContent = "No project.";
    return;
  }

  // Who is editing: the Cloudflare Access identity (or the local dev identity). Without one the editor still opens, but saves are refused.
  let me: Me | null = null;
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (res.ok) me = (await res.json()) as Me;
  } catch {
    me = null;
  }
  const editor = me?.email ? { email: me.email, auth: me.auth } : null;
  setEditor(editor);

  const sync = new EditorSync(projectId, editor?.email ?? null, toPage);

  window.addEventListener("message", (ev: MessageEvent<PageMessage>) => {
    if (ev.origin !== location.origin || ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "es:edit-change") sync.onEditChange(m.change);
    else if (m.type === "es:import-changed") sync.onImportChanged(m.importId);
    else if (m.type === "es:reload") void sync.load("Reloaded the saved schematic.");
  });

  // Ctrl/Cmd+S saves to the project now. Registered in the capture phase, before upstream's shortcut
  // handler, which would otherwise open a "save to file" dialog (File > Save still exports a file).
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopImmediatePropagation();
        sync.flushNow();
      }
    },
    { capture: true },
  );

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <ReactFlowProvider>
          <App />
          <AfterApp onReady={() => void sync.load()} />
        </ReactFlowProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
