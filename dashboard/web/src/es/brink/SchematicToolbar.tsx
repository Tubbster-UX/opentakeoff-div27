// The Brink schematic toolbar. It takes the place of EasySchematic's MenuBar
// (logo, title, File / Edit / Insert / View / Export / Reports / Help menus,
// undo / redo, align, theme, account), through the build's module override for
// src/components/MenuBar.tsx. Every action calls the same store actions and
// export / report functions upstream's MenuBar calls; nothing in the engine changes.
//
// Where upstream's menus went:
//   toolbar      undo / redo, Insert (room, note, shapes), Edit, Align, View, fit,
//                library and inspector panel toggles
//   Project menu (app header) exports (PDF, PNG, SVG, DXF, rack PDF, print sheets),
//                title block, reports (device list, cable schedule, patch panels, pack
//                list, network, power, room distances), download a copy (.json),
//                preferences, reload the saved schematic
//   dropped      New / Open / Save to file, EasySchematic cloud and accounts, device
//                archives, CSV cable-schedule import, external help links, landing
//                page, schematic rename (the project's database is the store of record;
//                vendor/PATCHES.md "Features not in the Brink UI")
import { useCallback, useEffect, useMemo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useSchematicStore } from "../../../../vendor/easyschematic/src/store";
import { exportImage } from "../../../../vendor/easyschematic/src/exportUtils";
import { exportDxf } from "../../../../vendor/easyschematic/src/dxfExport";
import { exportPdf } from "../../../../vendor/easyschematic/src/pdfExport";
import { getPaperSize } from "../../../../vendor/easyschematic/src/printConfig";
import type { AlignOperation } from "../../../../vendor/easyschematic/src/alignUtils";
import type { AnnotationData, SchematicNode } from "../../../../vendor/easyschematic/src/types";
import ReportsDialog, { type ReportsTab } from "../../../../vendor/easyschematic/src/components/ReportsDialog";
import TitleBlockDialog from "../../../../vendor/easyschematic/src/components/TitleBlockDialog";
import PreferencesDialog from "../../../../vendor/easyschematic/src/components/PreferencesDialog";
import RoomDistancesDialog from "../../../../vendor/easyschematic/src/components/RoomDistancesDialog";
import { IconButton, Menu, Toolbar, ToolbarDivider, ToolbarGroup, toast, type MenuEntry } from "../../design/index.js";
import { setChrome } from "../../lib/chrome.js";
import { setSession, useSession } from "../session";

const ALIGN: { op: AlignOperation; label: string }[] = [
  { op: "left", label: "Align left" },
  { op: "center-h", label: "Align centers" },
  { op: "right", label: "Align right" },
  { op: "top", label: "Align top" },
  { op: "middle-v", label: "Align middles" },
  { op: "bottom", label: "Align bottom" },
  { op: "distribute-h", label: "Distribute horizontally" },
  { op: "distribute-v", label: "Distribute vertically" },
];

const fileSafe = (s: string) => s.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "schematic";

