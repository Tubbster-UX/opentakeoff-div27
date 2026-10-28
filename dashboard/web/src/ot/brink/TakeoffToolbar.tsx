// The Brink takeoff toolbar. It takes the place of OpenTakeoff's top bar and tool rail
// (both hidden: upstream's focus mode collapses the bar, design/ot-theme.css hides the
// rail). Every control calls the canvas's own setter or function, through the host
// bridge (../host.ts), exactly as upstream's controls do; nothing in the engine changes.
//
// Where upstream's controls went:
//   toolbar        tools (select, area, rectangle, linear, surface, count, symbol, deduct,
//                  markups, calibrate), undo / redo / finish, snap and 45° guides, the
//                  active condition, zoom / fit / sheet invert, scale and units, panels
//   Project menu   marked set PDF, DXF, report, estimate, print, the takeoff JSON
//                  (brink/projectMenu.ts)
//   sheets panel   upload plans, open sheets and pages, remove a file
//   dropped        upstream's project home, account and sign-in chips, AI agent and voice
//                  controls, premium plans, the guided tour (vendor/PATCHES.md, OpenTakeoff
//                  "Features not in the Brink UI")
import { Button, IconButton, Menu, Select, Toolbar, ToolbarDivider, ToolbarGroup, type IconName, type MenuEntry } from "../../design/index.js";
import { getHost, useHost, type OtMenuItem } from "../host";
import { setSession, useSession } from "../session";

interface ToolDef {
  id: string;
  label: string;
  icon: IconName;
  key?: string;
}

const SELECT: ToolDef = { id: "select", label: "Select and edit", icon: "pointer", key: "V" };
const MEASURE: ToolDef[] = [
  { id: "area", label: "Area", icon: "area", key: "A" },
  { id: "rect", label: "Rectangle", icon: "rect", key: "R" },
  { id: "linear", label: "Linear", icon: "linear", key: "L" },
  { id: "surface", label: "Surface area", icon: "surface", key: "S" },
  { id: "count", label: "Count", icon: "count", key: "C" },
  { id: "symbol", label: "Symbol: box one, count every placement", icon: "symbol", key: "Y" },
];
const CUT: ToolDef[] = [
  { id: "deduct", label: "Deduct shape", icon: "deduct", key: "D" },
  { id: "deduct-rect", label: "Deduct rectangle", icon: "rect", key: "Shift+D" },
];
const MARKUPS: { id: string; label: string; key?: string }[] = [
  { id: "cloud", label: "Revision cloud" },
  { id: "callout", label: "Callout" },
  { id: "text", label: "Text note" },
  { id: "highlight", label: "Highlight box" },
  { id: "highlighter", label: "Highlighter", key: "H" },
  { id: "dimension", label: "Dimension line", key: "N" },
];
const MARKUP_IDS = new Set(MARKUPS.map((m) => m.id));

/** OpenTakeoff's scale face carries status glyphs (a check, a warning sign); the Brink face says it in words. */
export function scaleText(face: string, unitsPerPx: number | null, needsConfirm: boolean): string {
  if (!unitsPerPx) return "Set scale";
  const value = face.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s*[—-]\s*confirm$/i, "").trim() || "custom";
  return needsConfirm ? `Scale ${value} (confirm)` : `Scale ${value}`;
}

const scaleEntries = (items: (OtMenuItem | string)[]): MenuEntry[] =>
  items.flatMap((it): MenuEntry[] => {
    if (typeof it === "string") return [{ type: "separator" }];
    if (it.section) return [{ type: "heading", label: it.section }];
    if (!it.label || !it.onSelect) return [];
    const run = it.onSelect;
    return [{ label: it.label.replace(/[…]$/, "…"), onSelect: () => run(), checked: it.active || undefined, disabled: it.disabled, shortcut: it.shortcut }];
  });

function zoomBy(factor: number): void {
  const h = getHost();
  const r = h?.containerRef.current?.getBoundingClientRect();
  if (!h || !r) return;
  h.zoomAround(r.width / 2, r.height / 2, factor);
}

