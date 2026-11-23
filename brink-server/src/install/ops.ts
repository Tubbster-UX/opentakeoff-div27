// update_install_design's operations (src/installTools.ts), applied to a copy
// of the design: all or nothing, every op validated before anything is saved.
// Lengths are never an op: they come only from the takeoff's measured routes.
import { z } from "zod";
import type { CableKind, EquipmentLibrary, EquipmentPort, InstallDesign, InstallEquipment, RackItem } from "../installTypes.ts";
import { CABLE_KINDS, DEFAULT_TYPE_LETTERS, validateLabelScheme } from "./labels.ts";
import { panelTags, portUseKey } from "./check.ts";
import { refreshDesign } from "./baseline.ts";
import { expandPortGroups, lookupEquipment, type PortGroup } from "../equipmentLib.ts";

const s = (d: string) => z.string().trim().min(1).describe(d);
const portRef = z.object({ equipment: s("Equipment tag"), port: s("Port id on it, e.g. \"p12\"") });
export const portSchema = z.object({
  id: s("Stable id, e.g. \"p12\", \"zone1L\""),
  label: z.string().optional().describe("As printed on the gear, e.g. \"PORT 12\""),
  signal: s("ethernet, hdmi, speaker, line-audio, fiber, rs232, ir, relay, power, ..."),
  connector: z.string().optional(),
  direction: z.enum(["in", "out", "bidir"]).optional(),
  poe: z.boolean().optional(),
});
export const portGroupSchema = z.object({
  prefix: s("Id prefix, e.g. \"p\" gives p1, p2, ..."),
  count: z.number().int().min(1).max(512),
  label: z.string().optional().describe("\"{n}\" is the number, e.g. \"PORT {n}\""),
  signal: s("ethernet, hdmi, speaker, fiber, ..."),
  connector: z.string().optional(),
  direction: z.enum(["in", "out", "bidir"]).optional(),
  poe: z.boolean().optional(),
  start: z.number().int().min(0).optional(),
});
const letters = z.object(Object.fromEntries(CABLE_KINDS.map((k) => [k, z.string().optional()])) as Record<CableKind, z.ZodOptional<z.ZodString>>);
const optStr = z.string().nullable().optional();

