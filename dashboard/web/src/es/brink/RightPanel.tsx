// The Brink right panel. It takes the place of upstream App's right-hand column
// (ViewOptionsPanel, ShowInfoPanel and SignalColorPanel side by side) through the
// override for src/components/ViewOptionsPanel.tsx; ShowInfoPanel and
// SignalColorPanel render nothing in that slot and appear here as tabs instead.
//   Inspector  the Brink inspector (selection, properties, takeoff source, name edit)
//   Layers     upstream View Options: signal-type visibility and colours
//   Show info  upstream Show Info (title block / show details)
//   Signals    upstream Signal Colors
//   Rows       the generated rows outline (read-only, live), from the Schematic tab
// Upstream panels are rendered in their "mobile" (full-width) mode; their own
// header row is hidden by CSS (the Brink panel header and tabs replace it).
import ViewOptionsPanel from "../../../../vendor/easyschematic/src/components/ViewOptionsPanel";
import ShowInfoPanel from "../../../../vendor/easyschematic/src/components/ShowInfoPanel";
import SignalColorPanel from "../../../../vendor/easyschematic/src/components/SignalColorPanel";
import { SidePanel, TabList, TabPanel, type TabDef } from "../../design/index.js";
import { setSession, useSession, type RightTab } from "../session";
import { Inspector } from "./Inspector";

const TABS: TabDef<RightTab>[] = [
  { key: "inspector", label: "Inspector" },
  { key: "layers", label: "Layers" },
  { key: "info", label: "Show info" },
  { key: "signals", label: "Signals" },
  { key: "rows", label: "Rows" },
];

export default function RightPanel(_props: { mobile?: boolean; onClose?: () => void }) {
  const { right, rightTab, outline } = useSession();
  if (!right) return null;
  const close = () => setSession({ right: false });
  return (
    <SidePanel
      title="Schematic panels"
      side="right"
      width={320}
      onClose={close}
      id="schematic-right-panel"
      tabs={<TabList idBase="esr" label="Schematic panels" value={rightTab} onChange={(k) => setSession({ rightTab: k })} tabs={TABS} compact />}
    >
      <TabPanel idBase="esr" k={rightTab} className="h-full">
        {rightTab === "inspector" && <Inspector />}
        {rightTab !== "inspector" && rightTab !== "rows" && (
          // Upstream panels, as upstream renders them (their inputs keep their own keyboard handling).
          <div className="bk-embed h-full" data-bk-embed>
            {rightTab === "layers" && <ViewOptionsPanel mobile onClose={close} />}
            {rightTab === "info" && <ShowInfoPanel mobile onClose={close} />}
            {rightTab === "signals" && <SignalColorPanel mobile onClose={close} />}
          </div>
        )}
        {rightTab === "rows" && outline}
      </TabPanel>
    </SidePanel>
  );
}
