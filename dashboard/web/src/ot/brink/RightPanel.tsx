// The right panel: Conditions (the takeoff's conditions with their measured totals; pick
// the active one, add one), Inspector (the selected takeoff: what it measures, where it
// came from, whether a machine made it and whether its original is kept) and Edits (what
// this project's takeoff edit layer holds, and anything not saved). Upstream's own full
// quantities panel (materials, appearance, waste) is still there, toggled from the
// toolbar, restyled by design/ot-theme.css.
import { Badge, Button, Icon, PropertyList, SidePanel, TabList, TabPanel } from "../../design/index.js";
import { getHost, useHost, type OtShape } from "../host";
import { setSession, useSession, type RightTab } from "../session";

const TABS: { key: RightTab; label: string }[] = [
  { key: "conditions", label: "Conditions" },
  { key: "inspector", label: "Inspector" },
  { key: "edits", label: "Edits" },
];

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "");

/** A shape's own measured quantity, as upstream stores it (computed), in feet units (the report converts). */
export function measured(s: Pick<OtShape, "measure_role" | "computed">, units: "imperial" | "metric" = "imperial"): string {
  const c = s.computed ?? {};
  const m = units === "metric";
  switch (s.measure_role) {
    case "count":
      return `${fmt(c.count ?? 0, 0)} EA`;
    case "linear":
      return m ? `${fmt((c.perimeter_lf ?? 0) * 0.3048)} m` : `${fmt(c.perimeter_lf ?? 0)} LF`;
    default:
      return m ? `${fmt((c.area_sf ?? 0) * 0.09290304)} m²` : `${fmt(c.area_sf ?? 0)} SF`;
  }
}