export const installOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_label_scheme"),
    pattern: s("Tokens {type} {seq} {seq:2} {rack} {tr} {panel} {port} {port:2} {device} {room}, e.g. \"{tr}{panel}-{port:2}\""),
    source: z.enum(["spec", "default"]).describe("\"spec\" when the job's labeling section says it (then reference is required)"),
    reference: z.string().optional().describe("The clause, e.g. \"27 05 53 3.2.B\""),
    description: s("Plain words for the crew, e.g. \"TR + panel letter + port, e.g. 1A-07\""),
    typeLetters: letters.optional().describe("Letter per cable kind for {type} (defaults D V F S A C X P Z)"),
  }),
  z.object({
    op: z.literal("set_device"),
    tag: s("The device's current tag"),
    newTag: z.string().trim().min(1).optional().describe("Rename: cables and connections follow"),
    room: optStr, manufacturer: optStr, model: optStr, mounting: optStr, mountingHeight: optStr, notes: optStr,
    ofe: z.boolean().nullable().optional().describe("Owner-furnished: install / terminate only"),
  }),
  z.object({
    op: z.literal("set_cable"),
    label: s("The cable's current label"),
    newLabel: z.string().trim().min(1).nullable().optional().describe("A hand-set label (kept through relabeling); null returns it to the scheme"),
    spare: z.boolean().optional(),
    notes: optStr,
    lengthFt: z.unknown().optional().describe("Not allowed: lengths come only from the takeoff"),
  }),
  z.object({
    op: z.literal("add_equipment"),
    tag: s("Unique tag, e.g. \"SW-01\", \"AMP-01\""),
    key: z.string().optional().describe("Equipment library key (manufacturer:model) from find_equipment"),
    description: z.string().optional(),
    manufacturer: z.string().optional(),
    model: z.string().optional(),
    ports: z.array(portSchema).optional(),
    portGroups: z.array(portGroupSchema).optional(),
    watts: z.number().min(0).nullable().optional(),
    location: z.string().optional().describe("Room, for gear that is not rack-mounted"),
    ofe: z.boolean().optional(),
  }),
  z.object({ op: z.literal("remove_equipment"), tag: s("Equipment tag, or the tag of a manager / blank / shelf / vent rack item") }),
  z.object({
    op: z.literal("place_in_rack"),
    tag: s("Equipment tag (or a new label for a manager / blank / shelf / vent)"),
    rack: s("Rack id, e.g. \"RK-101\""),
    ruTop: z.number().int().min(1).max(60).describe("Topmost RU it occupies (RU 1 at the bottom)"),
    ruHeight: z.number().int().min(1).max(60).optional().describe("Default: the equipment library's RU height"),
    kind: z.enum(["manager", "shelf", "blank", "vent"]).optional().describe("For a non-equipment item"),
    label: z.string().optional(),
  }),
  z.object({
    op: z.literal("set_rack"),
    rack: s("Rack id"),
    name: z.string().optional(), model: z.string().optional(), location: z.string().optional(),
    sizeRU: z.number().int().min(1).max(60).optional().describe("From the drawings, the spec or the rack's model; setting it on a new rack moves its stack to the top"),
    circuits: z.array(z.object({ label: s("e.g. \"20A dedicated\""), amps: z.number().positive(), volts: z.number().positive().optional() })).optional().describe("Replaces the list (from the electrical drawings)"),
    fanCfm: z.number().min(0).nullable().optional(),
  }),
  z.object({
    op: z.literal("connect"),
    from: portRef, to: portRef,
    kind: z.enum(["patch", "wireless", ...CABLE_KINDS] as [string, ...string[]]).optional().describe("Default \"patch\""),
    notes: z.string().optional(),
  }),
  z.object({ op: z.literal("disconnect"), id: z.string().optional(), equipment: z.string().optional(), port: z.string().optional() }),
  z.object({ op: z.literal("assign_port"), cable: s("Cable label"), panel: s("Equipment tag in the same rack"), port: s("Port id, e.g. \"p7\"") }),
  z.object({
    op: z.literal("set_mounting"),
    deviceType: s("Device type as the design lists it, e.g. \"wall_outlet\""),
    title: z.string().optional(),
    heightAff: z.string().optional().describe("From the spec or the drawing legend, e.g. \"18 in. AFF to center\""),
    box: z.string().optional(),
    notes: z.array(z.string()).optional(),
    basis: z.string().optional().describe("Spec clause or drawing note"),
  }),
]);
export type InstallOp = z.infer<typeof installOpSchema>;

export class OpError extends Error {}

