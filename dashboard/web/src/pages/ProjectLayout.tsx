// /projects/:id: one ProjectStore (snapshot + live socket) per project, created
// here and shared with every tab through context, so switching tabs keeps the
// connection and the data. The project's name, switcher and tabs live in the one
// app header (components/Shell.tsx); this sets what it shows.
import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate, useParams } from "react-router";
import { Loading, Notice } from "../components/ui.js";
import { str, when } from "../lib/format.js";
import { setChrome } from "../lib/chrome.js";
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

  useEffect(() => () => setChrome({ project: null }), []);

  if (!UUID.test(id)) return <Notice tone="error">Not a project id.</Notice>;
  if (!store) return null;
  return (
    <ProjectStoreContext.Provider value={store}>
      <ProjectFrame />
    </ProjectStoreContext.Provider>
  );
}

/** The import line shown under page titles and in the switcher's tooltip. */
export function importLine(imp: Record<string, unknown> | null | undefined): string {
  return imp ? `import ${str(imp.id)} · imported ${when(imp.imported_at)} · ${str(imp.ot_schema)} · EasySchematic v${str(imp.es_schema_version)}` : "no current import";
}

function ProjectFrame() {
  const { snap, notFound, error } = useProject();
  const navigate = useNavigate();
  const id = snap ? str(snap.project.id) : "";
  const name = snap ? str(snap.project.name) : "";
  const line = importLine(snap?.import);

  useEffect(() => {
    if (!snap) return;
    document.title = `${name} · Brink Design`;
    setChrome({ project: { id, name, importLine: line } });
  }, [id, name, line, snap]);

  // Alt+1 / Alt+2 / Alt+3 switch tabs. Alt is used by no EasySchematic shortcut.
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const n = Number(e.code.replace("Digit", "")) - 1;
      const tab = PROJECT_TABS[n];
      if (!tab || !/^Digit\d$/.test(e.code)) return;
      e.preventDefault();
      navigate(`/projects/${id}/${tab.path}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, navigate]);

  if (notFound)
    return (
      <Notice tone="error">
        No such project. <Link to="/">All projects</Link>
      </Notice>
    );
  if (!snap) return error ? <Notice tone="error">{error}</Notice> : <Loading>Loading project…</Loading>;

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <Outlet />
    </>
  );
}
