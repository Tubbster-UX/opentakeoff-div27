// Runs panel (Division 27, docs/design/CABLE_SETUP.md, Canvas UI §4) — the
// docked right-rail surface for cable runs, the Roll panel's sibling: every
// run grouped by its device condition with per-cable LF, its status
// (linked / withheld / broken with the reason) and review state, the
// Unlinked list (check devices and Hold them with a reason when they
// deliberately get no run), the Held list, and the telecom rooms with their
// names. A run over 295 ft per cable carries a flag. Possible duplicates
// (lib/cableDupes.js: markers stacked on one sheet, overlay plans) list with
// a ⌖ per side; they are flags only. Each run can state its own vertical and
// cable count (the ↕ editor), replacing the condition's for that location
// only; an overridden run says so under its row. Clicking an item
// puts it on screen. A pure view over the canvas's computeCableTakeoff
// result — the records change only through the callbacks, which the canvas
// puts on its undo stack.
import { useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { DEVICE_TYPE_LABELS, isTrCondition, TIA_MAX_LINK_FT } from "../lib/cable.js";
import { lenVal, lenUnit, heightVal, heightUnit, heightInputToFeet } from "../lib/units";
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

/** The per-run override editor: the run's own vertical (feet, shown in the
 *  display units) and cable count, each blank = the condition's. Set commits
 *  both through onOverride (one undo step); an unchanged field keeps its
 *  stored value exactly (no metric round-trip drift). */
function RunOverride({ run, cond, units, onOverride, onDone }) {
  const HU = heightUnit(units);
  const show = (ft) => (ft == null ? "" : String(r2(heightVal(ft, units))));
  const v0 = show(run.vertical_override ?? null);
  const c0 = run.cables_override != null ? String(run.cables_override) : "";
  const [v, setV] = useState(v0);
  const [c, setC] = useState(c0);
  const [err, setErr] = useState("");
  const condV = cond?.cable_setup?.vertical_ft;
  const condC = cond?.cable_setup?.cables_per_location;
  const commit = () => {
    const patch = {};
    if (v.trim() !== v0) {
      if (!v.trim()) patch.vertical_override = null;
      else {
        const n = Number(v);
        if (!(Number.isFinite(n) && n >= 0)) { setErr(`vertical must be a number of ${HU}, 0 or more`); return; }
        patch.vertical_override = heightInputToFeet(n, units);
      }
    }
    if (c.trim() !== c0) {
      if (!c.trim()) patch.cables_override = null;
      else {
        const n = Number(c);
        if (!(Number.isInteger(n) && n >= 1)) { setErr("cables must be a whole number of 1 or more"); return; }
        patch.cables_override = n;
      }
    }
    if (Object.keys(patch).length) onOverride(run.id, patch);
    onDone();
  };
  const keys = (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onDone(); };
  const field = { width: 52, margin: "0 3px", padding: "1px 4px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", color: "var(--ink)", fontSize: 11, ...mono };
  return (
    <div data-cable-override-form={run.id} style={{ padding: "3px 0 5px 14px", fontSize: 10.5, color: "var(--ink-secondary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label title={`This run's own vertical, replacing the condition's for this location only. Blank = the condition's${condV != null ? ` (${show(condV)} ${HU})` : " (none entered)"}.`}>
          vertical <input name="run-vertical" autoFocus inputMode="decimal" value={v} onChange={(e) => { setV(e.target.value); setErr(""); }} onKeyDown={keys}
            placeholder={condV != null ? show(condV) : "none"} style={field} /> {HU}
        </label>
        <label title={`Cables at this location, replacing the condition's cables per location. Blank = the condition's${condC != null ? ` (${condC})` : ""}.`}>
          cables <input name="run-cables" inputMode="numeric" value={c} onChange={(e) => { setC(e.target.value); setErr(""); }} onKeyDown={keys}
            placeholder={condC != null ? String(condC) : ""} style={{ ...field, width: 34 }} />
        </label>
        <button onClick={commit} title="Save this run's own values (blank = the condition's) — ⌘Z undoes" style={smallBtn("pos")}>Set</button>
        <button onClick={onDone} title="Close without changing (Esc)" style={smallBtn()}>Esc</button>
      </div>
      <div style={{ marginTop: 2, color: err ? "var(--c-danger)" : "var(--ink-muted)" }}>
        {err || `Blank = the condition's (vertical ${condV != null ? `${show(condV)} ${HU}` : "not entered"}, ${condC ?? "?"} cable${condC === 1 ? "" : "s"}). A stated value, never a guess.`}
      </div>
    </div>
  );
}

/**
 * @param {{ takeoff: any, conditions: any[], shapes: any[], units?: string, linkArmed?: boolean,
 *   onArmLink: () => void, onLocate: (shapeId: string) => void, onUnlink: (runId: string) => void,
 *   onAccept: (runIds: string[]) => void, onRenameTr: (shapeId: string, name: string) => void,
 *   onHold?: (shapeIds: string[], reason: string) => boolean,
 *   onOverride?: (runId: string, patch: { vertical_override?: number | null, cables_override?: number | null }) => boolean,
 *   onClose: () => void }} props
 */
export default function RunsPanel({ takeoff, conditions, shapes, units = "imperial", linkArmed = false, onArmLink, onLocate, onUnlink, onAccept, onRenameTr, onHold = null, onOverride = null, onClose }) {
  const [checked, setChecked] = useState(() => new Set());
  const [editing, setEditing] = useState(null);   // run id whose override editor is open
  const [holdReason, setHoldReason] = useState("");
  const LU = lenUnit(units);
  const L = (ft) => (ft == null ? "—" : `${r2(lenVal(ft, units))} ${LU}`);
  const condById = new Map((conditions || []).map((c) => [c.id, c]));
  const runs = takeoff?.resolved?.runs || [];
  const unlinked = takeoff?.resolved?.unlinked || { devices: [], routes: [] };
  const totals = takeoff?.summary?.totals;
  const warnings = takeoff?.summary?.warnings || [];
  const held = takeoff?.resolved?.held || [];
  const holds = takeoff?.resolved?.holds || [];
  const dupes = takeoff?.duplicates || null;   // lib/cableDupes.js — its warnings are in `warnings` too
  // trunk / branch split per run, once a route condition is tagged
  const split = !!takeoff?.pathway;
  const pendingIds = [...runs.filter((r) => r.pending).map((r) => r.id), ...holds.filter((h) => h.pending).map((h) => h.id)];
  // a checked device that got linked or deleted since drops out of the pick
  const unlinkedIds = new Set(unlinked.devices.map((d) => d.shape_id));
  const picked = [...checked].filter((id) => unlinkedIds.has(id));
  const toggle = (id) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const doHold = () => {
    if (!onHold || !picked.length || !holdReason.trim()) return;
    if (onHold(picked, holdReason.trim())) { setChecked(new Set()); setHoldReason(""); }
  };
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

  const HU = heightUnit(units);
  const H = (ft) => `${r2(heightVal(ft, units))} ${HU}`;
  // a run that states its own vertical or cable count says so on a line of
  // its own under the row, with the condition's value beside it
  const overrideLine = (r) => {
    const cs = condById.get(r.condition_id)?.cable_setup;
    const parts = [
      r.vertical_override != null ? `vertical ${H(r.vertical_override)} (condition ${cs?.vertical_ft != null ? H(cs.vertical_ft) : "has none"})` : "",
      r.cables_override != null ? `${r.cables_override} cable${r.cables_override === 1 ? "" : "s"} (condition ${cs?.cables_per_location ?? "?"})` : "",
    ].filter(Boolean);
    if (!parts.length) return null;
    return (
      <div data-cable-flag="override" title="This run's own values replace the condition's for this location only — ↕ edits them"
        style={{ ...mono, fontSize: 10, padding: "0 0 3px 14px", color: "var(--cobalt)" }}>run's own: {parts.join(" · ")}</div>
    );
  };
  const runRow = (r) => (
    <div key={r.id} style={{ borderTop: "1px solid var(--paper-cream)" }}>
      <div data-cable-run={r.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", fontSize: 11 }}>
        <span title={r.status === "linked" ? "Linked — counts in every total" : r.reason} style={{ width: 8, height: 8, flexShrink: 0, background: STATUS_COLOR[r.status] }} />
        <span style={{ ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={`${r.id}\nroute ${L(r.route_lf)} over ${r.route_shape_ids.length} segment(s)${split ? `\nbranch ${L(r.branch_lf)} · trunk ${L(r.trunk_lf)}${r.other_lf ? ` · unspecified ${L(r.other_lf)}` : ""}` : ""}${r.reason ? `\n${r.status}: ${r.reason}` : ""}${r.notes ? `\n${r.notes.join("\n")}` : ""}`}>
          → {r.tr_name || r.tr_id || "?"} · {r.status === "linked" ? `${L(r.per_cable_lf)} × ${r.cables}` : r.status}
        </span>
        {r.over_length && <span data-cable-flag="over-length" title={`Per cable ${L(r.per_cable_lf)} exceeds ${TIA_MAX_LINK_FT} ft — the TIA-568 copper permanent-link limit (90 m). It still counts: check the route; if it stands, it needs a closer TR or a length test and owner notice.`}
          style={{ ...mono, fontSize: 9.5, padding: "0 4px", border: "1px solid #b66b00", color: "#b66b00", flexShrink: 0 }}>&gt;{TIA_MAX_LINK_FT}</span>}
        {r.pending && <button onClick={() => onAccept([r.id])} title="Accept this agent-linked run (its route segments keep their own review status)" style={smallBtn("pos")}>Accept</button>}
        {onOverride && r.condition_id && condById.has(r.condition_id) && (
          <button data-cable-override={r.id} onClick={() => setEditing((e) => (e === r.id ? null : r.id))}
            title="This run's own vertical or cable count — replaces the condition's for this location only"
            style={{ ...smallBtn(), ...(editing === r.id ? { borderColor: "var(--cobalt)", color: "var(--cobalt)" } : {}) }}>↕</button>
        )}
        {locBtn(r.device_shape_ids[0], "Put the device on screen")}
        <button onClick={() => onUnlink(r.id)} title="Unlink — the shapes stay; ⌘Z re-links" style={smallBtn("danger")}>✕</button>
      </div>
      {overrideLine(r)}
      {editing === r.id && onOverride && (
        <RunOverride key={`${r.vertical_override ?? ""}|${r.cables_override ?? ""}`} run={r} cond={condById.get(r.condition_id)} units={units} onOverride={onOverride} onDone={() => setEditing(null)} />
      )}
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
            {(totals.pending_runs > 0 || totals.unlinked_devices > 0 || totals.held_devices > 0 || pendingIds.length > 0) && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 11 }}>
                {totals.unlinked_devices > 0 && <span style={{ color: "var(--c-danger)" }}>{totals.unlinked_devices} unlinked</span>}
                {totals.held_devices > 0 && <span style={{ color: "var(--ink-muted)" }}>{totals.held_devices} held</span>}
                {totals.pending_runs > 0 && <span style={{ color: "var(--ink-muted)" }}>{totals.pending_runs} pending review (counted)</span>}
                {pendingIds.length > 0 && <button onClick={() => onAccept(pendingIds)} style={{ ...smallBtn("pos"), marginLeft: "auto" }} title="Accept every pending run and hold — one undo step">Accept all</button>}
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
            {onHold && unlinked.devices.length > 0 && (
              <div data-cable-hold-form style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0 6px" }}>
                <input type="checkbox" aria-label="Check every unlinked device" checked={picked.length === unlinked.devices.length}
                  onChange={(e) => setChecked(e.target.checked ? new Set(unlinked.devices.map((d) => d.shape_id)) : new Set())} />
                <input name="hold-reason" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doHold(); }}
                  placeholder="reason (routing not drawn, by others…)" title="Why the checked devices get no run — prints on the report and the marked set"
                  style={{ flex: 1, minWidth: 0, padding: "2px 5px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 11 }} />
                <button onClick={doHold} disabled={!picked.length || !holdReason.trim()}
                  title="Hold the checked devices: no run by decision. They stay out of totals and list as held with the reason. ⌘Z undoes."
                  style={{ ...smallBtn(), opacity: picked.length && holdReason.trim() ? 1 : 0.5 }}>Hold {picked.length || ""}</button>
              </div>
            )}
            {unlinked.devices.map((d) => (
              <div key={"d" + d.shape_id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
                {onHold && <input type="checkbox" aria-label={`Check ${d.finish_tag} device`} checked={checked.has(d.shape_id)} onChange={() => toggle(d.shape_id)} />}
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
        {dupes && (dupes.same_sheet.length > 0 || dupes.cross_sheet.length > 0) && (
          <div style={section} data-cable-duplicates>
            <div style={head}>Possible duplicates — flagged, nothing changed</div>
            {dupes.cross_sheet.map((x) => x.groups.map((g) => (
              <div key={`x${x.sheet_a_id}\u0000${x.sheet_b_id}\u0000${g.condition_a}\u0000${g.condition_b}`} data-cable-dup="cross" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
                <span style={{ ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={`${g.count} device positions coincide on ${x.sheet_a} and ${x.sheet_b}${g.different_conditions ? " — on different cable conditions" : ""}. If one sheet shows them for reference only, move that set to a non-cable reference condition.`}>
                  {g.finish_tag_a} {x.sheet_a} ↔ {g.finish_tag_b} {x.sheet_b} ({g.count})
                </span>
                {locBtn(g.pairs[0][0], `Put the first ${g.finish_tag_a} on ${x.sheet_a} on screen`)}
                {locBtn(g.pairs[0][1], `Put the first ${g.finish_tag_b} on ${x.sheet_b} on screen`)}
              </div>
            )))}
            {dupes.same_sheet.map((d) => (
              <div key={`s${d.shape_ids.join("\u0000")}`} data-cable-dup="same" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
                <span style={{ ...mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={`${d.shape_ids.length} markers within ${d.basis === "ft" ? `${d.threshold} ft` : `${r2(d.threshold * 100)}% of the sheet (no scale)`} — one device marked twice?`}>
                  {d.sheet} · {d.same_condition ? `${d.finish_tags[0]} ×${d.shape_ids.length}` : [...new Set(d.finish_tags)].join(" + ")}
                </span>
                {locBtn(d.shape_ids[0], "Put these markers on screen")}
              </div>
            ))}
          </div>
        )}
        {holds.length > 0 && (
          <div style={section} data-cable-held>
            <div style={head}>Held — no run by decision, excluded from totals</div>
            {holds.map((h) => (
              <div key={h.id} data-cable-hold={h.id} style={{ padding: "3px 0", borderTop: "1px solid var(--paper-cream)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${h.reason}\n${h.id}`}>{h.reason}</span>
                  <span style={{ ...mono, fontSize: 10.5, color: "var(--ink-muted)" }}>{h.held} device{h.held === 1 ? "" : "s"}</span>
                  {h.pending && <button onClick={() => onAccept([h.id])} title="Accept this agent's hold" style={smallBtn("pos")}>Accept</button>}
                  <button onClick={() => onUnlink(h.id)} title="Release the hold — its devices return to the unlinked list; ⌘Z re-holds" style={smallBtn("danger")}>release</button>
                </div>
                {held.filter((d) => d.hold_id === h.id).map((d) => (
                  <div key={d.shape_id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, padding: "1px 0 1px 10px", color: "var(--ink-secondary)" }}>
                    <span style={{ ...mono, flex: 1 }}>{d.finish_tag}{d.label ? ` · ${d.label}` : ""}</span>
                    {locBtn(d.shape_id, "Put this device on screen")}
                  </div>
                ))}
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
