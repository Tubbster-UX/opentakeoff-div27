import { useEffect } from "react";
import { Link } from "react-router";
import type { PortalPushSummary } from "../../../src/shared/protocol.js";
import { DataTable, Loading, Notice, Page, Panel, Tag, type Column } from "../components/ui.js";
import { fmt, when } from "../lib/format.js";
import { useProjectList } from "../lib/useProjectList.js";

function PushCell({ push }: { push: PortalPushSummary | null }) {
  if (!push) return <span className="text-ink-3">never</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={[`created ${when(push.created_at)}`, push.finished_at ? `finished ${when(push.finished_at)}` : "", push.error ?? ""].filter(Boolean).join(" · ")}>
      <Tag v={push.status} />
      {push.dry_run && <span className="text-2xs text-ink-3">dry run</span>}
      {push.portal_proposal_id != null && <span className="num text-2xs">#{push.portal_proposal_id}</span>}
      {!push.is_current_import && <span className="text-2xs text-warn">older import</span>}
    </span>
  );
}

export function ProjectsPage() {
  const { list, error, changed } = useProjectList();
  useEffect(() => {
    document.title = "Projects · Brink Design";
  }, []);

  if (!list) return error ? <Notice tone="error">Could not read projects ({error}).</Notice> : <Loading>Loading projects…</Loading>;

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
    <Page title="Projects" meta="Every brink-merge project and its current import. Totals are the current import's BOM; they update live.">
      {error && <Notice tone="error">Last refresh failed ({error}); showing the previous read.</Notice>}
      {/* Phone: one card per project, totals visible without sideways scrolling. */}
      <ul className="mb-4 list-none space-y-2 p-0 sm:hidden" aria-label="All projects">
        {list.projects.length === 0 && <li className="rounded-panel border border-line bg-panel p-4 text-center text-ink-3">No projects yet. Import one with brink-merge --db.</li>}
        {list.projects.map((p) => (
          <li key={`${p.id}:${changed[p.id] ?? 0}`} data-project-card={p.id} className={`rounded-panel border border-line bg-panel p-3.5 shadow-sm ${changed[p.id] ? "card-flash" : ""}`}>
            <Link to={`/projects/${p.id}`} className="font-semibold">
              {p.name}
            </Link>
            <div className="text-xs text-ink-3">{p.current_import_id ? `imported ${when(p.imported_at)}` : "no current import"}</div>
            <dl className="num m-0 mt-2.5 grid grid-cols-3 gap-x-2 gap-y-2 text-sm">
              {(
                [
                  ["Devices", fmt(p.devices), ""],
                  ["Cables", fmt(p.cables), ""],
                  ["Errors", fmt(p.errors), p.errors ? "text-danger font-semibold" : ""],
                  ["Net LF", fmt(p.net_lf), ""],
                  ["Order LF", fmt(p.order_lf), ""],
                  ["Warnings", fmt(p.warnings), p.warnings ? "text-warn" : ""],
                ] as const
              ).map(([k, v, cls]) => (
                <div key={k}>
                  <dt className="font-ui text-2xs text-ink-3">{k}</dt>
                  <dd className={`m-0 ${cls}`}>{v}</dd>
                </div>
              ))}
            </dl>
            {pushes && (
              <div className="mt-2 text-xs">
                <span className="text-ink-3">Portal push </span>
                <PushCell push={p.portal_push} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
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
                <td className="whitespace-nowrap text-ink-2">{p.current_import_id ? when(p.imported_at) : <span className="text-ink-3">none</span>}</td>
                <td className="num">{fmt(p.devices)}</td>
                <td className="num">{fmt(p.cables)}</td>
                <td className="num">{fmt(p.net_lf)}</td>
                <td className="num">{fmt(p.order_lf)}</td>
                <td className={`num ${p.errors ? "text-danger font-semibold" : ""}`}>{fmt(p.errors)}</td>
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
      <p id="portal-push-note" className="m-0 text-xs text-ink-3">
        {pushes
          ? "Portal push: the latest push per project (brink_portal_pushes)."
          : "Portal push status is not shown: this database has no brink_portal_pushes table (brink-merge's Portal push migration has not been applied)."}
        {" "}Read {when(list.readAt)}.
      </p>
    </Page>
  );
}
