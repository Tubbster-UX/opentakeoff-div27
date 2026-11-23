// An invented install design for the install-package tests: two racks (an
// MDF and an IDF), two plan sheets (T-201 is a /Rotate 90 page, second page
// of its file), 41 devices across 8 rooms, 66 cables with spares and one
// unmeasured length, patch panels / switches / an amp with ports and
// connections, four mounting details and one rack item with unknown watts.
// Every name, number and manufacturer here is made up.
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import type { CompanyProfile } from "../src/bidTypes.ts";
import type {
  CableKind, Connection, EquipmentPort, InstallCable, InstallDesign, InstallDevice, InstallEquipment, MountingDetail, Rack,
} from "../src/installTypes.ts";
import type { ProjectManifest } from "../src/types.ts";

type Box = [number, number, number, number];

/** Rooms in verts_norm space (visual raster, y down). */
export const ROOMS: Record<string, { sheet: string; box: Box }> = {
  "MDF 100": { sheet: "T-101", box: [0.06, 0.08, 0.22, 0.35] },
  "Office 101": { sheet: "T-101", box: [0.22, 0.08, 0.45, 0.45] },
  "Office 102": { sheet: "T-101", box: [0.45, 0.08, 0.68, 0.45] },
  "Conference 103": { sheet: "T-101", box: [0.68, 0.08, 0.94, 0.55] },
  "Lobby 104": { sheet: "T-101", box: [0.06, 0.55, 0.5, 0.9] },
  "IDF 200": { sheet: "T-201", box: [0.06, 0.08, 0.2, 0.3] },
  "Classroom 201": { sheet: "T-201", box: [0.2, 0.08, 0.55, 0.48] },
  "Classroom 202": { sheet: "T-201", box: [0.55, 0.08, 0.94, 0.48] },
  "Corridor 205": { sheet: "T-201", box: [0.06, 0.48, 0.94, 0.6] },
  "Lab 203": { sheet: "T-201", box: [0.2, 0.6, 0.7, 0.92] },
};

/** Device tags per room, in placement order. */
const LAYOUT: Record<string, string[]> = {
  "Office 101": ["DO-101", "DO-102", "DO-103", "WAP-101", "SPK-101"],
  "Office 102": ["DO-104", "DO-105", "DO-106", "WAP-102", "SPK-102"],
  "Conference 103": ["DO-107", "DO-108", "TV-103", "WAP-103", "SPK-103", "SPK-104", "CAM-101"],
  "Lobby 104": ["DO-109", "WAP-104", "CAM-102", "CAM-103", "SPK-105"],
  "Classroom 201": ["DO-201", "DO-202", "DO-203", "WAP-201", "SPK-201", "CAM-201"],
  "Classroom 202": ["DO-204", "DO-205", "DO-206", "WAP-202", "SPK-202"],
  "Lab 203": ["DO-207", "DO-208", "DO-209", "DO-210", "WAP-203"],
  "Corridor 205": ["WAP-204", "CAM-202", "CAM-203"],
};

/** Devices on the rotated sheet that carry a plan anchor text at their marker point (tag -> anchor text). */
export const ROTATED_ANCHORS: Record<string, string> = { "WAP-201": "AQ1", "DO-210": "AQ2", "CAM-203": "AQ3" };

const TYPE: Record<string, { type: string; description: string; manufacturer?: string; model?: string; mounting: string; height: string }> = {
  DO: { type: "wall_outlet", description: "Data outlet, 2-port", manufacturer: "Corvid Networks", model: "FP-2", mounting: "Wall, flush", height: "18 in. AFF to center" },
  WAP: { type: "wap", description: "Wireless access point", manufacturer: "Skyreach", model: "AX-520", mounting: "Ceiling", height: "Ceiling" },
  CAM: { type: "camera", description: "IP dome camera", manufacturer: "Halcyon Video", model: "D-4", mounting: "Ceiling / wall", height: "9 ft AFF" },
  SPK: { type: "speaker", description: "Ceiling speaker, 70 V", manufacturer: "Alder Audio", model: "CS-8", mounting: "Ceiling tile", height: "Ceiling" },
  TV: { type: "display", description: "Wall display, 75 in.", mounting: "Wall bracket", height: "60 in. AFF to center" },
};