export default function SchematicToolbar() {
  const rf = useReactFlow();
  const { library, right, sync } = useSession();
  const undo = useSchematicStore((s) => s.undo);
  const redo = useSchematicStore((s) => s.redo);
  const undoSize = useSchematicStore((s) => s.undoSize);
  const redoSize = useSchematicStore((s) => s.redoSize);
  const printView = useSchematicStore((s) => s.printView);
  const showOwnedGearPane = useSchematicStore((s) => s.showOwnedGearPane);
  const hideUnconnectedPorts = useSchematicStore((s) => s.hideUnconnectedPorts);
  const showMinimap = useSchematicStore((s) => s.showMinimap);
  const autoRoute = useSchematicStore((s) => s.autoRoute);
  const debugEdges = useSchematicStore((s) => s.debugEdges);
  const selected = useSchematicStore((s) => s.nodes.filter((n) => n.selected).length);
  const [reportsTab, setReportsTab] = useState<ReportsTab | null>(null);
  const [titleBlock, setTitleBlock] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [distances, setDistances] = useState(false);

  /** The canvas centre in flow coordinates, where inserted elements land. */
  const centre = useCallback(() => {
    const el = document.querySelector(".bk-es .react-flow")?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: el ? el.left + el.width / 2 : window.innerWidth / 2, y: el ? el.top + el.height / 2 : window.innerHeight / 2 });
  }, [rf]);

  // Upstream MenuBar's addAnnotation, unchanged in substance.
  const addAnnotation = useCallback(
    (shape: AnnotationData["shape"]) => {
      const state = useSchematicStore.getState();
      state.pushSnapshot();
      const c = centre();
      const isSquare = shape === "circle" || shape === "diamond";
      const node: SchematicNode = {
        id: `annotation-${Date.now()}`,
        type: "annotation",
        position: { x: c.x - (isSquare ? 50 : 100), y: c.y - 50 },
        data: { shape, color: "rgba(59, 130, 246, 0.15)", borderColor: "#3b82f6" } as AnnotationData,
        style: { width: isSquare ? 100 : 200, height: 100 },
      };
      useSchematicStore.setState({ nodes: [...state.nodes, node] });
      state.saveToLocalStorage();
    },
    [centre],
  );

  const downloadCopy = useCallback(() => {
    const data = useSchematicStore.getState().exportToJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileSafe(data.name)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportPdfNow = useCallback(() => {
    const s = useSchematicStore.getState();
    void exportPdf(rf, getPaperSize(s.printPaperId, s.printCustomWidthIn, s.printCustomHeightIn), s.printOrientation, s.printScale, s.titleBlock, s.titleBlockLayout);
  }, [rf]);

  const exportRackPdf = useCallback(async () => {
    const { exportRackPdf: run } = await import("../../../../vendor/easyschematic/src/rackPdf");
    const s = useSchematicStore.getState();
    if (!s.pages.some((p) => p.type === "rack-elevation")) {
      toast("No rack pages to export. Add a rack page from the page tabs first.", "info");
      return;
    }
    await run({
      pages: s.pages,
      nodes: s.nodes,
      schematicName: s.schematicName,
      titleBlock: s.titleBlock,
      paper: getPaperSize(s.printPaperId, s.printCustomWidthIn, s.printCustomHeightIn),
      schematicDefaults: { useShortNames: s.useShortNames, wrapDeviceLabels: s.wrapDeviceLabels },
    });
  }, []);

  const exportPrintSheets = useCallback(async () => {
    const { runPrintSheetExport } = await import("../../../../vendor/easyschematic/src/printSheetExport");
    await runPrintSheetExport();
  }, []);

  // Upstream's keyboard shortcuts (App.tsx) dispatch these; upstream's MenuBar listened for them.
  useEffect(() => {
    const onSave = () => {
      sync?.flushNow();
    };
    const onSaveAs = () => downloadCopy();
    const onOpen = () => toast("Opening schematic files is not part of the Brink app: the project's database is the schematic of record.", "info");
    const onReports = (e: Event) => setReportsTab(((e as CustomEvent).detail as ReportsTab) ?? "cableSchedule");
    window.addEventListener("easyschematic:save", onSave);
    window.addEventListener("easyschematic:save-as", onSaveAs);
    window.addEventListener("easyschematic:open", onOpen);
    window.addEventListener("easyschematic:open-reports", onReports);
    return () => {
      window.removeEventListener("easyschematic:save", onSave);
      window.removeEventListener("easyschematic:save-as", onSaveAs);
      window.removeEventListener("easyschematic:open", onOpen);
      window.removeEventListener("easyschematic:open-reports", onReports);
    };
  }, [sync, downloadCopy]);

  // The Project menu in the app header: this workspace's file-type actions.
  const menu = useMemo(
    () => [
      {
        title: "Export",
        items: [
          { label: "Export PDF", icon: "download", onSelect: exportPdfNow, id: "export-pdf" },
          { label: "Export PNG", icon: "download", onSelect: () => void exportImage(rf, { format: "png", pixelRatio: 4 }), id: "export-png" },
          { label: "Export SVG", icon: "download", onSelect: () => void exportImage(rf, { format: "svg" }), id: "export-svg" },
          { label: "Export DXF", icon: "download", onSelect: () => void exportDxf(rf), id: "export-dxf" },
          { label: "Export rack PDF", icon: "download", onSelect: () => void exportRackPdf(), id: "export-rack-pdf" },
          { label: "Export print sheets", icon: "print", onSelect: () => void exportPrintSheets(), id: "export-print-sheets" },
          { label: "Title block…", icon: "settings", onSelect: () => setTitleBlock(true), id: "title-block" },
          { label: "Download a copy (.json)", icon: "save", shortcut: "Ctrl+Shift+S", onSelect: downloadCopy, id: "download-json" },
        ] as MenuEntry[],
      },
      {
        title: "Reports",
        items: [
          { label: "Device list", icon: "report", onSelect: () => setReportsTab("devices"), id: "report-devices" },
          { label: "Cable schedule", icon: "report", onSelect: () => setReportsTab("cableSchedule"), id: "report-cable-schedule" },
          { label: "Patch panels", icon: "report", onSelect: () => setReportsTab("patchPanel"), id: "report-patch-panels" },
          { label: "Pack list", icon: "report", onSelect: () => setReportsTab("packList"), id: "report-pack-list" },
          { label: "Network report", icon: "report", onSelect: () => setReportsTab("network"), id: "report-network" },
          { label: "Power report", icon: "report", onSelect: () => setReportsTab("power"), id: "report-power" },
          { label: "Room distances…", icon: "room", onSelect: () => setDistances(true), id: "room-distances" },
        ] as MenuEntry[],
      },
      {
        title: "Schematic",
        items: [
          { label: "Editor preferences…", icon: "settings", onSelect: () => setPrefs(true), id: "preferences" },
          { label: "Save now", icon: "save", shortcut: "Ctrl+S", onSelect: () => sync?.flushNow(), id: "save-now" },
          { label: "Reload the saved schematic", icon: "refresh", hint: "Discards changes that are not saved", onSelect: () => void sync?.load("Reloaded the saved schematic."), id: "reload" },
        ] as MenuEntry[],
      },
    ],
    [rf, exportPdfNow, exportRackPdf, exportPrintSheets, downloadCopy, sync],
  );
  useEffect(() => {
    setChrome({ menu });
  }, [menu]);
  useEffect(() => () => setChrome({ menu: null }), []);

  const s = () => useSchematicStore.getState();
  const view: MenuEntry[] = [
    { label: "Fit to screen", icon: "grid", onSelect: () => void rf.fitView({ duration: 200, padding: 0.1 }), id: "fit" },
    { type: "separator" },
    { label: "Print view", shortcut: "F9", checked: printView, onSelect: () => s().setPrintView(!printView), id: "print-view" },
    { label: "Minimap", checked: showMinimap, onSelect: () => s().setShowMinimap(!showMinimap), id: "minimap" },
    { label: "Auto-route cables", checked: autoRoute, onSelect: () => s().toggleAutoRoute(), id: "auto-route" },
    { label: "Hide unconnected ports", checked: hideUnconnectedPorts, onSelect: () => s().setHideUnconnectedPorts(!hideUnconnectedPorts), id: "hide-unconnected" },
    { label: "Owned gear in the library", checked: showOwnedGearPane, onSelect: () => s().setShowOwnedGearPane(!showOwnedGearPane), id: "owned-gear" },
    { type: "separator" },
    { label: "Debug cable routing", shortcut: "Ctrl+B", checked: debugEdges, onSelect: () => s().toggleDebugEdges(), id: "debug-edges" },
  ];

  return (
    <>
      <div data-bk-chrome data-brink-toolbar>
      <Toolbar
        label="Schematic tools"
        end={
          <>
            <IconButton icon="library" label="Device library" pressed={library} onClick={() => setSession({ library: !library })} data-action="toggle-library" />
            <IconButton icon="inspector" label="Inspector and layers" pressed={right} onClick={() => setSession({ right: !right })} data-action="toggle-inspector" />
          </>
        }
      >
        <ToolbarGroup label="History">
          <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" disabled={undoSize === 0} onClick={undo} />
          <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" disabled={redoSize === 0} onClick={redo} />
        </ToolbarGroup>
        <ToolbarDivider />
        <Menu
          label="Insert"
          icon="plus"
          testId="insert"
          items={[
            { label: "Room", icon: "room", onSelect: () => s().addRoom("Room", centre(), { width: 400, height: 300 }), id: "insert-room" },
            { label: "Note", icon: "note", onSelect: () => s().addNote(centre()), id: "insert-note" },
            { type: "heading", label: "Shapes" },
            { label: "Rectangle", icon: "shape", onSelect: () => addAnnotation("rectangle") },
            { label: "Ellipse", icon: "shape", onSelect: () => addAnnotation("ellipse") },
            { label: "Circle", icon: "shape", onSelect: () => addAnnotation("circle") },
            { label: "Diamond", icon: "shape", onSelect: () => addAnnotation("diamond") },
            { label: "Triangle", icon: "shape", onSelect: () => addAnnotation("triangle") },
            { type: "separator" },
            { label: "Device from the library", icon: "library", hint: "Drag a device from the library panel onto the canvas", onSelect: () => setSession({ library: true }) },
          ]}
        />
        <Menu
          label="Edit"
          testId="edit"
          items={[
            { label: "Copy", shortcut: "Ctrl+C", onSelect: () => s().copySelected() },
            { label: "Paste", shortcut: "Ctrl+V", onSelect: () => s().pasteClipboard() },
            { label: "Delete", shortcut: "Del", onSelect: () => s().removeSelected() },
            { type: "separator" },
            { label: "Select all", shortcut: "Ctrl+A", onSelect: () => s().selectAll() },
            { type: "separator" },
            { label: "Reset all routes", hint: "Clear every manual route so the whole schematic re-auto-routes (undoable)", onSelect: () => s().clearAllManualWaypoints() },
          ]}
        />
        <Menu label="Align" icon="align" testId="align" items={ALIGN.map((a) => ({ label: a.label, disabled: selected < 2, hint: selected < 2 ? "Select two or more elements" : undefined, onSelect: () => s().alignSelectedNodes(a.op) }))} />
        <Menu label="View" icon="eye" testId="view" items={view} />
      </Toolbar>
      </div>
      {/* Upstream's dialogs, outside the Brink chrome: they keep all of their own keyboard handling. */}
      {reportsTab && <ReportsDialog initialTab={reportsTab} onClose={() => setReportsTab(null)} />}
      {titleBlock && <TitleBlockDialog onClose={() => setTitleBlock(false)} />}
      {prefs && <PreferencesDialog onClose={() => setPrefs(false)} />}
      {distances && <RoomDistancesDialog onClose={() => setDistances(false)} />}
    </>
  );
}
