// In-app Report: the Cable summary table and the Unlinked list (Division 27,
// docs/design/CABLE_SETUP.md, "Report and export output"). The cells are the
// SAME matrix the CSV section and the workbook tab print (lib/cable.js
// cableTables), so the screen and the files can never disagree. Each unlinked
// item carries a Show button that closes the Report and puts it on screen.
// Rendered only when a cable takeoff exists.
import { cableTables } from "../lib/cable.js";
import { lenVal, lenUnit } from "../lib/units";

const H3 = { fontFamily: "var(--f-display)", fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink)", margin: "0 0 10px", paddingBottom: 5, borderBottom: "1.25px solid var(--ink)" };
const cell = { padding: "4px 6px", borderBottom: "1px solid var(--paper-cream)", fontSize: 11.5, whiteSpace: "nowrap" };
const r2 = (v) => Math.round(v * 100) / 100;

/** @param {{ takeoff: any, units?: string, sheetLabel?: (k: string) => string, onLocate?: (shapeId: string) => void }} props */
export default function CableReportSection({ takeoff, units = "imperial", sheetLabel = null, onLocate = null }) {
  if (!takeoff) return null;
  const M = units === "metric";
  const t = cableTables(takeoff, { sheetLabel, L: (v) => r2(lenVal(v, units)), lengthUnit: M ? "m" : "LF" });
  const [head, ...body] = t.summary;
  const numeric = (v) => typeof v === "number";
  const { devices, routes } = takeoff.resolved.unlinked;
  const held = takeoff.resolved.held || [];
  const label = (k) => (sheetLabel ? sheetLabel(k) : k);
  return (
    <div style={{ maxWidth: 980, margin: "26px auto 0", color: "var(--ink)" }} data-cable-report>
      <h3 style={H3}>Cable summary</h3>
      {t.warnings.map((w) => <p key={w} style={{ margin: "0 0 8px", color: "#b66b00", fontSize: 11.5 }}>{w}</p>)}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
          <thead>
            <tr>{head.map((h) => <th key={h} style={{ ...cell, textAlign: "left", fontSize: 10.5, color: "var(--ink-muted)", fontWeight: 600 }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((row, i) => {
              const sub = typeof row[0] === "string" && (row[0].startsWith("Subtotal") || row[0] === "TOTAL");
              return (
                <tr key={i} style={sub ? { background: "var(--paper-cream)", fontWeight: row[0] === "TOTAL" ? 700 : 500 } : undefined}>
                  {row.map((v, j) => <td key={j} style={{ ...cell, textAlign: numeric(v) ? "right" : "left", fontFamily: numeric(v) ? "var(--f-mono)" : undefined, color: j === 12 && v > 0 ? "var(--c-danger)" : undefined }}>{v}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.5 }}>
        Pulls, cables and cable LF come only from linked runs: measured route + the vertical (the condition's, or a run's own) and the service loops, × cables. Device EA beside Pulls shows the gap, which is exactly the unlinked plus held devices. Pending runs are counted, like pending shapes. Waste applies only to the order column; ×N applies across the row.
      </p>
      {t.pathway && (
        <div style={{ marginTop: 14 }} data-cable-report-pathway>
          <h3 style={{ ...H3, fontSize: 11 }}>Pathway — each segment counted once</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)" }}>
              <thead>
                <tr>{t.pathway[0].map((h) => <th key={h} style={{ ...cell, textAlign: "left", fontSize: 10.5, color: "var(--ink-muted)", fontWeight: 600 }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {t.pathway.slice(1).map((row, i) => {
                  const sub = typeof row[0] === "string" && (row[0].startsWith("Subtotal") || row[0] === "TOTAL");
                  return (
                    <tr key={i} style={sub ? { background: "var(--paper-cream)", fontWeight: row[0] === "TOTAL" ? 700 : 500 } : undefined}>
                      {row.map((v, j) => <td key={j} style={{ ...cell, textAlign: numeric(v) ? "right" : "left", fontFamily: numeric(v) ? "var(--f-mono)" : undefined }}>{v}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.5 }}>
            The pathway itself, not the cable in it: a trunk that ten runs ride is counted once here and once per run in the cable figures above. Buy J-hooks from a Linear material row on the branch condition (per = hook spacing); its basis is that condition's LF ×N, each segment once.
          </p>
        </div>
      )}
      {held.length > 0 && (
        <div style={{ marginTop: 14 }} data-cable-report-held>
          <h3 style={{ ...H3, fontSize: 11 }}>Held — no run by decision, excluded from totals</h3>
          {held.map((d) => (
            <div key={d.shape_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--paper-cream)", fontSize: 11.5 }}>
              <span style={{ width: 52, color: "var(--ink-muted)" }}>Device</span>
              <span style={{ fontFamily: "var(--f-mono)" }}>{d.finish_tag}{d.label ? ` · ${d.label}` : ""}</span>
              <span style={{ color: "var(--ink-muted)" }}>{label(d.sheet_id)}</span>
              <span style={{ flex: 1, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.reason}>{d.reason}</span>
              {onLocate && <button onClick={() => onLocate(d.shape_id)} title="Close the Report and put this on screen"
                style={{ padding: "1px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11 }}>Show</button>}
            </div>
          ))}
        </div>
      )}
      {(devices.length > 0 || routes.length > 0) && (
        <div style={{ marginTop: 14 }} data-cable-report-unlinked>
          <h3 style={{ ...H3, fontSize: 11 }}>Unlinked — excluded from totals</h3>
          {[...devices.map((d) => ({ kind: "Device", id: d.shape_id, what: `${d.finish_tag}${d.label ? ` · ${d.label}` : ""}`, sheet: d.sheet_id, reason: d.reason })),
            ...routes.map((r) => ({ kind: "Route", id: r.shape_id, what: `${r.finish_tag} · ${r.length_lf == null ? "—" : `${r2(lenVal(r.length_lf, units))} ${lenUnit(units)}`}`, sheet: r.sheet_id, reason: r.reason }))].map((u) => (
            <div key={u.kind + u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--paper-cream)", fontSize: 11.5 }}>
              <span style={{ width: 52, color: "var(--ink-muted)" }}>{u.kind}</span>
              <span style={{ fontFamily: "var(--f-mono)" }}>{u.what}</span>
              <span style={{ color: "var(--ink-muted)" }}>{label(u.sheet)}</span>
              <span style={{ flex: 1, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.reason}>{u.reason}</span>
              {onLocate && <button onClick={() => onLocate(u.id)} title="Close the Report and put this on screen"
                style={{ padding: "1px 8px", borderRadius: 0, border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 11 }}>Show</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
