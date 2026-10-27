// /projects/:id: the project header and its tabs. One ProjectStore (snapshot +
// live socket) per project, created here and shared with every tab through
// context, so switching tabs keeps the connection and the data.
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useParams } from "react-router";
import { Notice } from "../components/ui.js";
import { str, when } from "../lib/format.js";
import { ProjectStoreContext, useProject } from "../lib/projectContext.js";
import { ProjectStore } from "../lib/projectStore.js";
import { PROJECT_TABS } from "../workspaces.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ProjectLayout() {
  const { id = "" } = useParams();
  const [store, setStore] = useState<ProjectStore | null>(null);

  useEffect(() => {
    if (!UUID.test(id)) return;
    const s = new ProjectStore(id);
    s.start();
    setStore(s);
    return () => {
      s.stop();
      setStore(null);
    };
  }, [id]);

  if (!UUID.test(id)) return <Notice tone="error">Not a project id.</Notice>;
  if (!store) return null;
  return (
    <ProjectStoreContext.Provider value={store}>
      <ProjectFrame />
    </ProjectStoreContext.Provider>
  );
}

function ProjectFrame() {
  const { snap, notFound, error } = useProject();
  useEffect(() => {
    if (snap) document.title = `${str(snap.project.name)} · Brink`;
  }, [snap?.project.name]);

  if (notFound)
    return (
      <Notice tone="error">
        No such project. <Link to="/">All projects</Link>
      </Notice>
    );
  if (!snap) return error ? <Notice tone="error">{error}</Notice> : <p className="text-muted">Loading project…</p>;

  const imp = snap.import;
  return (
    <>
      <nav className="text-xs">
        <Link to="/">Projects</Link> <span className="text-muted">/</span>
      </nav>
      <h1 className="mt-1 mb-0.5 text-xl font-semibold">{str(snap.project.name)}</h1>
      <div className="meta font-mono text-xs text-muted [overflow-wrap:anywhere]">
        {imp
          ? `import ${str(imp.id)} · imported ${when(imp.imported_at)} · ${str(imp.ot_schema)} · EasySchematic v${str(imp.es_schema_version)}`
          : "no current import"}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="table-scroll mt-3 border-b border-line" role="tablist" aria-label="Project views">
        <div className="flex min-w-max gap-1">
          {PROJECT_TABS.map((t) => (
            <NavLink
              key={t.path}
              to={t.path}
              role="tab"
              data-tab={t.path}
              className={({ isActive }) =>
                `-mb-px whitespace-nowrap border-b-2 px-2.5 py-2 sm:px-3 text-sm font-semibold no-underline ${isActive ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`
              }
            >
              {t.label}
              {t.phase && <span className="ml-1.5 font-mono text-[10px] font-normal text-muted">{t.phase}</span>}
            </NavLink>
          ))}
        </div>
      </div>
      <div className="pt-3.5">
        <Outlet />
      </div>
    </>
  );
}
