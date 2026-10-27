// Takeoff: Phase 3 mounts the OpenTakeoff plan canvas here. Until then, where
// the current import came from (the hashes of the OpenTakeoff files brink-merge
// stored), so a number can still be traced to its export.
import { Panel } from "../../components/ui.js";
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
    <>
      <Placeholder phase="Phase 3" title="OpenTakeoff plan canvas">
        <p>
          The OpenTakeoff canvas mounts in this tab: the project&apos;s plan sheets (PDFs kept in Supabase Storage) with the Division 27 takeoff drawn over them, editable in
          place.
        </p>
        <p className="text-muted">Phase 1 has no plan view. The current import&apos;s source files are below.</p>
      </Placeholder>
      <Panel title="Current import source">
        {imp ? (
          <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2.5 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-xs text-muted sm:text-sm">{k}</dt>
                <dd className="m-0 mb-1.5 font-mono text-xs [overflow-wrap:anywhere] sm:mb-0">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="m-0 p-4 text-center text-muted">No current import.</p>
        )}
      </Panel>
    </>
  );
}
