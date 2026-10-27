// Brink app: one site per brink-merge project. Phase 1 is read-only and live.
//   /                         Projects
//   /projects/:id/takeoff     OpenTakeoff canvas (Phase 3 placeholder)
//   /projects/:id/schematic   EasySchematic editor (Phase 2 placeholder + read-only outline)
//   /projects/:id/bom         BOM & Issues (live)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useParams } from "react-router";
import { Shell } from "./components/Shell.js";
import { Notice } from "./components/ui.js";
import { ProjectLayout } from "./pages/ProjectLayout.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { DEFAULT_TAB, PROJECT_TABS } from "./workspaces.js";
import "./app.css";

/** The first dashboard's links were /p/:id. */
function LegacyProjectLink() {
  const { id } = useParams();
  return <Navigate to={`/projects/${id}/${DEFAULT_TAB}`} replace />;
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <ProjectsPage /> },
      {
        path: "projects/:id",
        element: <ProjectLayout />,
        children: [{ index: true, element: <Navigate to={DEFAULT_TAB} replace /> }, ...PROJECT_TABS.map((t) => ({ path: t.path, element: <t.Component /> }))],
      },
      { path: "p/:id", element: <LegacyProjectLink /> },
      { path: "*", element: <Notice tone="error">Page not found.</Notice> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
