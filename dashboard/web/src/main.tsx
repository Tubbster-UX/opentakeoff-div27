// Brink app: one site per brink-merge project, live. The Schematic tab edits (Phase 2); everything else reads.
//   /                         Projects
//   /projects/:id/takeoff     OpenTakeoff canvas (Phase 3 placeholder)
//   /projects/:id/schematic   EasySchematic editor, mounted in the app (the edit layer)
//   /projects/:id/bom         BOM & Issues (live)
//   /design                   The Brink design system's kitchen sink (for review)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useParams } from "react-router";
import { Shell } from "./components/Shell.js";
import { Notice } from "./components/ui.js";
import "./design/theme.js";
import favicon from "../public/brand/brink-design-app-icon.svg";
import appIcon from "../public/brand/brink-design-app-icon-512.png";
import { DesignPage } from "./pages/DesignPage.js";
import { ProjectLayout } from "./pages/ProjectLayout.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { DEFAULT_TAB, PROJECT_TABS } from "./workspaces.js";
// Roboto, the Brink Design typeface (Brand Guidelines v1.0), bundled: no external font request.
import "@fontsource/roboto/latin-300.css";
import "@fontsource/roboto/latin-ext-300.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-ext-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-ext-500.css";
import "@fontsource/roboto/latin-700.css";
import "@fontsource/roboto/latin-ext-700.css";
import "./app.css";

// The app icon (interim, from the shield master: web/public/brand/README.md): the shield is
// below its 80 px minimum at favicon size, so browsers get the app icon and scale it.
for (const [rel, href, type] of [
  ["icon", favicon, "image/svg+xml"],
  ["apple-touch-icon", appIcon, "image/png"],
] as const) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  link.type = type;
  document.head.appendChild(link);
}

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
      { path: "design", element: <DesignPage /> },
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
