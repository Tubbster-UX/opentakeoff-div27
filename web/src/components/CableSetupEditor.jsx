// Cable setup (Division 27, docs/design/CABLE_SETUP.md, Canvas UI §1–2) —
// the opt-in that sits in the docked condition editor, the roll-goods
// precedent: nothing shows on a condition until you pick what it is.
//
//   + cable…  → a device type   (count condition: a cable_setup; the type's
//                                starting values pre-fill, waste 12% too when
//                                the condition has no waste yet)
//             → Telecom room   (count condition: role "tr" — its markers are
//                                the TRs runs home to, named by their label)
//             → Cable route    (linear condition: role "route" — every line on
//                                it no linked run uses is listed as unlinked;
//                                Kind: Trunk / Branch / unspecified sets its
//                                route_kind, which splits each run's route LF
//                                and adds the Report's Pathway table)
//
// Required values left empty show inline, in the danger color, with the
// reason the library withholds the condition's runs. Field edits follow the
// condition editor's convention (not on the undo stack), like roll goods.
// All defaults and validation come from lib/cable.js — nothing is computed here.
import { DEVICE_TYPES, DEVICE_TYPE_LABELS, CABLE_DEFAULTS, ROUTE_KINDS, ROUTE_KIND_LABELS, mintCableSetup, hasCableSetup, cableSetupProblems, routeKindOf } from "../lib/cable.js";
import { lenVal, lenUnit, heightVal, heightInputToFeet, heightUnit } from "../lib/units";

