// Takeoff: Phase 3 mounts the OpenTakeoff plan canvas here. Until then, where
// the current import came from (the hashes of the OpenTakeoff files brink-merge
// stored), so a number can still be traced to its export.
import { Page, Panel } from "../../components/ui.js";
import { PropertyList } from "../../design/index.js";
import { importLine } from "../ProjectLayout.js";
import { Placeholder } from "../../components/Placeholder.js";
import { str, when } from "../../lib/format.js";
import { useProject } from "../../lib/projectContext.js";

export function TakeoffTab() {
  const { snap } = useProject();
  if (!snap) return null;
  const imp = snap.import;
  const rows: [string, string][] = imp
    ? [
        ["Import", str(imp.id)],
        ["Imported", when(imp.imported_at)],
        ["OpenTakeoff schema", str(imp.ot_schema)],
        ["Takeoff sha256", str(imp.takeoff_sha256)],
        ["Report sha256", str(imp.report_sha256) || "(no report)"],
      ]
    : [];

  return (
    <Page title="Takeoff" meta={importLine(imp)}>
      <Placeholder phase="Phase 3" title="OpenTakeoff plan canvas">
        <p>
          The OpenTakeoff canvas mounts in this tab: the project&apos;s plan sheets (PDFs kept in Supabase Storage) with the Division 27 takeoff drawn over them, editable in
          place.
        </p>
        <p className="text-ink-3">It will use this design system: the same header, a Brink toolbar for the takeoff tools, and side panels for sheets and conditions. Until then, the current import&apos;s source files are below.</p>
      </Placeholder>
      <Panel title="Current import source">
        {imp ? (
          <div className="px-4 py-3">
            <PropertyList rows={rows.map(([k, v]) => [k, <span className="font-num text-xs">{v}</span>])} />
          </div>
        ) : (
          <p className="m-0 p-4 text-center text-ink-3">No current import.</p>
        )}
      </Panel>
    </Page>
  );
}
