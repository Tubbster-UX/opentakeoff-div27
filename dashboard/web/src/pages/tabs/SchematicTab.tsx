// Schematic: the EasySchematic editor, editing the project's schematic.
//
// The editor runs in its own frame (es-frame.html, web/src/es/), so upstream
// EasySchematic keeps the whole document it expects (its styles, keyboard
// shortcuts and store) without changes. This page:
//   - embeds the frame for the project;
//   - shows its save state, who is editing, and anything the editor changed
//     that the edit layer does not keep (never silently lost);
//   - forwards the relayed brink_schematic_edits rows and re-imports to the
//     frame, so other people's saved edits appear live.
// Below the editor, the read-only outline of the generated rows stays as it
// was in Phase 1.
import { useContext, useEffect, useRef, useState } from "react";
import type { Row } from "../../../../src/shared/protocol.js";
import { Panel } from "../../components/ui.js";
import { isFrameMessage, type FrameMessage, type PageMessage } from "../../lib/esBridge.js";
import { fmt, str, when } from "../../lib/format.js";
import { ProjectStoreContext, useProject } from "../../lib/projectContext.js";

type Status = Extract<FrameMessage, { type: "es:status" }>;
interface Notice {
  id: number;
  tone: "info" | "warn" | "error";
  text: string;
}

const STATE_TEXT: Record<Status["state"], string> = {
  loading: "Loading…",
  saving: "Saving…",
  saved: "All changes saved",
  pending: "Unsaved changes",
  error: "Not saved",
  suspended: "Not saving",
};

