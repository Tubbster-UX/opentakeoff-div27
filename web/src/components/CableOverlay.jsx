// Cable overlay (Division 27, docs/design/CABLE_SETUP.md, Canvas UI §3 and §5)
// — drawn per sheet inside the canvas's SVG group, after the committed shapes:
//   • unlinked device markers get an amber dashed ring, unlinked route
//     segments an amber halo, so they are caught before export (linked routes
//     already draw in their condition color); a HELD device (no run by
//     decision) gets a quiet grey ring instead — seen, not alarming;
//   • every TR marker prints its name beside it;
//   • while the Link Run tool is armed, the draft's device, its segments
//     (numbered in order) and its TR are highlighted in cobalt.
// Inert drawing (pointer-events none). Strokes are divided by the zoom like
// every other screen-constant size on the stage. SVG attributes take literal
// colors (CSS vars do not resolve there) — cobalt and the warning amber.
const COBALT = "#1f3fc7";
const AMBER = "#d97706";

/**
 * @param {{ panelKey: string, img: { w: number, h: number }, z: number, shapes: any[],
 *   takeoff: any, draft?: { device: string|null, routes: string[], tr: string|null } | null,
 *   trConds: Set<string>, dark?: boolean }} props
 */
export default function CableOverlay({ panelKey, img, z, shapes, takeoff, draft = null, trConds, dark = false }) {
  if (!img?.w || (!takeoff && !draft)) return null;
  const onPanel = (shapes || []).filter((s) => s.sheet_id === panelKey);
  if (!onPanel.length) return null;
  const byId = new Map(onPanel.map((s) => [s.id, s]));
  const dn = (vn) => vn.map(([x, y]) => [x * img.w, y * img.h]);
  const unlinkedDev = new Set((takeoff?.resolved?.unlinked?.devices || []).map((d) => d.shape_id));
  const unlinkedRoute = new Set((takeoff?.resolved?.unlinked?.routes || []).map((r) => r.shape_id));
  const heldDev = new Set((takeoff?.resolved?.held || []).map((d) => d.shape_id));
  const ink = dark ? "#f3f1ea" : "#1c1a17";
  const out = [];

  for (const s of onPanel) {
    if (s.measure_role === "count" && unlinkedDev.has(s.id)) {
      const [cx, cy] = dn(s.verts_norm)[0];
      out.push(<circle key={"ud" + s.id} data-cable-cue="unlinked-device" cx={cx} cy={cy} r={13 / z} fill="none" stroke={AMBER} strokeWidth={2 / z} strokeDasharray={`${3 / z} ${2.5 / z}`} />);
    } else if (s.measure_role === "count" && heldDev.has(s.id)) {
      const [cx, cy] = dn(s.verts_norm)[0];
      out.push(<circle key={"hd" + s.id} data-cable-cue="held-device" cx={cx} cy={cy} r={13 / z} fill="none" stroke={dark ? "#9a968c" : "#6b675e"} strokeWidth={1.5 / z} strokeDasharray={`${1 / z} ${3 / z}`} strokeLinecap="round" />);
    } else if (s.measure_role === "linear" && unlinkedRoute.has(s.id)) {
      out.push(<polyline key={"ur" + s.id} data-cable-cue="unlinked-route" points={dn(s.verts_norm).map((q) => q.join(",")).join(" ")} fill="none" stroke={AMBER} strokeOpacity={0.45} strokeWidth={9 / z} strokeLinecap="round" strokeLinejoin="round" />);
    }
    if (s.measure_role === "count" && trConds?.has(s.condition_id)) {
      const [cx, cy] = dn(s.verts_norm)[0];
      const name = s.label || "TR?";
      out.push(
        <g key={"tr" + s.id} data-cable-cue="tr">
          <circle cx={cx} cy={cy} r={11 / z} fill="none" stroke={ink} strokeWidth={1.5 / z} />
          <text x={cx + 14 / z} y={cy + 4 / z} fontSize={12 / z} fontWeight={700} fill={s.label ? ink : AMBER} stroke={dark ? "#000" : "#fff"} strokeWidth={3 / z} paintOrder="stroke">{name}</text>
        </g>,
      );
    }
  }

  if (draft) {
    draft.routes.forEach((id, i) => {
      const s = byId.get(id);
      if (!s) return;
      const pts = dn(s.verts_norm);
      const mid = pts[Math.floor((pts.length - 1) / 2)];
      const nxt = pts[Math.min(pts.length - 1, Math.floor((pts.length - 1) / 2) + 1)];
      const mx = (mid[0] + nxt[0]) / 2, my = (mid[1] + nxt[1]) / 2;
      out.push(
        <g key={"dr" + id} data-cable-draft="route">
          <polyline points={pts.map((q) => q.join(",")).join(" ")} fill="none" stroke={COBALT} strokeOpacity={0.55} strokeWidth={8 / z} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={mx} cy={my} r={9 / z} fill={COBALT} />
          <text x={mx} y={my + 4 / z} fontSize={11 / z} fontWeight={700} fill="#fff" textAnchor="middle">{i + 1}</text>
        </g>,
      );
    });
    for (const [id, kind] of [[draft.device, "device"], [draft.tr, "tr"]]) {
      const s = id ? byId.get(id) : null;
      if (!s) continue;
      const [cx, cy] = dn(s.verts_norm)[0];
      out.push(<circle key={"dd" + kind} data-cable-draft={kind} cx={cx} cy={cy} r={15 / z} fill={COBALT + "22"} stroke={COBALT} strokeWidth={3 / z} />);
    }
  }
  return out.length ? <g style={{ pointerEvents: "none" }}>{out}</g> : null;
}
