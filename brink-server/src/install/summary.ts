// Small views of an install design for tool replies and the phone page.
import type { InstallDesign, InstallIssue } from "../installTypes.ts";
import { panelTags, rackPower } from "./check.ts";

export function issueBrief(issues: InstallIssue[], max = 30) {
  const errors = issues.filter((i) => i.severity === "error").length;
  return {
    errors,
    warnings: issues.length - errors,
    items: issues.slice(0, max).map((i) => `${i.severity} ${i.code}: ${i.message}`),
    ...(issues.length > max ? { more: issues.length - max } : {}),
  };
}

export function rackBrief(design: InstallDesign) {
  const panels = panelTags(design);
  return design.racks.map((r) => {
    const pw = rackPower(design, r);
    return {
      id: r.id, name: r.name, location: r.location, sizeRU: r.sizeRU, ...(r.model ? { model: r.model } : {}),
      items: [...r.items].sort((a, b) => b.ruTop - a.ruTop).map((it) => `RU ${it.ruTop - it.ruHeight + 1}${it.ruHeight > 1 ? `-${it.ruTop}` : ""}: ${it.tag} (${it.kind}${it.label ? `, ${it.label}` : ""})`),
      cables: design.cables.filter((c) => c.from.rack === r.id).length,
      panels: design.equipment.filter((e) => e.rack === r.id && panels.has(e.tag)).map((e) => `${e.tag} ${e.ports.length}-port`),
      power: { watts: pw.watts, unknown: pw.unknown.filter((t) => !panels.has(t)), capacityW: pw.capacityW, btuHr: pw.btuHr },
      ...(r.circuits?.length ? { circuits: r.circuits } : {}),
      ...(r.fanCfm != null ? { fanCfm: r.fanCfm } : {}),
    };
  });
}

export function designSummary(design: InstallDesign) {
  const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => { const k = key(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const lengths = design.cables.map((c) => c.lengthFt).filter((n): n is number => typeof n === "number");
  return {
    project: design.project,
    revision: design.revision,
    created: design.created,
    status: design.status,
    ...(design.approved ? { approved: design.approved } : {}),
    ...(design.bidRevision !== undefined ? { bidRevision: design.bidRevision } : {}),
    labelScheme: { source: design.labelScheme.source, pattern: design.labelScheme.pattern, description: design.labelScheme.description, ...(design.labelScheme.reference ? { reference: design.labelScheme.reference } : {}) },
    counts: {
      devices: design.devices.length, cables: design.cables.length, racks: design.racks.length,
      equipment: design.equipment.length, connections: design.connections.length, mounting: design.mounting.length,
    },
    devicesByType: count(design.devices, (d) => d.deviceType),
    cablesByKind: count(design.cables, (c) => c.kind),
    cableFt: { measured: Math.round(lengths.reduce((a, b) => a + b, 0) * 10) / 10, longest: lengths.length ? Math.max(...lengths) : null, unmeasured: design.cables.length - lengths.length },
    mounting: design.mounting.map((m) => `${m.deviceType}: ${m.heightAff || "(height not set)"}`),
  };
}