const box = { display: "flex", flexDirection: "column", gap: 5, paddingTop: 6, marginTop: 1, borderTop: "1px solid var(--ink-faint)" };
const cap = { color: "var(--ink-muted)", fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase" };
const sel = { padding: "2px 4px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 11.5 };
const xBtn = { marginLeft: "auto", padding: "1px 6px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--c-danger)", cursor: "pointer", fontSize: 11 };
const num = (bad) => ({ width: 52, padding: "3px 5px", borderRadius: 0, border: `1px solid ${bad ? "var(--c-danger)" : "var(--ink-faint)"}`, fontSize: 12 });
const r2 = (v) => Math.round(v * 100) / 100;
// the library's reasons name the stored fields (the MCP wire needs those);
// the canvas says them the way the inputs above are labeled
const fieldLabels = (p) => p.replace(/\bvertical_ft\b/g, "Vertical").replace(/\bloop_device_ft\b/g, "Loop at device")
  .replace(/\bloop_tr_ft\b/g, "Loop at TR").replace(/\bcables_per_location\b/g, "Cables per location").replace(/\bdevice_type\b/g, "Device type");

/**
 * @param {{ cond: any, onUpdateCond: (patch: object) => void, row?: any, cableRows?: any[], units?: string }} props
 *   row: the condition's quantity row (ea / lf / floor_sf …) — decides which
 *   opt-ins make sense (a device or TR is a count condition, a route is linear)
 *   cableRows: the condition's Cable summary rows (lib/cable.js) for the readout
 */
export default function CableSetupEditor({ cond: c, onUpdateCond, row = null, cableRows = [], units = "imperial" }) {
  const hasArea = !!row && ((row.floor_sf || 0) !== 0 || (row.wall_sf || 0) !== 0 || (row.border_sf || 0) !== 0);
  const hasLf = !!row && (row.lf || 0) > 0;
  const hasEa = !!row && (row.ea || 0) > 0;
  const countOk = !hasArea && !hasLf;
  const routeOk = !hasArea && !hasEa;

  if (c.role === "tr" || c.role === "route") {
    const tr = c.role === "tr";
    return (
      <div style={box}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={cap}>{tr ? "Telecom rooms (TR)" : "Cable routes"}</span>
          <button onClick={() => onUpdateCond({ role: undefined, route_kind: undefined })} title={tr ? "Stop treating this condition's markers as telecom rooms (runs that home to them read broken)" : "Stop treating this condition's lines as cable routes (they leave the unlinked list; links stay)"} style={xBtn}>✕</button>
        </div>
        {!tr && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: "var(--ink-muted)" }} title="Trunk: shared pathway many runs ride (cable tray, a corridor run), traced once. Branch: one device out to the trunk. Each run's route LF splits by kind; the Report's Pathway table counts each segment once.">Kind</span>
            <select name="condition-route-kind" value={routeKindOf(c) || ""} style={sel}
              title="Trunk or branch — splits each run's route LF and feeds the Report's Pathway table"
              onChange={(e) => onUpdateCond({ route_kind: e.target.value || undefined })}>
              <option value="">Unspecified</option>
              {ROUTE_KINDS.map((k) => <option key={k} value={k}>{ROUTE_KIND_LABELS[k]}</option>)}
            </select>
          </div>
        )}
        <span style={{ color: "var(--ink-muted)", lineHeight: 1.45 }}>
          {tr
            ? "Each Count marker here is a TR a run homes to. Name it in the Runs panel (MDF, IDF-1) — the name is the marker's label."
            : routeKindOf(c) === "trunk"
              ? "Trace the shared pathway once here with Linear; every run that rides it lists the same segment. Any segment no linked run uses is listed as unlinked."
              : routeKindOf(c) === "branch"
                ? "Trace each device's run out to the trunk here with Linear, one segment per device. J-hooks: add a Linear material row here (per = hook spacing)."
                : "Trace each route segment here with Linear. Any segment no linked run uses is listed as unlinked."}
        </span>
      </div>
    );
  }

  if (!hasCableSetup(c)) {
    if (!countOk && !routeOk) return null;   // an area condition is never a cable condition
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 6, marginTop: 1, borderTop: "1px solid var(--ink-faint)" }}>
        <select name="condition-cable-optin" value=""
          title="Division 27: make this a cable device condition, a telecom-room condition, or a cable-route condition"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            if (v === "tr" || v === "route") { onUpdateCond({ role: v }); return; }
            if (v.startsWith("route:")) { onUpdateCond({ role: "route", route_kind: v.slice(6) }); return; }
            const d = CABLE_DEFAULTS[v];
            onUpdateCond({ cable_setup: mintCableSetup(v), ...(!(Number(c.waste_pct) > 0) && d.waste_pct != null ? { waste_pct: d.waste_pct } : {}) });
          }}
          style={{ padding: "3px 6px", borderRadius: 0, border: "1px dashed var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", fontSize: 11.5, cursor: "pointer" }}>
          <option value="">+ cable…</option>
          {countOk && <optgroup label="Device (pre-fills starting values)">
            {DEVICE_TYPES.map((t) => <option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>)}
          </optgroup>}
          {countOk && <option value="tr">Telecom room (TR)</option>}
          {routeOk && <option value="route">Cable route (linear)</option>}
          {routeOk && ROUTE_KINDS.map((k) => <option key={k} value={`route:${k}`}>Cable route: {k === "trunk" ? "trunk (shared pathway)" : "branch (device to trunk)"}</option>)}
        </select>
      </div>
    );
  }

  const cs = c.cable_setup;
  const problems = cableSetupProblems(cs);
  const bad = (k) => problems.some((p) => p.startsWith(k));
  const patch = (p) => onUpdateCond({ cable_setup: { ...cs, ...p } });
  // lengths stored in feet; metric converts on display only (lib/units)
  const shown = (ft) => (ft == null ? "" : r2(heightVal(ft, units)));
  const setFt = (k, raw) => patch({ [k]: raw === "" ? null : Math.max(0, heightInputToFeet(Number(raw) || 0, units)) });
  const hu = heightUnit(units);
  const tot = cableRows.reduce((t, r) => ({ ea: t.ea + r.ea, pulls: t.pulls + r.pulls, cables: t.cables + r.cables, lf: t.lf + r.cable_lf, order: t.order + r.cable_lf_order, unl: t.unl + r.unlinked_devices }), { ea: 0, pulls: 0, cables: 0, lf: 0, order: 0, unl: 0 });
  const isDefault = (k) => CABLE_DEFAULTS[cs.device_type]?.[k] != null && cs[k] === CABLE_DEFAULTS[cs.device_type][k];
  const anyDefault = ["vertical_ft", "loop_device_ft", "loop_tr_ft"].some(isDefault);
  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={cap} title="Division 27 cable setup — per cable LF = measured route + vertical + both loops">Cable</span>
        <select name="condition-cable-device-type" value={cs.device_type} style={sel}
          title="Device type — changing it re-fills the starting values (cables per location and cable type are kept)"
          onChange={(e) => onUpdateCond({ cable_setup: mintCableSetup(e.target.value, { cables_per_location: cs.cables_per_location, cable_type: cs.cable_type }) })}>
          {DEVICE_TYPES.map((t) => <option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>)}
        </select>
        <button onClick={() => onUpdateCond({ cable_setup: undefined })} title="Remove the cable setup (runs on this condition read broken; the markers stay)" style={xBtn}>✕</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink-muted)" }} title="Cables per pull — a run can override it">Cables/loc</span>
        <input name="condition-cable-per-location" type="number" min="1" step="1" value={cs.cables_per_location ?? ""} style={num(bad("cables_per_location"))}
          onChange={(e) => patch({ cables_per_location: e.target.value === "" ? null : Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
        <span style={{ color: "var(--ink-muted)" }} title="Free text — groups the cable summary (a part number, CAT6A)">Type</span>
        <input name="condition-cable-type" value={cs.cable_type || ""} placeholder="e.g. CAT6A" onChange={(e) => patch({ cable_type: e.target.value })}
          style={{ width: 96, padding: "3px 6px", borderRadius: 0, border: "1px solid var(--ink-faint)", fontSize: 12 }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <span style={{ color: "var(--ink-muted)" }} title="Vertical per cable — required; no silent default">Vertical</span>
        <input name="condition-cable-vertical" type="number" min="0" step="0.5" value={shown(cs.vertical_ft)} style={num(bad("vertical_ft"))} onChange={(e) => setFt("vertical_ft", e.target.value)} />
        <span style={{ color: "var(--ink-muted)" }} title="Service loop at the device end">Loop dev</span>
        <input name="condition-cable-loop-device" type="number" min="0" step="0.5" value={shown(cs.loop_device_ft)} style={num(bad("loop_device_ft"))} onChange={(e) => setFt("loop_device_ft", e.target.value)} />
        <span style={{ color: "var(--ink-muted)" }} title="Service loop at the TR end">Loop TR</span>
        <input name="condition-cable-loop-tr" type="number" min="0" step="0.5" value={shown(cs.loop_tr_ft)} style={num(bad("loop_tr_ft"))} onChange={(e) => setFt("loop_tr_ft", e.target.value)} />
        <span style={{ color: "var(--ink-muted)" }}>{hu}</span>
      </div>
      {problems.map((p) => (
        <div key={p} data-cable-problem style={{ color: "var(--c-danger)", lineHeight: 1.4 }}>Runs withheld: {fieldLabels(p)}.</div>
      ))}
      {!problems.length && anyDefault && (
        <div style={{ color: "var(--ink-muted)", lineHeight: 1.4 }}>Starting values for {DEVICE_TYPE_LABELS[cs.device_type]} — the project spec governs; edit any that differ.</div>
      )}
      {cableRows.length > 0 && (
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)" }}
          title="Pulls, cables and cable LF from linked runs (×N applied). Device EA beside pulls shows the unlinked gap.">
          {tot.ea} EA · {tot.pulls} pull{tot.pulls === 1 ? "" : "s"} · {tot.cables} cable{tot.cables === 1 ? "" : "s"} · {r2(lenVal(tot.lf, units))} {lenUnit(units)}
          {tot.unl > 0 && <span style={{ color: "var(--c-danger)" }}> · {tot.unl} unlinked</span>}
        </div>
      )}
    </div>
  );
}
