// Task 2: roll a takeoff up by condition. Quantities come from each shape's
// stored `computed` block, never from geometry. For a linear shape
// perimeter_lf is the total length including any rise/drop legs (plan_lf +
// vertical_lf); that is pathway or conduit footage, not cable: cable length
// comes from OpenTakeoff's per-run cable math (cable.ts).
import type { OtCondition, OtTakeoff } from "./ot/types.js";

export type ConditionKind = "device" | "tr" | "route" | "plain";

export interface Quantities {
  count: number;
  linearLf: number;
  areaSf: number;
}

export interface ConditionRollup {
  conditionId: string;
  finishTag: string;
  kind: ConditionKind;
  multiplier: number;
  wastePct: number;
  shapeCount: number;
  /** Measured, as stored: no multiplier, no waste. */
  measured: Quantities & { planLf: number; verticalLf: number; deductSf: number };
  /** measured x multiplier (OpenTakeoff's report EA / LF / SF). */
  net: Quantities;
  /** net x (1 + waste %): the order quantity. Waste never touches the measured numbers. */
  order: Quantities;
  /** Count shapes by their label (room / zone / TR name); "" when unlabeled. */
  countByLabel: Record<string, number>;
  shapeIds: string[];
}

export function conditionKind(c: OtCondition): ConditionKind {
  if (c.cable_setup && typeof c.cable_setup.device_type === "string" && c.cable_setup.device_type) return "device";
  if (c.role === "tr") return "tr";
  if (c.role === "route") return "route";
  return "plain";
}

/** Round to 0.01, the precision OpenTakeoff stores lengths at. */
export const r2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

const scale = (q: Quantities, k: number): Quantities => ({ count: r2(q.count * k), linearLf: r2(q.linearLf * k), areaSf: r2(q.areaSf * k) });

export function rollup(takeoff: OtTakeoff): ConditionRollup[] {
  const byCondition = new Map<string, ConditionRollup>();
  for (const c of takeoff.conditions) {
    byCondition.set(c.id, {
      conditionId: c.id,
      finishTag: c.finish_tag,
      kind: conditionKind(c),
      multiplier: Number.isFinite(c.multiplier) && c.multiplier! > 0 ? c.multiplier! : 1,
      wastePct: Number.isFinite(c.waste_pct) ? c.waste_pct! : 0,
      shapeCount: 0,
      measured: { count: 0, linearLf: 0, areaSf: 0, planLf: 0, verticalLf: 0, deductSf: 0 },
      net: { count: 0, linearLf: 0, areaSf: 0 },
      order: { count: 0, linearLf: 0, areaSf: 0 },
      countByLabel: {},
      shapeIds: [],
    });
  }
  for (const s of takeoff.shapes) {
    const r = byCondition.get(s.condition_id);
    if (!r) throw new Error(`shape ${s.id} references condition ${s.condition_id}, which the export does not define`);
    const q = s.computed ?? {};
    const m = r.measured;
    r.shapeCount++;
    r.shapeIds.push(s.id);
    switch (s.measure_role) {
      case "count": {
        const n = q.count ?? 0;
        m.count += n;
        const label = s.label ?? "";
        r.countByLabel[label] = (r.countByLabel[label] ?? 0) + n;
        break;
      }
      case "linear":
        m.linearLf += q.perimeter_lf ?? 0;
        m.planLf += q.plan_lf ?? q.perimeter_lf ?? 0;
        m.verticalLf += q.vertical_lf ?? 0;
        break;
      case "floor_area":
      case "surface_area":
        m.areaSf += q.area_sf ?? 0;
        break;
      case "deduct":
        m.deductSf += q.area_sf ?? 0;
        break;
    }
  }
  for (const r of byCondition.values()) {
    const m = r.measured;
    for (const k of ["count", "linearLf", "areaSf", "planLf", "verticalLf", "deductSf"] as const) m[k] = r2(m[k]);
    const measuredNet: Quantities = { count: m.count, linearLf: m.linearLf, areaSf: r2(m.areaSf - m.deductSf) };
    r.net = scale(measuredNet, r.multiplier);
    r.order = scale(r.net, 1 + r.wastePct / 100);
  }
  return [...byCondition.values()];
}
