// The bar under the canvas, in place of upstream's status strip: the armed tool, the
// sheet's scale, the zoom, the selection, who is editing and the save state, plus the
// canvas's own messages (upstream's message bar), notices and what will not be saved.
import { useEffect, useState } from "react";
import { Button, Icon, Status } from "../../design/index.js";
import { getHost, useHost } from "../host";
import { dismissNotice, getSession, setSession, STATE_TEXT, STATE_TONE, useSession } from "../session";
import { measured } from "./RightPanel";
import { scaleText } from "./TakeoffToolbar";

const VERB: Record<string, string> = {
  select: "Select",
  area: "Area",
  rect: "Rectangle",
  linear: "Linear",
  surface: "Surface area",
  count: "Count",
  symbol: "Symbol",
  deduct: "Deduct",
  "deduct-rect": "Deduct rectangle",
  calibrate: "Calibrate",
  check: "Check a dimension",
  textcopy: "Copy text",
  zone: "Zone check",
  approve: "Approval stamp",
  cloud: "Revision cloud",
  callout: "Callout",
  text: "Text note",
  highlight: "Highlight box",
  highlighter: "Highlighter",
  dimension: "Dimension line",
  image: "Image",
};

/** The canvas's zoom lives in a ref (written per frame, never React state): read it on animation frames. */
function useZoom(): number | null {
  const [z, setZ] = useState<number | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const tick = () => {
      const s = getHost()?.tfRef.current.scale;
      if (s !== undefined && Math.abs(s - last) > 1e-4) {
        last = s;
        setZ(s);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return z;
}

export function StatusBar() {
  const { status, notices } = useSession();
  const zoom = useZoom();
  const v = useHost(
    (h) => ({
      tool: h.tool,
      scale: scaleText(h.scaleFace, h.unitsPerPx, h.scaleNeedsConfirm),
      sel: h.selShape ? `${h.conditions.find((c) => c.id === h.selShape!.condition_id)?.finish_tag ?? ""} · ${measured(h.selShape, h.units)}` : "",
      shapes: h.visibleShapes.length,
      msg: h.commitMsg,
      sheet: h.view === "canvas" && h.sheetKey ? h.tabLabel(h.sheetKey) : "",
    }),
    { tool: "select", scale: "", sel: "", shapes: 0, msg: "", sheet: "" },
  );
  const st = status?.state ?? "loading";
  const unsupported = status?.unsupported ?? [];
  const danger = /^(couldn't|could not|not saved|error|failed)/i.test(v.msg) || /failed/i.test(v.msg);
  return (
    <section data-bk-chrome data-print-hide aria-label="Takeoff status" className="shrink-0 border-t border-line bg-panel text-xs">
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1" data-statusbar>
        <span className="font-medium text-ink" data-status-tool={v.tool}>
          {VERB[v.tool] ?? v.tool}
        </span>
        {v.sheet && <span className="text-ink-2" data-status-sheet>{v.sheet}</span>}
        <span className="num text-ink-2" data-status-scale>
          {v.scale}
        </span>
        <span className="num text-ink-3" data-status-zoom>
          {zoom ? `${Math.round(zoom * 100)}%` : ""}
        </span>
        <span className="num text-ink-3" data-status-selection>
          {v.sel ? `Selected: ${v.sel}` : `${v.shapes} takeoff${v.shapes === 1 ? "" : "s"} on view`}
        </span>
        {v.msg && (
          <span className={`min-w-0 flex-1 truncate ${danger ? "text-danger" : "text-ink-2"}`} title={v.msg} data-status-message>
            {v.msg}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
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
          <span className="sm:hidden" data-save-state-mobile={st}>
            <Status tone={STATE_TONE[st]}>{STATE_TEXT[st]}</Status>
          </span>
          {status?.savedAt && <span className="num hidden text-ink-3 md:inline">last saved {new Date(status.savedAt).toLocaleTimeString()}</span>}
          {(st === "error" || st === "suspended") && (
            <Button size="sm" icon="refresh" onClick={() => status && getSession().store?.retry()} data-action="retry-save">
              Try again
            </Button>
          )}
        </span>
      </div>
      {status?.message && (
        <p role="alert" className="m-0 border-t border-line px-3 py-1 text-ink-2">
          {status.message}
        </p>
      )}
      {unsupported.length > 0 && (
        <p className="m-0 border-t border-line px-3 py-1 text-warn" data-unsupported-bar={unsupported.length}>
          Not saved, kept in this tab: {unsupported.join("; ")}.{" "}
          <button type="button" className="bk-focus cursor-pointer text-accent underline" onClick={() => setSession({ right: true, rightTab: "edits" })}>
            Details
          </button>
        </p>
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

