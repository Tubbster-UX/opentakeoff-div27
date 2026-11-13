// Link Run readout (Division 27, docs/design/CABLE_SETUP.md, Canvas UI §3) —
// the live numbers before commit: which device, how many segments, which TR,
// the measured route LF and the per-cable LF the condition's setup gives,
// and, once the draft is complete, the refusal Enter would hit (or "Enter to
// link"). Every number comes from lib/cableLink.js linkReadout, which asks
// lib/cable.js; nothing here computes a length.
import { lenVal, lenUnit } from "../lib/units";

const r2 = (v) => Math.round(v * 100) / 100;
const STEP = {
  device: "Click a device marker",
  route: "Click its route segments in order",
  tr: "Click more segments, or the TR marker",
  ready: "",
};

/** @param {{ readout: any, units?: string, onLink: () => void, onCancel: () => void }} props */
export default function CableLinkReadout({ readout, units = "imperial", onLink, onCancel }) {
  if (!readout) return null;
  const L = (ft) => (ft == null ? "—" : `${r2(lenVal(ft, units))} ${lenUnit(units)}`);
  const ready = readout.stage === "ready" && !readout.refusal;
  return (
    // pointer events stop here: the chip sits inside the canvas container,
    // whose pointerdown would otherwise read a button press as a pick
    <div data-cable-readout role="status" aria-live="polite" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 30, maxWidth: "min(560px, calc(100% - 32px))",
        display: "flex", flexDirection: "column", gap: 3, padding: "7px 10px", background: "var(--paper-bright)", border: `1px solid ${readout.refusal ? "var(--c-danger)" : "var(--cobalt)"}`,
        boxShadow: "0 2px 10px rgba(0,0,0,.18)", fontSize: 11.5, color: "var(--ink)", pointerEvents: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--cobalt)" }}>Link run</strong>
        <span style={{ fontFamily: "var(--f-mono)" }}>
          {readout.device || "device ?"} → {readout.segments} seg{readout.segments === 1 ? "" : "s"} → {readout.tr || "TR ?"}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onLink} disabled={!ready} title="Link this run (Enter)"
          style={{ padding: "2px 9px", borderRadius: 0, border: "1px solid var(--cobalt)", background: ready ? "var(--cobalt)" : "transparent", color: ready ? "var(--paper-bright)" : "var(--ink-muted)", cursor: ready ? "pointer" : "default", fontSize: 11, fontWeight: 600 }}>Link ⏎</button>
        <button onClick={onCancel} title="Cancel this draft (Esc)"
          style={{ padding: "2px 7px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11 }}>Esc</button>
      </div>
      <div style={{ fontFamily: "var(--f-mono)", color: "var(--ink)" }}>
        route {L(readout.route_lf)} · per cable {L(readout.per_cable_lf)}
        {readout.cables != null && readout.location_lf != null ? ` · ${readout.cables} cable${readout.cables === 1 ? "" : "s"} = ${L(readout.location_lf)}` : ""}
      </div>
      {readout.refusal
        ? <div style={{ color: "var(--c-danger)", lineHeight: 1.4 }}>{readout.refusal}</div>
        : STEP[readout.stage] ? <div style={{ color: "var(--ink-muted)" }}>{STEP[readout.stage]} · Backspace takes back the last pick</div> : null}
    </div>
  );
}
