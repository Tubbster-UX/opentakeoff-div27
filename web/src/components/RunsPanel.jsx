// Runs panel (Division 27, docs/design/CABLE_SETUP.md, Canvas UI §4) — the
// docked right-rail surface for cable runs, the Roll panel's sibling: every
// run grouped by its device condition with per-cable LF, its status
// (linked / withheld / broken with the reason) and review state, the
// Unlinked list, and the telecom rooms with their names. Clicking an item
// puts it on screen. A pure view over the canvas's computeCableTakeoff
// result — the records change only through the callbacks, which the canvas
// puts on its undo stack.
import { useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { DEVICE_TYPE_LABELS, isTrCondition } from "../lib/cable.js";
import { lenVal, lenUnit } from "../lib/units";
import { HatchSwatch } from "./hatches.jsx";

const r2 = (v) => Math.round(v * 100) / 100;
const mono = { fontFamily: "var(--f-mono)" };
const smallBtn = (tone = "muted") => ({
  padding: "1px 7px", borderRadius: 0, cursor: "pointer", fontSize: 10.5, lineHeight: 1.5, flexShrink: 0,
  border: `1px solid ${tone === "pos" ? "var(--c-positive)" : "var(--ink-faint)"}`,
  background: tone === "pos" ? "var(--c-positive)" : "transparent",
  color: tone === "pos" ? "var(--paper-bright)" : tone === "danger" ? "var(--c-danger)" : "var(--ink-muted)",
});
const STATUS_COLOR = { linked: "var(--c-positive)", withheld: "#b66b00", broken: "var(--c-danger)" };

/** A TR name field: commits on Enter or blur, so one rename is one undo step. */
function TrName({ shape, onRename }) {
  const [v, setV] = useState(shape.label || "");
  const [seen, setSeen] = useState(shape.label || "");
  if ((shape.label || "") !== seen) { setSeen(shape.label || ""); setV(shape.label || ""); }
  const commit = () => { if (v.trim() !== (shape.label || "")) onRename(shape.id, v.trim()); };
  return (
    <input name="tr-name" value={v} placeholder="name (MDF, IDF-1)" onChange={(e) => setV(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(shape.label || ""); e.currentTarget.blur(); } }}
      title="The TR's name — stored as the marker's label; prints on the Cable summary and runs sheet"
      style={{ width: 112, padding: "2px 5px", borderRadius: 0, border: `1px solid ${shape.label ? "var(--ink-faint)" : "var(--c-danger)"}`, fontSize: 11.5 }} />
  );
}

/**
 * @param {{ takeoff: any, conditions: any[], shapes: any[], units?: string, linkArmed?: boolean,
 *   onArmLink: () => void, onLocate: (shapeId: string) => void, onUnlink: (runId: string) => void,
 *   onAccept: (runIds: string[]) => void, onRenameTr: (shapeId: string, name: string) => void, onClose: () => void }} props
 */