const TAG = /^[A-Za-z0-9][A-Za-z0-9 ._/#()-]{0,31}$/;

/** Apply ops to a copy of the design; returns the refreshed copy and one line per change. Throws OpError naming the op. */
export function applyInstallOps(design: InstallDesign, ops: InstallOp[], library: EquipmentLibrary): { design: InstallDesign; changes: string[]; warnings: string[] } {
  const d = structuredClone(design);
  const changes: string[] = [];
  const warnings: string[] = [];
  ops.forEach((op, n) => {
    try {
      changes.push(applyOne(d, op, library, warnings));
    } catch (e) {
      throw new OpError(`ops[${n}] (${op.op}): ${e instanceof Error ? e.message : String(e)}. Nothing was saved.`);
    }
  });
  refreshDesign(d);
  return { design: d, changes, warnings };
}

function applyOne(d: InstallDesign, op: InstallOp, library: EquipmentLibrary, warnings: string[]): string {
  const device = (tag: string) => d.devices.find((x) => x.tag === tag) ?? d.devices.find((x) => x.tag.toLowerCase() === tag.toLowerCase()) ?? fail(`no device ${tag}`);
  const equipment = (tag: string) => d.equipment.find((x) => x.tag === tag) ?? fail(`no equipment ${tag} (get_install_design part "equipment" lists them)`);
  const rack = (id: string) => d.racks.find((x) => x.id === id) ?? d.racks.find((x) => x.id.toLowerCase() === id.toLowerCase()) ?? fail(`no rack ${id}`);
  const cable = (label: string) => d.cables.find((x) => x.label === label) ?? fail(`no cable labeled ${label}`);
  const tagFree = (tag: string, except?: string) => {
    if (!TAG.test(tag)) fail(`${JSON.stringify(tag)} is not a usable tag (letters, digits, - . / #, up to 32 characters)`);
    const clash = d.devices.some((x) => x.tag === tag && x.tag !== except) || d.equipment.some((x) => x.tag === tag && x.tag !== except) || d.racks.some((r) => r.id === tag);
    if (clash) fail(`tag ${tag} is already used`);
  };
  const setOpt = (obj: Record<string, unknown>, k: string, v: unknown) => {
    if (v === undefined) return;
    if (v === null || v === "") delete obj[k];
    else obj[k] = typeof v === "string" ? v.trim() : v;
  };
  const deviceTags = new Set(d.devices.map((x) => x.tag));

  switch (op.op) {
    case "set_label_scheme": {
      const typeLetters = { ...DEFAULT_TYPE_LETTERS, ...d.labelScheme.typeLetters, ...Object.fromEntries(Object.entries(op.typeLetters ?? {}).filter(([, v]) => v !== undefined)) } as Record<CableKind, string>;
      const p = validateLabelScheme({ pattern: op.pattern, typeLetters });
      if (p.errors.length) fail(p.errors.join("; "));
      if (op.source === "spec" && !op.reference?.trim()) fail("a scheme from the spec needs its reference (the labeling clause, e.g. \"27 05 53 3.2.B\")");
      d.labelScheme = { source: op.source, ...(op.reference?.trim() ? { reference: op.reference.trim() } : {}), description: op.description, pattern: op.pattern, typeLetters };
      warnings.push(...p.warnings.map((w) => `label scheme: ${w}`));
      return `label scheme ${op.pattern} (${op.source}${op.reference ? `, ${op.reference}` : ""}); every cable relabeled`;
    }
    case "set_device": {
      const dev = device(op.tag);
      const old = dev.tag;
      if (op.newTag && op.newTag !== old) {
        tagFree(op.newTag, old);
        dev.tag = op.newTag;
        for (const e of d.equipment) if (e.tag === old) e.tag = op.newTag;
        for (const c of d.cables) { if (c.to.equipment === old) c.to.equipment = op.newTag; if (c.from.equipment === old) c.from.equipment = op.newTag; }
        for (const c of d.connections) for (const end of [c.from, c.to]) if (end.equipment === old) end.equipment = op.newTag;
      }
      if (op.room !== undefined) dev.room = op.room?.trim() ? op.room.trim() : null;
      for (const k of ["manufacturer", "model", "mounting", "mountingHeight", "notes", "ofe"] as const) setOpt(dev as unknown as Record<string, unknown>, k, op[k]);
      return dev.tag !== old ? `device ${old} renamed ${dev.tag}` : `device ${dev.tag} updated`;
    }
    case "set_cable": {
      if (op.lengthFt !== undefined) fail("lengthFt comes only from the takeoff's measured route: fix the route in the takeoff and run install_draft again");
      const c = cable(op.label);
      if (op.newLabel === null) delete c.labelOverride;
      else if (op.newLabel !== undefined && op.newLabel !== c.label) {
        if (d.cables.some((x) => x !== c && x.label === op.newLabel)) fail(`label ${op.newLabel} is already on another cable`);
        c.label = op.newLabel;
        c.labelOverride = true;
      }
      if (op.spare !== undefined) { if (op.spare) c.spare = true; else delete c.spare; }
      setOpt(c as unknown as Record<string, unknown>, "notes", op.notes);
      return `cable ${op.label} updated${op.newLabel ? ` (label ${op.newLabel}, kept through relabeling)` : op.newLabel === null ? " (label back to the scheme)" : ""}`;
    }
    case "add_equipment": {
      tagFree(op.tag);
      let e: InstallEquipment;
      if (op.key) {
        const spec = lookupEquipment(library, op.key) ?? fail(`no equipment library entry ${op.key}: find_equipment, or record_equipment it from the spec sheet first`);
        e = {
          tag: op.tag, description: op.description?.trim() || spec.description, manufacturer: spec.manufacturer, model: spec.model,
          location: op.location?.trim() || "(not placed)", ports: structuredClone(spec.ports), watts: spec.watts, libraryKey: spec.key,
        };
      } else {
        if (!op.description?.trim()) fail("give key (an equipment library entry) or at least description, ports and watts");
        e = {
          tag: op.tag, description: op.description.trim(), location: op.location?.trim() || "(not placed)",
          ports: checkPorts([...(op.ports ?? []), ...expandPortGroups((op.portGroups ?? []) as PortGroup[])]),
          watts: op.watts ?? null,
          ...(op.manufacturer?.trim() ? { manufacturer: op.manufacturer.trim() } : {}),
          ...(op.model?.trim() ? { model: op.model.trim() } : {}),
        };
        if (e.watts == null) warnings.push(`${op.tag}: no wattage (power_unknown until record_equipment has the spec sheet's figure)`);
      }
      if (op.ofe) e.ofe = true;
      d.equipment.push(e);
      return `equipment ${op.tag} added (${e.ports.length} ports, ${e.watts == null ? "watts unknown" : `${e.watts} W`})`;
    }
    case "remove_equipment": {
      if (deviceTags.has(op.tag)) fail(`${op.tag} is a field device from the takeoff: remove its marker in the takeoff and run install_draft again`);
      const e = d.equipment.find((x) => x.tag === op.tag);
      if (!e) {
        let n = 0;
        for (const r of d.racks) { const before = r.items.length; r.items = r.items.filter((it) => !(it.tag === op.tag && it.kind !== "equipment" && it.kind !== "panel")); n += before - r.items.length; }
        if (!n) fail(`no equipment or rack item ${op.tag}`);
        return `rack item ${op.tag} removed`;
      }
      const landed = d.cables.filter((c) => c.from.equipment === op.tag || c.to.equipment === op.tag).map((c) => c.label);
      if (landed.length) fail(`cables ${landed.slice(0, 8).join(", ")}${landed.length > 8 ? ", ..." : ""} land on ${op.tag}: assign_port them elsewhere first`);
      d.equipment = d.equipment.filter((x) => x !== e);
      for (const r of d.racks) r.items = r.items.filter((it) => it.tag !== op.tag);
      const dropped = d.connections.filter((c) => c.from.equipment === op.tag || c.to.equipment === op.tag).map((c) => c.id);
      d.connections = d.connections.filter((c) => !dropped.includes(c.id));
      return `equipment ${op.tag} removed${dropped.length ? ` with connections ${dropped.join(", ")}` : ""}`;
    }
    case "place_in_rack": {
      const r = rack(op.rack);
      const e = d.equipment.find((x) => x.tag === op.tag);
      if (e && deviceTags.has(e.tag)) fail(`${op.tag} is a field device, not rack gear`);
      if (!e && !op.kind) fail(`no equipment ${op.tag}: add_equipment it first (or give kind for a manager / blank / shelf / vent)`);
      const existing = d.racks.flatMap((x) => x.items).find((it) => it.tag === op.tag);
      let h = op.ruHeight;
      if (h === undefined && e?.libraryKey) {
        const spec = lookupEquipment(library, e.libraryKey);
        if (spec && spec.ruHeight === 0) fail(`${spec.manufacturer} ${spec.model} is not rack gear (0 RU on its spec sheet): give ruHeight for its shelf, or place a shelf`);
        h = spec?.ruHeight;
      }
      h ??= existing?.ruHeight;
      if (!h) fail(`no RU height for ${op.tag}: record_equipment its spec sheet (ruHeight) or give ruHeight`);
      const lo = op.ruTop - h + 1;
      if (lo < 1) fail(`${op.tag} is ${h} RU: with its top at RU ${op.ruTop} it would go below RU 1`);
      if (r.sizeRU > 0 && op.ruTop > r.sizeRU) fail(`rack ${r.id} is ${r.sizeRU} RU: RU ${op.ruTop} is outside it`);
      const hit = r.items.find((it) => it.tag !== op.tag && lo <= it.ruTop && it.ruTop - it.ruHeight + 1 <= op.ruTop);
      if (hit) fail(`RU ${lo}-${op.ruTop} overlaps ${hit.tag} (RU ${hit.ruTop - hit.ruHeight + 1}-${hit.ruTop}) in ${r.id}`);
      if (e) {
        const away = d.cables.filter((c) => c.from.equipment === e.tag && c.from.rack !== r.id).map((c) => c.label);
        if (away.length) fail(`cables ${away.slice(0, 8).join(", ")} home to ${e.tag} in another rack: assign_port them first`);
      }
      const isPanel = e ? panelTags(d).has(e.tag) : false;
      for (const x of d.racks) x.items = x.items.filter((it) => it.tag !== op.tag);
      const item: RackItem = { tag: op.tag, kind: e ? (isPanel ? "panel" : "equipment") : op.kind!, ruTop: op.ruTop, ruHeight: h, ...(op.label ? { label: op.label } : existing?.label ? { label: existing.label } : {}) };
      r.items.push(item);
      r.items.sort((a, b) => b.ruTop - a.ruTop);
      if (e) { e.rack = r.id; e.location = r.id; }
      return `${op.tag} in ${r.id} at RU ${lo}-${op.ruTop}`;
    }
    case "set_rack": {
      const r = rack(op.rack);
      for (const k of ["name", "model", "location"] as const) if (op[k] !== undefined && op[k]!.trim()) r[k] = op[k]!.trim();
      if (op.sizeRU !== undefined && op.sizeRU !== r.sizeRU) {
        const top = r.items.length ? Math.max(...r.items.map((it) => it.ruTop)) : 0;
        if (top > op.sizeRU) fail(`items reach RU ${top}, above ${op.sizeRU} RU: move them first`);
        if (r.sizeRU === 0 && top > 0) {
          const shift = op.sizeRU - top;
          for (const it of r.items) it.ruTop += shift;
        }
        r.sizeRU = op.sizeRU;
      }
      if (op.circuits) r.circuits = op.circuits.map((c) => ({ label: c.label, amps: c.amps, ...(c.volts ? { volts: c.volts } : {}) }));
      if (op.fanCfm !== undefined) r.fanCfm = op.fanCfm;
      return `rack ${r.id} updated${op.sizeRU ? ` (${r.sizeRU} RU)` : ""}`;
    }
    case "connect": {
      const panels = panelTags(d);
      for (const end of [op.from, op.to]) {
        const e = equipment(end.equipment);
        if (!e.ports.some((p) => p.id === end.port)) fail(`${end.equipment} has no port ${end.port} (ports: ${e.ports.slice(0, 12).map((p) => p.id).join(", ")}${e.ports.length > 12 ? ", ..." : ""})`);
        const k = portUseKey({}, end.equipment, end.port, panels);
        const other = d.connections.find((c) => [c.from, c.to].some((x) => x.equipment === end.equipment && x.port === end.port && portUseKey(c, x.equipment, x.port, panels) === k));
        if (other) fail(`${end.equipment} ${end.port} is already used by connection ${other.id}`);
      }
      if (op.from.equipment === op.to.equipment && op.from.port === op.to.port) fail("a connection needs two different ports");
      let n = 1;
      while (d.connections.some((c) => c.id === `pc-${n}`)) n++;
      d.connections.push({ id: `pc-${n}`, kind: (op.kind ?? "patch") as InstallDesign["connections"][number]["kind"], from: { ...op.from }, to: { ...op.to }, ...(op.notes ? { notes: op.notes } : {}) });
      return `connection pc-${n}: ${op.from.equipment} ${op.from.port} → ${op.to.equipment} ${op.to.port}`;
    }
    case "disconnect": {
      const c = op.id
        ? d.connections.find((x) => x.id === op.id)
        : op.equipment && op.port ? d.connections.find((x) => !x.id.startsWith("fc-") && [x.from, x.to].some((e) => e.equipment === op.equipment && e.port === op.port)) : fail("give id, or equipment and port");
      if (!c) fail(`no connection ${op.id ?? `at ${op.equipment} ${op.port}`}`);
      if (c!.id.startsWith("fc-")) fail(`${c!.id} is field cable ${c!.cable}: it follows the takeoff; use assign_port to move its rack end`);
      d.connections = d.connections.filter((x) => x !== c);
      return `connection ${c!.id} removed`;
    }
    case "assign_port": {
      const c = cable(op.cable);
      const e = equipment(op.panel);
      if (deviceTags.has(e.tag)) fail(`${e.tag} is a field device`);
      if (!e.ports.some((p) => p.id === op.port)) fail(`${e.tag} has no port ${op.port}`);
      if (e.rack !== c.from.rack) fail(`${e.tag} is ${e.rack ? `in rack ${e.rack}` : "not in a rack"}; cable ${c.label} homes to ${c.from.rack}`);
      const other = d.cables.find((x) => x !== c && x.from.equipment === e.tag && x.from.port === op.port);
      if (other) fail(`${e.tag} ${op.port} already terminates cable ${other.label}`);
      const panels = panelTags(d);
      const conn = d.connections.find((x) => !x.id.startsWith("fc-") && [x.from, x.to].some((p) => p.equipment === e.tag && p.port === op.port && portUseKey({ cable: "x" }, p.equipment, p.port, panels) === portUseKey(x, p.equipment, p.port, panels)));
      if (conn) fail(`${e.tag} ${op.port} is used by connection ${conn.id}`);
      c.from.equipment = e.tag;
      c.from.port = op.port;
      return `cable ${c.label} → ${e.tag} ${op.port}`;
    }
    case "set_mounting": {
      if (!d.devices.some((x) => x.deviceType === op.deviceType) && !d.mounting.some((m) => m.deviceType === op.deviceType)) {
        fail(`no device of type ${op.deviceType} (types: ${[...new Set(d.devices.map((x) => x.deviceType))].join(", ")})`);
      }
      let m = d.mounting.find((x) => x.deviceType === op.deviceType);
      if (!m) { m = { deviceType: op.deviceType, title: op.deviceType, heightAff: "", box: "", notes: [] }; d.mounting.push(m); }
      if (op.title !== undefined) m.title = op.title;
      if (op.heightAff !== undefined) m.heightAff = op.heightAff.trim();
      if (op.box !== undefined) m.box = op.box;
      if (op.notes !== undefined) m.notes = op.notes;
      if (op.basis !== undefined) { if (op.basis.trim()) m.basis = op.basis.trim(); else delete m.basis; }
      return `mounting for ${op.deviceType}${m.heightAff ? `: ${m.heightAff}` : ""}`;
    }
  }
}

function checkPorts(ports: (Partial<EquipmentPort> & { id: string; signal: string })[]): EquipmentPort[] {
  const seen = new Set<string>();
  return ports.map((p) => {
    if (seen.has(p.id)) fail(`port id ${p.id} appears twice`);
    seen.add(p.id);
    return { id: p.id, label: p.label?.trim() || p.id, signal: p.signal, ...(p.connector ? { connector: p.connector } : {}), ...(p.direction ? { direction: p.direction } : {}), ...(p.poe !== undefined ? { poe: p.poe } : {}) };
  });
}

function fail(msg: string): never {
  throw new OpError(msg);
}