export function TakeoffToolbar() {
  const s = useHost(
    (h) => ({
      tool: h.tool,
      finishOk: h.finishOk,
      poly: h.poly,
      snapOn: h.snapOn,
      angleOn: h.angleOn,
      units: h.units,
      darkMode: h.darkMode,
      activeCond: h.activeCond,
      conds: h.conditions.map((c) => `${c.id}\u0000${c.finish_tag}`).join("\u0001"),
      scale: scaleText(h.scaleFace, h.unitsPerPx, h.scaleNeedsConfirm),
      needsScale: !h.unitsPerPx || h.scaleNeedsConfirm,
      canvas: h.view === "canvas" && h.sheets.length > 0,
      takeoffsOpen: h.takeoffsOpen,
      leftTab: h.leftTab,
      selected: !!h.selectedId,
    }),
    { tool: "select", finishOk: false, poly: 0, snapOn: false, angleOn: true, units: "imperial" as const, darkMode: false, activeCond: "", conds: "", scale: "Set scale", needsScale: true, canvas: false, takeoffsOpen: false, leftTab: null as string | null, selected: false },
  );
  const { sheets, right } = useSession();
  const h = getHost;
  const arm = (id: string) => {
    const host = h();
    if (!host) return;
    host.setView("canvas");
    host.setTool((t) => (t === id && id !== "select" ? "select" : id));
  };
  const toolButton = (t: ToolDef) => (
    <IconButton key={t.id} icon={t.icon} label={t.label} shortcut={t.key} pressed={s.tool === t.id} disabled={!s.canvas} onClick={() => arm(t.id)} data-tool={t.id} />
  );
  const conditions = s.conds ? s.conds.split("\u0001").map((x) => x.split("\u0000") as [string, string]) : [];
  const markupActive = MARKUP_IDS.has(s.tool);

  const panels: MenuEntry[] = [
    { label: "Sheets panel", checked: sheets, onSelect: () => setSession({ sheets: !sheets }) },
    { label: "Conditions and inspector", checked: right, onSelect: () => setSession({ right: !right }) },
    { label: "Quantities (OpenTakeoff panel)", checked: s.takeoffsOpen, onSelect: () => h()?.toggleTakeoffs() },
    { type: "separator" },
    { label: "Markups list", checked: s.leftTab === "markup", onSelect: () => h()?.setLeftTab((t) => (t === "markup" ? null : "markup")) },
    { label: "Stamps", checked: s.leftTab === "stamp", onSelect: () => h()?.setLeftTab((t) => (t === "stamp" ? null : "stamp")) },
    { label: "RFI register", checked: s.leftTab === "rfi", onSelect: () => h()?.setLeftTab((t) => (t === "rfi" ? null : "rfi")) },
    { label: "Plan set gallery: previews, side by side, stitching", onSelect: () => h()?.setView("gallery") },
    { label: "Revisions", onSelect: () => h()?.setShowRevisions(true) },
    { type: "separator" },
    { label: "Keyboard shortcuts and guide", shortcut: "?", onSelect: () => h()?.setGuideOpen(true) },
  ];

  return (
    <div data-bk-chrome data-print-hide className="shrink-0">
      <Toolbar
        label="Takeoff tools"
        end={
          <>
            <Menu
              label={s.scale}
              icon="ruler"
              size="sm"
              variant={s.needsScale ? "secondary" : "quiet"}
              align="end"
              testId="scale-menu"
              items={scaleEntries(h()?.scaleItems ?? [])}
            />
            <Button size="sm" variant="quiet" onClick={() => h()?.setUnits((u) => (u === "metric" ? "imperial" : "metric"))} aria-label="Switch display units" title="Switch display units" data-action="units">
              {s.units === "metric" ? "m" : "ft"}
            </Button>
            <ToolbarDivider />
            <IconButton icon="panelLeft" label="Sheets panel" pressed={sheets} onClick={() => setSession({ sheets: !sheets })} />
            <IconButton icon="quantities" label="Quantities (OpenTakeoff panel)" pressed={s.takeoffsOpen} onClick={() => h()?.toggleTakeoffs()} />
            <IconButton icon="panelRight" label="Conditions and inspector" pressed={right} onClick={() => setSession({ right: !right })} />
            <Menu label="Panels" ariaLabel="More panels" icon="layers" bare size="sm" align="end" items={panels} testId="panels-menu" />
          </>
        }
      >
        <ToolbarGroup label="Select">{toolButton(SELECT)}</ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup label="Measure">{MEASURE.map(toolButton)}</ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup label="Deduct">{CUT.map(toolButton)}</ToolbarGroup>
        <ToolbarGroup label="Markup and scale">
          <Menu
            label="Markup"
            ariaLabel="Markup tools"
            icon="markup"
            bare
            variant={markupActive ? "secondary" : "quiet"}
            testId="markup-menu"
            items={[
              { type: "heading", label: "Markups (notes on the plan, never measured)" },
              ...MARKUPS.map((m) => ({ label: m.label, shortcut: m.key, checked: s.tool === m.id, onSelect: () => arm(m.id), disabled: !s.canvas })),
            ]}
          />
          <IconButton icon="ruler" label="Calibrate: click two points of a known dimension" pressed={s.tool === "calibrate"} disabled={!s.canvas} onClick={() => arm("calibrate")} data-tool="calibrate" />
        </ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup label="Edit">
          <IconButton icon="undo" label={s.poly ? "Undo last point" : "Undo"} shortcut="Ctrl+Z" onClick={() => (s.poly ? h()?.dropLastPoint() : h()?.undoShapeCommand())} />
          <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" onClick={() => h()?.redoShapeCommand()} />
          {s.finishOk && (
            <Button size="sm" variant="primary" icon="check" onClick={() => h()?.finishShape()} data-action="finish-shape">
              Finish ({s.poly})
            </Button>
          )}
        </ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup label="Drawing aids">
          <IconButton icon="snap" label="Snap to plan lines and corners" pressed={s.snapOn} onClick={() => h()?.setSnapOn((v) => !v)} />
          <IconButton icon="angle" label="45 and 90 degree guides" pressed={s.angleOn} onClick={() => h()?.setAngleOn((v) => !v)} />
        </ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup label="Condition">
          <label className="sr-only" htmlFor="ot-active-condition">
            {s.selected && s.tool === "select" ? "Condition of the selected takeoff" : "Condition for the next measurement"}
          </label>
          <Select
            id="ot-active-condition"
            className="h-7 w-40 text-xs"
            value={s.activeCond}
            disabled={!conditions.length}
            title={s.selected && s.tool === "select" ? "Reassign the selected takeoff" : "Condition for the next measurement"}
            onChange={(e) => h()?.activateCondition(e.target.value)}
            data-control="condition"
          >
            {!conditions.length && <option value="">No conditions</option>}
            {conditions.map(([id, tag]) => (
              <option key={id} value={id}>
                {tag}
              </option>
            ))}
          </Select>
          <IconButton icon="plus" label="Add condition" size="sm" onClick={() => h()?.addCondition()} />
        </ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup label="View">
          <IconButton icon="zoomOut" label="Zoom out" disabled={!s.canvas} onClick={() => zoomBy(1 / 1.25)} />
          <IconButton icon="zoomIn" label="Zoom in" disabled={!s.canvas} onClick={() => zoomBy(1.25)} />
          <IconButton
            icon="fit"
            label="Fit sheet to view"
            disabled={!s.canvas}
            onClick={() => {
              const host = h();
              if (host?.stage.w) host.fitToView(host.stage.w, host.stage.h);
            }}
          />
          <IconButton icon="invert" label="Invert the sheet (negative print; affects the marked set)" pressed={s.darkMode} disabled={!s.canvas} onClick={() => h()?.setDarkMode((d) => !d)} />
        </ToolbarGroup>
      </Toolbar>
    </div>
  );
}