export default function RunsPanel({ takeoff, conditions, shapes, units = "imperial", linkArmed = false, onArmLink, onLocate, onUnlink, onAccept, onRenameTr, onClose }) {
  const LU = lenUnit(units);
  const L = (ft) => (ft == null ? "—" : `${r2(lenVal(ft, units))} ${LU}`);
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const runs = takeoff?.resolved?.runs || [];
  const unlinked = takeoff?.resolved?.unlinked || { devices: [], routes: [] };
  const totals = takeoff?.summary?.totals;
  const warnings = takeoff?.summary?.warnings || [];
  const pendingIds = runs.filter((r) => r.pending).map((r) => r.id);
  const trConds = new Set((conditions || []).filter(isTrCondition).map((c) => c.id));
  const trShapes = (shapes || []).filter((s) => s.measure_role === "count" && trConds.has(s.condition_id));
  // runs grouped by device condition, in condition order; runs with no
  // resolvable condition (every device deleted) group last under "—"
  const groups = [];
  for (const c of conditions || []) {
    const rs = runs.filter((r) => r.condition_id === c.id);
    if (rs.length || c.cable_setup) groups.push({ c, rs });
  }
  const orphan = runs.filter((r) => !r.condition_id || !condById.has(r.condition_id));
  const section = { padding: "8px 12px", borderBottom: "2px solid var(--ink-faint)" };
  const head = { ...mono, fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)", fontWeight: 700, marginBottom: 4 };
  const locBtn = (id, title) => (
    <button onClick={() => onLocate(id)} title={title} style={{ ...smallBtn(), color: "var(--cobalt)" }}>⌖</button>
  );

  const runRow = (r) => (
    <div key={r.id} data-cable-run={r.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", borderTop: "1px solid var(--paper-cream)", fontSize: 11 }}>
      <span title={r.status === "linked" ? "Linked — counts in every total" : r.reason} style={{ width: 8, height: 8, flexShrink: 0, background: STATUS_COLOR[r.status] }} />
      <span style={{ ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={`${r.id}\nroute ${L(r.route_lf)} over ${r.route_shape_ids.length} segment(s)${r.reason ? `\n${r.status}: ${r.reason}` : ""}${r.notes ? `\n${r.notes.join("\n")}` : ""}`}>
        → {r.tr_name || r.tr_id || "?"} · {r.status === "linked" ? `${L(r.per_cable_lf)} × ${r.cables}` : r.status}
      </span>
      {r.pending && <button onClick={() => onAccept([r.id])} title="Accept this agent-linked run (its route segments keep their own review status)" style={smallBtn("pos")}>Accept</button>}
      {locBtn(r.device_shape_ids[0], "Put the device on screen")}
      <button onClick={() => onUnlink(r.id)} title="Unlink — the shapes stay; ⌘Z re-links" style={smallBtn("danger")}>✕</button>
    </div>
  );

  return (
    <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--ink-faint)", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "var(--ink)", color: "var(--paper-cream)" }}>
        <Icon name="cableRun" size={15} />
        <strong style={{ flex: 1, fontSize: 12.5 }}>Cable runs</strong>
        <button onClick={onArmLink} title="Link Run (W): click a device, its route segments in order, the TR, then Enter"
          style={{ padding: "2px 8px", border: `1px solid ${linkArmed ? "var(--cobalt)" : "var(--ink-faint)"}`, background: linkArmed ? "var(--cobalt)" : "transparent", color: linkArmed ? "var(--paper-bright)" : "var(--paper-cream)", cursor: "pointer", fontSize: 10.5, ...mono }}>link (W)</button>
        <button onClick={onClose} title="Close panel" style={{ border: "none", background: "transparent", color: "var(--paper-cream)", fontSize: 16, cursor: "pointer", padding: "0 2px" }}>×</button>
      </div>
      {/* text color stated, not inherited — an ancestor's hard-coded ink read dark-on-dark in the HUD theme */}
      <div style={{ flex: 1, overflow: "auto", fontSize: 12, color: "var(--ink)" }}>
        {!takeoff && (
          <div style={{ padding: 14, color: "var(--ink-muted)", lineHeight: 1.6 }}>
            No cable conditions yet. In the Takeoffs panel open a count condition's properties and pick
            <b> + cable…</b> → a device type; flag another count condition as <b>Telecom room</b> and a
            linear one as <b>Cable route</b>. Then press <b>W</b>: click a device, its route segments in
            order, the TR, and Enter.
          </div>
        )}
        {totals && (
          <div style={section} data-cable-totals>
            <div style={{ ...mono, fontSize: 11.5, color: "var(--ink)" }}>
              {totals.pulls} pull{totals.pulls === 1 ? "" : "s"} · {totals.cables} cable{totals.cables === 1 ? "" : "s"} of {totals.ea} device{totals.ea === 1 ? "" : "s"}
            </div>
            <div style={{ ...mono, fontSize: 11, color: "var(--ink-secondary)" }}>
              {L(totals.cable_lf)} net · {L(totals.cable_lf_order)} with waste
            </div>
            {(totals.pending_runs > 0 || totals.unlinked_devices > 0) && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 11 }}>
                {totals.unlinked_devices > 0 && <span style={{ color: "var(--c-danger)" }}>{totals.unlinked_devices} unlinked</span>}
                {totals.pending_runs > 0 && <span style={{ color: "var(--ink-muted)" }}>{totals.pending_runs} pending review (counted)</span>}
                {pendingIds.length > 0 && <button onClick={() => onAccept(pendingIds)} style={{ ...smallBtn("pos"), marginLeft: "auto" }} title="Accept every pending run — one undo step">Accept all</button>}
              </div>
            )}
            {warnings.map((w) => <div key={w} style={{ marginTop: 4, color: "#b66b00", fontSize: 10.5, lineHeight: 1.4 }}>{w}</div>)}
          </div>
        )}
        {groups.map(({ c, rs }) => (
          <div key={c.id} style={section} data-cable-condition={c.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
              <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={c.hatch || "solid"} line={c.color} fill={c.fill} /></span>
              <b style={{ ...mono, fontSize: 12 }}>{c.finish_tag}</b>
              <span style={{ color: "var(--ink-muted)", fontSize: 10.5 }}>{DEVICE_TYPE_LABELS[c.cable_setup?.device_type] || ""}{c.cable_setup?.cable_type ? ` · ${c.cable_setup.cable_type}` : ""}</span>
              <span style={{ marginLeft: "auto", ...mono, fontSize: 10.5, color: "var(--ink-muted)" }}>{rs.filter((r) => r.status === "linked").length}/{rs.length}</span>
            </div>
            {rs.length === 0 && <div style={{ color: "var(--ink-muted)", fontSize: 11 }}>No runs yet.</div>}
            {rs.map(runRow)}
          </div>
        ))}
        {orphan.length > 0 && (
          <div style={section}>
            <div style={head}>Runs whose devices are gone</div>
            {orphan.map(runRow)}
          </div>
        )}
        {(unlinked.devices.length > 0 || unlinked.routes.length > 0) && (
          <div style={section} data-cable-unlinked>
            <div style={head}>Unlinked — excluded from totals</div>
            {unlinked.devices.map((d) => (
              <div key={"d" + d.shape_id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
                <span style={{ ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.reason}>device · {d.finish_tag}{d.label ? ` · ${d.label}` : ""}</span>
                {locBtn(d.shape_id, "Put this device on screen")}
              </div>
            ))}
            {unlinked.routes.map((r) => (
              <div key={"r" + r.shape_id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
                <span style={{ ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.reason}>route · {r.finish_tag} · {L(r.length_lf)}</span>
                {locBtn(r.shape_id, "Put this route segment on screen")}
              </div>
            ))}
          </div>
        )}
        {trShapes.length > 0 && (
          <div style={section} data-cable-trs>
            <div style={head}>Telecom rooms</div>
            {trShapes.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
                <TrName shape={s} onRename={onRenameTr} />
                <span style={{ ...mono, fontSize: 10.5, color: "var(--ink-muted)", flex: 1 }}>{runs.filter((r) => r.tr_id === s.id && r.status === "linked").length} run(s)</span>
                {locBtn(s.id, "Put this TR on screen")}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