function Conditions() {
  const v = useHost(
    (h) => {
      const sum = new Map<string, { n: number; ea: number; lf: number; sf: number }>();
      for (const s of h.shapes) {
        const t = sum.get(s.condition_id) ?? { n: 0, ea: 0, lf: 0, sf: 0 };
        const c = s.computed ?? {};
        t.n++;
        if (s.measure_role === "count") t.ea += c.count ?? 0;
        else if (s.measure_role === "linear") t.lf += c.perimeter_lf ?? 0;
        else if (s.measure_role === "deduct") t.sf -= c.area_sf ?? 0;
        else t.sf += c.area_sf ?? 0;
        sum.set(s.condition_id, t);
      }
      return {
        json: JSON.stringify(h.conditions.map((c) => ({ id: c.id, tag: c.finish_tag, color: typeof c.color === "string" ? c.color : "#6B7884", ...(sum.get(c.id) ?? { n: 0, ea: 0, lf: 0, sf: 0 }) }))),
        active: h.activeCond,
        metric: h.units === "metric",
      };
    },
    { json: "[]", active: "", metric: false },
  );
  const rows = JSON.parse(v.json) as { id: string; tag: string; color: string; n: number; ea: number; lf: number; sf: number }[];
  const qty = (r: (typeof rows)[number]) =>
    [r.ea ? `${fmt(r.ea, 0)} EA` : "", r.lf ? (v.metric ? `${fmt(r.lf * 0.3048)} m` : `${fmt(r.lf)} LF`) : "", r.sf ? (v.metric ? `${fmt(r.sf * 0.09290304)} m²` : `${fmt(r.sf)} SF`) : ""].filter(Boolean).join(" · ") || "nothing measured";
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Button size="sm" icon="plus" onClick={() => getHost()?.addCondition()} data-action="add-condition">
          Add condition
        </Button>
        <Button size="sm" variant="quiet" icon="quantities" className="ml-auto" onClick={() => getHost()?.toggleTakeoffs()} title="Open the full quantities panel: materials, waste, appearance">
          Details
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 p-4 text-center text-sm text-ink-3">No conditions yet.</p>
      ) : (
        <ul className="m-0 list-none p-0" data-condition-list>
          {rows.map((r) => {
            const on = r.id === v.active;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  data-condition={r.tag}
                  onClick={() => getHost()?.activateCondition(r.id, { reassign: false })}
                  className={`bk-focus flex w-full cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 text-left ${on ? "bg-accent-soft" : "hover:bg-hover"}`}
                >
                  {/* the condition's own colour: takeoff data, kept as the estimator set it */}
                  <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rounded-[2px] border border-line-strong" style={{ background: r.color }} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${on ? "font-bold text-ink" : "font-medium text-ink"}`}>{r.tag}</span>
                    <span className="num block truncate text-xs text-ink-3" data-condition-qty>
                      {qty(r)}
                    </span>
                  </span>
                  <span className="num shrink-0 text-xs text-ink-3" title={`${r.n} takeoff${r.n === 1 ? "" : "s"}`}>
                    {r.n}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 px-3 py-2 text-xs text-ink-3">Measured quantities, before multipliers and waste. The BOM applies them.</p>
    </div>
  );
}

const who = (o: Record<string, unknown> | undefined): string => {
  if (!o) return "A person (no provenance recorded)";
  const actor = o.actor === "agent" ? "An agent" : "A person";
  const method = typeof o.method === "string" ? o.method.replace(/_/g, " ") : "manual";
  return `${actor}, ${method}`;
};

function Inspector() {
  const v = useHost((h) => ({ shape: h.selShape ? JSON.stringify(h.selShape) : "", conds: JSON.stringify(Object.fromEntries(h.conditions.map((c) => [c.id, c.finish_tag]))), units: h.units, label: h.selShape ? h.tabLabel(h.selShape.sheet_id) : "" }), {
    shape: "",
    conds: "{}",
    units: "imperial" as const,
    label: "",
  });
  if (!v.shape) {
    return (
      <div className="p-4 text-sm text-ink-3" data-inspector-empty>
        <Icon name="pointer" size={20} className="mb-2 text-ink-3" />
        <p className="m-0">Select a takeoff on the plan to see it here (Select tool, V).</p>
      </div>
    );
  }
  const s = JSON.parse(v.shape) as OtShape;
  const tags = JSON.parse(v.conds) as Record<string, string>;
  const o = s.origin as Record<string, unknown> | undefined;
  const machine = !!o && (o.actor === "agent" || (typeof o.method === "string" && o.method !== "manual"));
  const kept = !!o?.proposed_verts_norm;
  return (
    <div className="p-3" data-inspector={s.id}>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-lg font-bold">{tags[s.condition_id] ?? s.condition_id}</span>
        <Badge tone="neutral">{s.measure_role.replace(/_/g, " ")}</Badge>
        {machine && <Badge tone={o?.reviewed === true ? "ok" : "warn"}>{o?.reviewed === true ? "accepted" : "not reviewed"}</Badge>}
      </div>
      <PropertyList
        rows={[
          ["Quantity", <span className="num">{measured(s, v.units)}</span>],
          ["Sheet", v.label || s.sheet_id],
          ...(s.label ? ([["Label", s.label]] as [string, string][]) : []),
          ["Made by", who(o)],
          ...(machine ? ([["Machine original", kept ? "kept (the original ring is stored with it)" : o?.edited ? "edited" : "unchanged"]] as [string, string][]) : []),
          ...(s.author ? ([["Author", s.author]] as [string, string][]) : []),
          ...(s.updated_by ? ([["Last edit", `${s.updated_by}${s.updated_at ? `, ${new Date(s.updated_at).toLocaleString()}` : ""}`]] as [string, string][]) : []),
          ["Id", <span className="font-num text-xs">{s.id}</span>],
        ]}
      />
      {machine && (
        <p className="mt-3 mb-0 text-xs text-ink-3">
          A machine made this takeoff. Your edits are saved as edits over it; the machine&apos;s original stays in the import. Only a person can accept it.
        </p>
      )}
    </div>
  );
}

function Edits() {
  const { status } = useSession();
  if (!status) return null;
  return (
    <div className="p-3 text-sm" data-edits-panel>
      <PropertyList
        rows={[
          ["Editing as", status.editor ?? "nobody (changes are not saved)"],
          ["Saved here", <span className="num">{status.saved}</span>],
          ["Last save", status.savedAt ? new Date(status.savedAt).toLocaleTimeString() : "not yet"],
          ["Import", <span className="font-num text-xs">{status.importId ?? ""}</span>],
        ]}
      />
      <p className="mt-3 mb-2 text-xs text-ink-3">
        Saved here: shapes added, moved, reshaped or deleted, conditions, sheet scales. Each save rebuilds the BOM and the schematic. Markups, RFIs and approval stamps stay in this tab.
      </p>
      {status.unsupported.length > 0 && (
        <div className="mb-2 rounded-ctl border border-line p-2" data-unsupported={status.unsupported.length}>
          <p className="m-0 mb-1 text-xs font-medium text-warn">Not saved (kept in this tab only)</p>
          <ul className="m-0 pl-4 text-xs text-ink-2">
            {status.unsupported.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {status.refused.length > 0 && (
        <div className="mb-2 rounded-ctl border border-line p-2">
          <p className="m-0 mb-1 text-xs font-medium text-danger">Refused by the server</p>
          <ul className="m-0 pl-4 text-xs text-ink-2">
            {status.refused.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {status.issues.length > 0 && (
        <div className="rounded-ctl border border-line p-2" data-layer-issues={status.issues.length}>
          <p className="m-0 mb-1 text-xs font-medium text-warn">Edits this import carries with a warning</p>
          <ul className="m-0 pl-4 text-xs text-ink-2">
            {status.issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function RightPanel() {
  const { rightTab } = useSession();
  return (
    <SidePanel
      title="Takeoff"
      side="right"
      width={300}
      id="ot-right"
      onClose={() => setSession({ right: false })}
      tabs={<TabList tabs={TABS} value={rightTab} onChange={(k) => setSession({ rightTab: k })} label="Takeoff panels" compact idBase="ot-right" />}
    >
      <TabPanel idBase="ot-right" k={rightTab}>
        {rightTab === "conditions" ? <Conditions /> : rightTab === "inspector" ? <Inspector /> : <Edits />}
      </TabPanel>
    </SidePanel>
  );
}