export function SchematicTab() {
  const { snap } = useProject();
  const store = useContext(ProjectStoreContext);
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const seq = useRef(0);
  const projectId = snap ? str(snap.project.id) : "";
  const importId = (snap?.import?.id as string | undefined) ?? null;

  const send = (m: PageMessage) => frame.current?.contentWindow?.postMessage(m, location.origin);

  // Frame -> page.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== frame.current?.contentWindow || !isFrameMessage(ev.data)) return;
      const m = ev.data;
      if (m.type === "es:status") setStatus(m);
      else setNotices((list) => [{ id: ++seq.current, tone: m.tone, text: m.text }, ...list].slice(0, 6));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Relayed edit-layer rows -> frame.
  useEffect(() => {
    if (!store) return;
    return store.onChange((change) => {
      if (change.table === "brink_schematic_edits") send({ type: "es:edit-change", change });
    });
  }, [store]);

  // A re-import (or re-merge) moved current_import_id: the frame reloads.
  const lastImport = useRef(importId);
  useEffect(() => {
    if (lastImport.current === importId) return;
    lastImport.current = importId;
    send({ type: "es:import-changed", importId });
  }, [importId]);

  if (!snap) return null;
  if (!importId) return <p className="text-muted">This project has no import yet: import a takeoff with brink-merge first.</p>;

  const st = status?.state ?? "loading";
  const tone = st === "error" || st === "suspended" ? "text-error" : st === "pending" || st === "saving" ? "text-warn" : st === "saved" ? "text-ok" : "text-muted";

  return (
    <>
      <section className="mb-2 border border-line bg-surface" aria-label="Schematic editor status">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
          <span data-save-state={st} className={`font-semibold ${tone}`}>
            {STATE_TEXT[st]}
            {st === "pending" && status ? ` (${status.pending})` : ""}
          </span>
          {status?.savedAt && <span className="font-mono text-xs text-muted">last saved {when(status.savedAt)}</span>}
          <span className="font-mono text-xs text-muted" data-editor={status?.editor ?? ""}>
            {status?.editor ? `editing as ${status.editor}` : status ? "no editor identity: changes cannot be saved" : ""}
          </span>
          <span className="ml-auto flex gap-2">
            {(st === "suspended" || (status?.unsupported.length ?? 0) > 0 || st === "error") && (
              <button type="button" className="border border-line px-2 py-0.5 text-xs" onClick={() => send({ type: "es:reload" })} data-action="reload-schematic">
                Discard unsaved and reload
              </button>
            )}
          </span>
        </div>
        {status?.message && <p className="m-0 border-t border-line px-3 py-1.5 text-xs text-error">{status.message}</p>}
        {status && status.unsupported.length > 0 && (
          <details className="border-t border-line px-3 py-1.5 text-xs" data-unsupported={status.unsupported.length}>
            <summary className="cursor-pointer text-warn">
              {status.unsupported.length} change{status.unsupported.length === 1 ? "" : "s"} in the editor will not be saved
            </summary>
            <ul className="m-0 mt-1 pl-4">
              {status.unsupported.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </details>
        )}
        {notices.length > 0 && (
          <ul className="m-0 list-none border-t border-line p-0 text-xs" aria-live="polite">
            {notices.map((n) => (
              <li key={n.id} data-notice={n.tone} className={`flex gap-2 px-3 py-1 ${n.tone === "warn" ? "text-warn" : n.tone === "error" ? "text-error" : "text-muted"}`}>
                <span className="flex-1 [overflow-wrap:anywhere]">{n.text}</span>
                <button type="button" className="text-muted" aria-label="Dismiss" onClick={() => setNotices((l) => l.filter((x) => x.id !== n.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <iframe
        ref={frame}
        key={projectId}
        title="EasySchematic editor"
        src={`/es-frame.html?project=${encodeURIComponent(projectId)}`}
        className="block h-[calc(100vh-230px)] min-h-[520px] w-full border border-line bg-surface"
        data-es-frame
      />
      <p className="mt-1.5 mb-3.5 text-xs text-muted">
        Editor: <a href="https://github.com/duremovich/EasySchematic">EasySchematic</a> by duremovich (AGPL-3.0), vendored unmodified with Brink&apos;s module overrides
        listed in <span className="font-mono">dashboard/vendor/PATCHES.md</span>. Saved here: moves, renames, room changes and connections; device counts and cable lengths come
        from the takeoff.
      </p>

      <Outline />
    </>
  );
}

/** The Phase 1 read-only outline of the generated rows (the import as brink-merge wrote it, before edits). */
function Outline() {
  const { snap } = useProject();
  if (!snap) return null;
  const byId = new Map(snap.nodes.map((n) => [str(n.node_id), n]));
  const label = (id: unknown) => str(byId.get(str(id))?.label ?? id);
  const rooms = snap.nodes.filter((n) => n.node_type === "room");
  const devices = snap.nodes.filter((n) => n.node_type === "device");
  const roomIds = new Set(rooms.map((r) => str(r.node_id)));
  const out = new Map<string, Row[]>();
  for (const c of snap.connections) {
    const k = str(c.source_node);
    out.set(k, [...(out.get(k) ?? []), c]);
  }
  const unplaced = devices.filter((d) => !roomIds.has(str(d.parent_id)));
  const groups: { key: string; title: string; devices: Row[] }[] = [
    ...rooms.map((r) => ({ key: str(r.node_id), title: label(r.node_id), devices: devices.filter((d) => str(d.parent_id) === str(r.node_id)) })),
    ...(unplaced.length ? [{ key: "__none", title: "No room", devices: unplaced }] : []),
  ];

  return (
    <Panel title="Generated rows" count={`${rooms.length} rooms · ${devices.length} devices · ${snap.connections.length} connections · before edits`} id="schematic-outline">
      <details>
        <summary className="cursor-pointer px-3 py-2 text-sm text-muted">Outline of the import as brink-merge generated it (read-only, live)</summary>
        {groups.length === 0 ? (
          <p className="m-0 p-4 text-center text-muted">No schematic rows for this import.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {groups.map((g) => (
              <li key={g.key} className="border-t border-line">
                <div className="flex items-baseline gap-2 px-3 py-2 font-semibold">
                  <span>{g.title}</span>
                  <span className="font-mono text-xs font-normal text-muted">{g.devices.length} devices</span>
                </div>
                <ul className="m-0 list-none pb-2 pl-6 pr-3">
                  {g.devices.map((d) => {
                    const conns = out.get(str(d.node_id)) ?? [];
                    return (
                      <li key={str(d.node_id)} data-node={str(d.node_id)} className="py-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span>{label(d.node_id)}</span>
                          <span className="font-mono text-xs text-muted">{str(d.device_type)}</span>
                          {d.condition_key != null && <span className="font-mono text-xs text-muted">{str(d.condition_key)}</span>}
                        </div>
                        {conns.length > 0 ? (
                          <ul className="m-0 list-none pl-4 font-mono text-xs">
                            {conns.map((c) => (
                              <li key={str(c.edge_id)} className="[overflow-wrap:anywhere] text-muted">
                                → <span className="text-ink">{label(c.target_node)}</span> · {str(c.cable_type) || str(c.signal_type)} · {fmt(c.cable_length_ft)} ft
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="pl-4 font-mono text-xs text-warn">no cable</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Panel>
  );
}
