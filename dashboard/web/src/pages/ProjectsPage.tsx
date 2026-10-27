import { useEffect } from "react";
import { Link } from "react-router";
import type { PortalPushSummary } from "../../../src/shared/protocol.js";
import { DataTable, Notice, Panel, Tag, type Column } from "../components/ui.js";
import { fmt, when } from "../lib/format.js";
import { useProjectList } from "../lib/useProjectList.js";

function PushCell({ push }: { push: PortalPushSummary | null }) {
  if (!push) return <span className="text-muted">never</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={[`created ${when(push.created_at)}`, push.finished_at ? `finished ${when(push.finished_at)}` : "", push.error ?? ""].filter(Boolean).join(" · ")}>
      <Tag v={push.status} />
      {push.dry_run && <span className="font-mono text-[11px] text-muted">dry run</span>}
      {push.portal_proposal_id != null && <span className="font-mono text-[11px]">#{push.portal_proposal_id}</span>}
      {!push.is_current_import && <span className="text-[11px] text-warn">older import</span>}
    </span>
  );
}

export function ProjectsPage() {
  const { list, error, changed } = useProjectList();
  useEffect(() => {
    document.title = "Projects · Brink";
  }, []);

  if (!list) return error ? <Notice tone="error">Could not read projects ({error}).</Notice> : <p className="text-muted">Loading projects…</p>;

  const pushes = list.features.portalPushes;
  const columns: Column[] = [
    { label: "Project" },
    { label: "Current import" },
    { label: "Devices", numeric: true },
    { label: "Cables", numeric: true },
    { label: "Net LF", numeric: true },
    { label: "Order LF", numeric: true },
    { label: "Errors", numeric: true },
    { label: "Warnings", numeric: true },
    ...(pushes ? [{ label: "Portal push" }] : []),
  ];

  return (
    <>
      <h1 className="mt-1 mb-0.5 text-xl font-semibold">Projects</h1>
      <p className="m-0 text-xs text-muted">Every brink-merge project and its current import. Totals are the current import&apos;s BOM; they update live.</p>
      {error && <Notice tone="error">Last refresh failed ({error}); showing the previous read.</Notice>}
      <div className="mt-3.5">
        <Panel title="All projects" count={list.projects.length}>
          <DataTable
            columns={columns}
            empty="No projects yet. Import one with brink-merge --db."
            rows={list.projects.map((p) => (
              <tr key={`${p.id}:${changed[p.id] ?? 0}`} data-project={p.id} className={changed[p.id] ? "flash" : undefined}>
                <td className="min-w-[180px]">
                  <Link to={`/projects/${p.id}`} className="font-semibold">
                    {p.name}
                  </Link>
                </td>
                <td className="whitespace-nowrap">{p.current_import_id ? when(p.imported_at) : <span className="text-muted">none</span>}</td>
                <td className="num">{fmt(p.devices)}</td>
                <td className="num">{fmt(p.cables)}</td>
                <td className="num">{fmt(p.net_lf)}</td>
                <td className="num">{fmt(p.order_lf)}</td>
                <td className={`num ${p.errors ? "text-error font-semibold" : ""}`}>{fmt(p.errors)}</td>
                <td className={`num ${p.warnings ? "text-warn" : ""}`}>{fmt(p.warnings)}</td>
                {pushes && (
                  <td>
                    <PushCell push={p.portal_push} />
                  </td>
                )}
              </tr>
            ))}
          />
        </Panel>
      </div>
      <p id="portal-push-note" className="m-0 text-xs text-muted">
        {pushes
          ? "Portal push: the latest push per project (brink_portal_pushes)."
          : "Portal push status is not shown: this database has no brink_portal_pushes table (brink-merge's Portal push migration has not been applied)."}
        {" "}Read {when(list.readAt)}.
      </p>
    </>
  );
}