function prefix(tag: string): string { return tag.split("-")[0]; }

function placeIn(b: Box, i: number, n: number): [number, number] {
  const u = (i + 1) / (n + 1);
  const x = b[0] + (b[2] - b[0]) * (0.12 + 0.76 * u);
  const y = b[1] + (b[3] - b[1]) * (i % 2 ? 0.3 : 0.72);
  return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const ethPorts = (n: number, poe = false): EquipmentPort[] => range(n).map((i) => ({ id: `p${i}`, label: String(i), signal: "ethernet", connector: "RJ45", ...(poe ? { poe: true } : {}) }));

export function fixtureDesign(): InstallDesign {
  const devices: InstallDevice[] = [];
  for (const [room, tags] of Object.entries(LAYOUT)) {
    const r = ROOMS[room];
    tags.forEach((tag, i) => {
      const t = TYPE[prefix(tag)];
      const rack = prefix(tag) === "SPK" ? "RK-101" : r.sheet === "T-101" ? "RK-101" : "RK-201";
      devices.push({
        tag, shapeId: `shape-${tag}`, conditionId: `cond-${t.type}`, sheet: r.sheet, at: placeIn(r.box, i, tags.length), room,
        deviceType: t.type, description: t.description, ...(t.manufacturer ? { manufacturer: t.manufacturer, model: t.model } : {}),
        ...(prefix(tag) === "TV" ? { ofe: true } : {}), mounting: t.mounting, mountingHeight: t.height, rack,
      });
    });
  }

  const equipment: InstallEquipment[] = [
    { tag: "PP-A", description: "Patch panel, 24-port Cat6A", manufacturer: "Corvid Networks", model: "PP24-6A", location: "RK-101", rack: "RK-101", ports: ethPorts(24) },
    { tag: "PP-B", description: "Patch panel, 24-port Cat6A", manufacturer: "Corvid Networks", model: "PP24-6A", location: "RK-101", rack: "RK-101", ports: ethPorts(24) },
    {
      tag: "SW-101", description: "PoE switch, 48-port", manufacturer: "Corvid Networks", model: "CS-48P", location: "RK-101", rack: "RK-101", watts: 740,
      ports: [...ethPorts(48, true), { id: "sfp1", label: "SFP 1", signal: "fiber", connector: "LC" }, { id: "sfp2", label: "SFP 2", signal: "fiber", connector: "LC" }],
    },
    {
      tag: "AMP-101", description: "Mixer amplifier, 4-zone 70 V", manufacturer: "Alder Audio", model: "MA-4120", location: "RK-101", rack: "RK-101", watts: 300,
      ports: [...range(4).map((i) => ({ id: `z${i}`, label: `ZONE ${i}`, signal: "speaker", direction: "out" as const })), { id: "lan", label: "LAN", signal: "ethernet" }],
    },
    { tag: "NVR-101", description: "Network video recorder", manufacturer: "Halcyon Video", model: "NV-16", location: "RK-101", rack: "RK-101", watts: null, ports: [{ id: "lan", label: "LAN", signal: "ethernet" }, { id: "hdmi", label: "HDMI OUT", signal: "hdmi", direction: "out" }] },
    { tag: "UPS-101", description: "UPS, 1500 VA", manufacturer: "Steadyline", model: "SL-1500R", location: "RK-101", rack: "RK-101", watts: 60, ports: [] },
    { tag: "FIB-101", description: "Fiber enclosure, 6 LC duplex", manufacturer: "Corvid Networks", model: "FE-6", location: "RK-101", rack: "RK-101", ports: range(6).map((i) => ({ id: `f${i}`, label: `F${i}`, signal: "fiber", connector: "LC" })) },
    { tag: "PP-C", description: "Patch panel, 24-port Cat6A", manufacturer: "Corvid Networks", model: "PP24-6A", location: "RK-201", rack: "RK-201", ports: ethPorts(24) },
    { tag: "PP-D", description: "Patch panel, 24-port Cat6A", manufacturer: "Corvid Networks", model: "PP24-6A", location: "RK-201", rack: "RK-201", ports: ethPorts(24) },
    { tag: "SW-201", description: "PoE switch, 48-port", manufacturer: "Corvid Networks", model: "CS-48P", location: "RK-201", rack: "RK-201", watts: 740, ports: [...ethPorts(48, true), { id: "sfp1", label: "SFP 1", signal: "fiber", connector: "LC" }] },
    { tag: "FIB-201", description: "Fiber enclosure, 6 LC duplex", manufacturer: "Corvid Networks", model: "FE-6", location: "RK-201", rack: "RK-201", ports: range(6).map((i) => ({ id: `f${i}`, label: `F${i}`, signal: "fiber", connector: "LC" })) },
  ];
  // field equipment (wall outlets are left out on purpose: their blocks come from their cables)
  for (const d of devices) {
    const p = prefix(d.tag);
    if (p === "WAP" || p === "CAM") equipment.push({ tag: d.tag, description: d.description, manufacturer: d.manufacturer, model: d.model, location: d.room!, ports: [{ id: "lan", label: "LAN", signal: "ethernet", poe: true }] });
    if (p === "SPK") equipment.push({ tag: d.tag, description: d.description, manufacturer: d.manufacturer, model: d.model, location: d.room!, ports: [{ id: "in", label: "IN", signal: "speaker", direction: "in" }] });
    if (p === "TV") equipment.push({ tag: d.tag, description: d.description, location: d.room!, ofe: true, ports: [{ id: "hdmi1", label: "HDMI 1", signal: "hdmi", direction: "in" }, { id: "lan", label: "LAN", signal: "ethernet" }] });
  }

  const cables: InstallCable[] = [];
  const connections: Connection[] = [];
  const seq: Partial<Record<CableKind, number>> = {};
  const letter: Record<CableKind, string> = { data: "D", video: "V", fiber: "F", speaker: "S", audio: "A", control: "C", coax: "X", power: "P", other: "Z" };
  const next = (k: CableKind) => { seq[k] = (seq[k] ?? 0) + 1; return `${letter[k]}${String(seq[k]).padStart(2, "0")}`; };
  const panelPos: Record<string, { panels: string[]; i: number }> = { "RK-101": { panels: ["PP-A", "PP-B"], i: 0 }, "RK-201": { panels: ["PP-C", "PP-D"], i: 0 } };
  const swPort: Record<string, number> = { "RK-101": 0, "RK-201": 0 };
  let lenSeed = 0;
  const length = (room: string) => {
    lenSeed++;
    const base: Record<string, number> = { "Office 101": 62, "Office 102": 88, "Conference 103": 121, "Lobby 104": 96, "Classroom 201": 74, "Classroom 202": 109, "Lab 203": 131, "Corridor 205": 58 };
    return Math.round(((base[room] ?? 80) + (lenSeed % 7) * 3.7) * 10) / 10;
  };
  const dataCable = (dev: InstallDevice, port: string | undefined, o: { spare?: boolean; connect?: boolean; nullLength?: boolean; notes?: string } = {}) => {
    const rack = dev.rack!;
    const pp = panelPos[rack];
    const n = pp.i++;
    const panel = pp.panels[Math.floor(n / 24)];
    const pport = `p${(n % 24) + 1}`;
    const label = next("data");
    cables.push({
      label, kind: "data", cableType: "CAT6A plenum", runId: `run-${dev.tag}`, lengthFt: o.nullLength ? null : length(dev.room!),
      from: { equipment: panel, port: pport, rack, location: `${rack} ${rack === "RK-101" ? "MDF" : "IDF"}` },
      to: { equipment: dev.tag, ...(port ? { port } : {}), location: dev.room! },
      ...(o.spare ? { spare: true } : {}), ...(o.notes ? { notes: o.notes } : {}),
    });
    if (o.connect !== false) connections.push({ id: `c-${label}`, cable: label, kind: "data", from: { equipment: panel, port: pport }, to: { equipment: dev.tag, port: port ?? "lan" } });
    if (!o.spare) {
      const sw = rack === "RK-101" ? "SW-101" : "SW-201";
      connections.push({ id: `pc-${label}`, kind: "patch", from: { equipment: panel, port: pport }, to: { equipment: sw, port: `p${++swPort[rack]}` } });
    }
  };
  for (const dev of devices) {
    const p = prefix(dev.tag);
    if (p === "DO") { dataCable(dev, "A"); dataCable(dev, "B"); }
    if (p === "WAP") { dataCable(dev, "lan"); if (dev.tag === "WAP-103") dataCable(dev, undefined, { connect: false, notes: "Second drop for future AP" }); }
    if (p === "CAM") dataCable(dev, "lan", { nullLength: dev.tag === "CAM-203" });
    if (p === "TV") dataCable(dev, "lan", { connect: false });
  }
  // spares: two at the lab bench outlet, one in classroom 201
  const dev = (t: string) => devices.find((d) => d.tag === t)!;
  dataCable(dev("DO-210"), undefined, { spare: true, connect: false });
  dataCable(dev("DO-210"), undefined, { spare: true, connect: false });
  dataCable(dev("DO-201"), undefined, { spare: true, connect: false, notes: "Coil 10 ft in ceiling above outlet" });

  // speakers home-run to the amp in the MDF
  const zones: Record<string, string> = { "SPK-101": "z1", "SPK-102": "z1", "SPK-103": "z2", "SPK-104": "z2", "SPK-105": "z3", "SPK-201": "z4", "SPK-202": "z4" };
  for (const [tag, z] of Object.entries(zones)) {
    const d = dev(tag);
    const label = next("speaker");
    cables.push({ label, kind: "speaker", cableType: "16/2 plenum speaker", runId: `run-${tag}`, lengthFt: length(d.room!) + (d.sheet === "T-201" ? 140 : 0), from: { equipment: "AMP-101", port: z, rack: "RK-101", location: "RK-101 MDF" }, to: { equipment: tag, port: "in", location: d.room! } });
    connections.push({ id: `c-${label}`, cable: label, kind: "speaker", from: { equipment: "AMP-101", port: z }, to: { equipment: tag, port: "in" } });
  }
  // video to the conference display, fiber backbone
  const v = next("video");
  cables.push({ label: v, kind: "video", cableType: "HDMI over Cat6 extender pair", runId: "run-TV-103", lengthFt: 118, from: { equipment: "NVR-101", port: "hdmi", rack: "RK-101", location: "RK-101 MDF" }, to: { equipment: "TV-103", port: "hdmi1", location: "Conference 103" } });
  connections.push({ id: `c-${v}`, cable: v, kind: "video", from: { equipment: "NVR-101", port: "hdmi" }, to: { equipment: "TV-103", port: "hdmi1" } });
  const fo = next("fiber");
  cables.push({ label: fo, kind: "fiber", cableType: "OM4 6-strand plenum", lengthFt: 212.5, from: { equipment: "FIB-101", port: "f1", rack: "RK-101", location: "RK-101 MDF" }, to: { equipment: "FIB-201", port: "f1", rack: "RK-201", location: "RK-201 IDF" } });
  connections.push(
    { id: `c-${fo}`, cable: fo, kind: "fiber", from: { equipment: "FIB-101", port: "f1" }, to: { equipment: "FIB-201", port: "f1" } },
    { id: "pc-up1", kind: "patch", from: { equipment: "SW-101", port: "sfp1" }, to: { equipment: "FIB-101", port: "f1" } },
    { id: "pc-up2", kind: "patch", from: { equipment: "SW-201", port: "sfp1" }, to: { equipment: "FIB-201", port: "f1" } },
    { id: "pc-amp", kind: "patch", from: { equipment: "AMP-101", port: "lan" }, to: { equipment: "SW-101", port: "p40" } },
    { id: "pc-nvr", kind: "patch", from: { equipment: "NVR-101", port: "lan" }, to: { equipment: "SW-101", port: "p41" } },
  );

  const racks: Rack[] = [
    {
      id: "RK-101", name: "MDF rack", location: "MDF 100", model: "4-post open frame, 42U", sizeRU: 42, trShapeId: "shape-tr-101",
      circuits: [{ label: "20A dedicated A", amps: 20 }, { label: "20A dedicated B", amps: 20 }], fanCfm: null,
      items: [
        { tag: "PP-A", kind: "panel", ruTop: 42, ruHeight: 1 },
        { tag: "CM-1", kind: "manager", ruTop: 41, ruHeight: 1, label: "Horizontal cable manager" },
        { tag: "PP-B", kind: "panel", ruTop: 40, ruHeight: 1 },
        { tag: "CM-2", kind: "manager", ruTop: 39, ruHeight: 1, label: "Horizontal cable manager" },
        { tag: "SW-101", kind: "equipment", ruTop: 38, ruHeight: 1 },
        { tag: "CM-3", kind: "manager", ruTop: 37, ruHeight: 1, label: "Horizontal cable manager" },
        { tag: "BL-1", kind: "blank", ruTop: 36, ruHeight: 2, label: "Blank panel, 2U" },
        { tag: "AMP-101", kind: "equipment", ruTop: 34, ruHeight: 2 },
        { tag: "VT-1", kind: "vent", ruTop: 32, ruHeight: 1, label: "Vent panel" },
        { tag: "NVR-101", kind: "equipment", ruTop: 31, ruHeight: 2 },
        { tag: "SH-1", kind: "shelf", ruTop: 28, ruHeight: 2, label: "Shelf: ISP modem (owner-furnished)" },
        { tag: "FIB-101", kind: "panel", ruTop: 25, ruHeight: 1 },
        { tag: "UPS-101", kind: "equipment", ruTop: 6, ruHeight: 3 },
      ],
    },
    {
      id: "RK-201", name: "IDF rack", location: "IDF 200", model: "Wall-mount, 12U", sizeRU: 12, trShapeId: "shape-tr-201",
      circuits: [{ label: "20A dedicated", amps: 20 }], fanCfm: 50,
      items: [
        { tag: "PP-C", kind: "panel", ruTop: 12, ruHeight: 1 },
        { tag: "CM-4", kind: "manager", ruTop: 11, ruHeight: 1, label: "Horizontal cable manager" },
        { tag: "PP-D", kind: "panel", ruTop: 10, ruHeight: 1 },
        { tag: "SW-201", kind: "equipment", ruTop: 9, ruHeight: 1 },
        { tag: "BL-2", kind: "blank", ruTop: 8, ruHeight: 1, label: "Blank panel" },
        { tag: "FIB-201", kind: "panel", ruTop: 7, ruHeight: 1 },
      ],
    },
  ];

  const mounting: MountingDetail[] = [
    { deviceType: "wall_outlet", title: "Data outlet, flush wall box", heightAff: "18 in. AFF to center", box: "1-gang low-voltage mud ring (by EC)", notes: ["Match the height of adjacent power receptacles where they differ by less than 3 in.", "Leave 12 in. service loop in the wall cavity.", "Jack A on top."], basis: "Spec 27 15 00 3.2.A (invented)" },
    { deviceType: "wap", title: "Wireless access point, ceiling", heightAff: "Ceiling, centered in tile", box: "Tile bridge with 1-gang ring above ceiling", notes: ["Keep 3 ft clear of light fixtures and diffusers.", "Leave 10 ft service loop above ceiling."] },
    { deviceType: "camera", title: "Dome camera, wall or ceiling", heightAff: "9 ft AFF to center", box: "4 in. square box with camera adapter plate", notes: ["Aim per the security plan; confirm field of view with the owner before final fastening."] },
    { deviceType: "speaker", title: "Ceiling speaker, 2x2 tile", heightAff: "Ceiling (lay-in tile)", box: "Speaker back can with tile support rails", notes: ["Set tap at 2 W unless the room schedule says otherwise.", "Support back can independently from the grid."], basis: "Drawing note T-001 #4 (invented)" },
  ];

  return {
    schema: "brink.install.v1",
    project: "sample-school",
    revision: 4,
    created: "2026-11-18T15:00:00.000Z",
    bidRevision: 2,
    labelScheme: {
      source: "default", description: "Kind letter + running number, e.g. D01, S01, F01", pattern: "{type}{seq:2}",
      typeLetters: { data: "D", video: "V", fiber: "F", speaker: "S", audio: "A", control: "C", coax: "X", power: "P", other: "Z" },
    },
    devices, cables, equipment, connections, racks, mounting,
    issues: [
      { severity: "warning", code: "power_unknown", message: "NVR-101 has no wattage: RK-101 power total is incomplete.", ref: "NVR-101" },
      { severity: "warning", code: "length_unmeasured", message: "D-cable to CAM-203 has no measured route.", ref: "CAM-203" },
    ],
    status: "draft",
  };
}

export function approveDesign(d: InstallDesign): InstallDesign {
  return { ...d, status: "approved", approved: { at: "2026-11-20T16:30:00.000Z", revision: d.revision } };
}

export function fixtureProject(): ProjectManifest {
  return {
    schema: "brink.project.v1", id: "sample-school", name: "Sample Academy Classroom Wing", notes: "Invented test project.",
    created: "2026-10-01T00:00:00.000Z", updated: "2026-11-18T00:00:00.000Z", files: [], uploads: [], phase: "install",
  };
}

export function fixtureCompany(): CompanyProfile {
  return {
    legalName: "Example Holdings LLC DBA Example Design", brand: "Example Design", address: ["100 Sample Street", "Testville, SD 57000"],
    phone: "(555) 010-0000", email: "office@example.com", web: "example.com", signerName: "Pat Example", signerTitle: "Owner",
  };
}

// ── invented plan PDFs ──────────────────────────────────────────────────────

/** Visual (verts_norm) -> user space for the two fixture pages. */
export function visualToUser(sheet: string, at: [number, number]): [number, number] {
  if (sheet === "T-101") return [at[0] * 1728, 1152 - at[1] * 1152];
  // T-201: media box 1152 x 1728, /Rotate 90 -> visual 1728 x 1152; visual x runs along user +y, visual y along user +x
  return [at[1] * 1152, at[0] * 1728];
}

export async function fixturePlans(design: InstallDesign = fixtureDesign()): Promise<Record<string, { pdf: Uint8Array; pageIndex: number }>> {
  const out: Record<string, { pdf: Uint8Array; pageIndex: number }> = {};
  for (const sheet of ["T-101", "T-201"]) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    if (sheet === "T-201") {
      const cover = doc.addPage([612, 792]);
      cover.drawText("Invented plan set: sheet index", { x: 72, y: 700, size: 14, font });
    }
    const rotated = sheet === "T-201";
    const page = doc.addPage(rotated ? [1152, 1728] : [1728, 1152]);
    if (rotated) page.setRotation(degrees(90));
    const u = (at: [number, number]) => visualToUser(sheet, at);
    for (const [name, r] of Object.entries(ROOMS)) {
      if (r.sheet !== sheet) continue;
      const [ax, ay] = u([r.box[0], r.box[1]]);
      const [bx, by] = u([r.box[2], r.box[3]]);
      page.drawRectangle({ x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay), borderColor: rgb(0, 0, 0), borderWidth: 3 });
      const [tx, ty] = u([r.box[0] + 0.012, r.box[1] + 0.04]);
      page.drawText(name.toUpperCase(), { x: tx, y: ty, size: 16, font, color: rgb(0.2, 0.2, 0.2), ...(rotated ? { rotate: degrees(90) } : {}) });
    }
    const [tbx, tby] = u([0.75, 0.94]);
    page.drawText(`SHEET ${sheet} - INVENTED FLOOR PLAN`, { x: tbx, y: tby, size: 18, font, ...(rotated ? { rotate: degrees(90) } : {}) });
    for (const d of design.devices) {
      if (d.sheet !== sheet) continue;
      const [x, y] = u(d.at);
      page.drawCircle({ x, y, size: 6, borderColor: rgb(0, 0, 0), borderWidth: 1 });
      const anchor = ROTATED_ANCHORS[d.tag];
      if (anchor && rotated) page.drawText(anchor, { x, y, size: 3, font, rotate: degrees(90) });
    }
    out[sheet] = { pdf: await doc.save(), pageIndex: rotated ? 1 : 0 };
  }
  return out;
}
