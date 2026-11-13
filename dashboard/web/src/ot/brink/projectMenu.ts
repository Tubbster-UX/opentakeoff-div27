// The Takeoff tab's entries in the app header's Project menu (lib/chrome.ts). Each one
// runs OpenTakeoff's own exporter, unchanged: the marked set PDF (lib/markedset.js via the
// canvas's exportMarkedSet), DXF (lib/dxf.ts, as upstream's report builds it), the takeoff
// file (the canvas's "Export takeoff"), its report, estimate and revisions panels, and
// the browser print of the report (upstream's print stylesheet, styles/print.css).
import { buildSheetDxf, DXF_MIME, dxfFileName } from "../../../../vendor/opentakeoff/src/lib/dxf.ts";
import { downloadText } from "../../../../vendor/opentakeoff/src/lib/totals.js";
import type { MenuEntry } from "../../design/index.js";
import { getHost } from "../host";

/** One DXF per calibrated sheet with takeoffs that is open (it needs the rendered sheet's size), zipped when several. */
export async function exportDxf(): Promise<void> {
  const h = getHost();
  if (!h) return;
  const ids = [...new Set(h.shapes.map((s) => s.sheet_id))];
  const ok = ids
    .map((id) => ({ id, upp: h.scales[id] ?? 0, dims: h.panelByKey(id)?.img }))
    .filter((s): s is { id: string; upp: number; dims: { w: number; h: number } } => s.upp > 0 && !!s.dims && s.dims.w > 0);
  if (!ok.length) {
    h.setCommitMsg("DXF needs a sheet with takeoffs that has its scale set and is open on the canvas.");
    return;
  }
  const base = h.projectName || "takeoff";
  const built = ok.map(({ id, upp, dims }) => {
    const label = h.tabLabel(id);
    const b = buildSheetDxf({ sheet_id: id, label, dims, upp, shapes: h.shapes as never, conditions: h.conditions as never }, { units: h.units === "metric" ? "m" : "ft" });
    return { name: dxfFileName(base, label), dxf: b.dxf };
  });
  const skipped = ids.length - ok.length;
  if (built.length === 1) downloadText(built[0]!.name, built[0]!.dxf, DXF_MIME);
  else {
    const { zipSync, strToU8 } = await import("fflate");
    const files: Record<string, Uint8Array> = {};
    for (const f of built) files[files[f.name] ? f.name.replace(/\.dxf$/, `_${Object.keys(files).length}.dxf`) : f.name] = strToU8(f.dxf);
    downloadText(`${base.replace(/[^\w .-]+/g, "-")}_dxf.zip`, zipSync(files, { level: 6 }), "application/zip");
  }
  h.setCommitMsg(`DXF downloaded: ${built.length} sheet${built.length === 1 ? "" : "s"}${skipped ? `; ${skipped} sheet${skipped === 1 ? "" : "s"} left out (no scale, or not open)` : ""}.`);
}

const run = (id: string) => getHost()?.workspaceActions.find((a) => a.id === id)?.run();

/**
 * Open one of the canvas's overlays (report, estimate, revisions). The menu hands focus back to its trigger in the
 * header (Brink chrome, where plain keys are kept from the canvas), so let go of it: Escape then reaches the
 * overlay as upstream expects.
 */
const open = (fn: () => void) => () => {
  fn();
  requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur?.());
};

export function projectMenu(): { title: string; items: MenuEntry[] }[] {
  return [
    {
      title: "Takeoff exports",
      items: [
        { label: "Marked set PDF", icon: "download", onSelect: () => void getHost()?.exportMarkedSet(true), id: "ot-marked-set" },
        { label: "DXF (CAD)", icon: "download", onSelect: () => void exportDxf(), id: "ot-dxf" },
        { label: "Takeoff file (.json)", icon: "download", onSelect: () => run("file-export-takeoff"), id: "ot-takeoff-json" },
      ],
    },
    {
      title: "Takeoff reports",
      items: [
        { label: "Report: quantities, materials, CSV and Excel", icon: "report", onSelect: open(() => getHost()?.setShowReport(true)), id: "ot-report" },
        { label: "Estimate", icon: "report", onSelect: open(() => getHost()?.openEstimate()), id: "ot-estimate" },
        { label: "Revisions", icon: "layers", onSelect: open(() => getHost()?.setShowRevisions(true)), id: "ot-revisions" },
        {
          label: "Print report",
          icon: "print",
          id: "ot-print",
          onSelect: () => {
            getHost()?.setShowReport(true);
            // The report must be on the page for upstream's print stylesheet to lay it out.
            setTimeout(() => window.print(), 400);
          },
        },
      ],
    },
  ];
}
