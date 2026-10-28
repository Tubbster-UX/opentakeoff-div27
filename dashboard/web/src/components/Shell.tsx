// The app frame: ONE header for the whole product, then the routed view, which
// fills the rest of the viewport and scrolls inside itself (an app shell).
//
// Header, left to right: Brink logo, the project switcher, the project's tabs
// (Takeoff | Schematic | BOM & Issues), then the current workspace's save status,
// the live-updates status, the Project menu (exports, reports, print, title block:
// contributed by the workspace that is open), the theme toggle and the user menu
// (Cloudflare Access identity, About & licenses).
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { Dialog, Icon, IconButton, Logo, Menu, Status, Toaster, tabClass, toggleDark, useThemeMode, type MenuEntry, type Tone } from "../design/index.js";
import type { ProjectList } from "../../../src/shared/protocol.js";
import { useChrome } from "../lib/chrome.js";
import { useLiveStatus } from "../lib/liveStatus.js";
import { useMe } from "../lib/me.js";
import { PROJECT_TABS } from "../workspaces.js";
import { AboutDialog } from "./AboutDialog.js";

const LABEL = { live: "Live", connecting: "Connecting", down: "Realtime down", unconfigured: "Realtime not configured", offline: "Offline" } as const;
const TONE: Record<keyof typeof LABEL, Tone> = { live: "ok", connecting: "warn", down: "danger", unconfigured: "danger", offline: "neutral" };

export function LivePill() {
  const { state, detail } = useLiveStatus();
  return (
    <span id="live" data-state={state} title={detail ?? "Live updates"} className="inline-flex shrink-0">
      <Status tone={TONE[state]} pulse={state === "connecting"}>
        <span id="live-text">{LABEL[state]}</span>
      </Status>
    </span>
  );
}

function ProjectSwitcher({ id, name, importLine }: { id: string; name: string; importLine: string }) {
  const navigate = useNavigate();
  const [list, setList] = useState<ProjectList | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ProjectList>) : null))
      .then((l) => live && setList(l))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  const items: MenuEntry[] = [
    { type: "heading", label: "Switch project" },
    ...(list?.projects ?? []).map((p) => ({ label: p.name, checked: p.id === id, onSelect: () => navigate(`/projects/${p.id}`), id: `project-${p.id}` })),
    { type: "separator" },
    { label: "All projects", icon: "grid", onSelect: () => navigate("/") },
  ];
  return (
    <span className="flex min-w-0 items-center" title={importLine}>
      <Menu label={<span className="max-w-[16rem] truncate font-semibold text-ink">{name}</span>} ariaLabel={`Project: ${name}. Switch project`} items={items} testId="project-switcher" triggerClassName="min-w-0 max-w-full" />
    </span>
  );
}

function ProjectMenu({ sections }: { sections: { title: string; items: MenuEntry[] }[] | null }) {
  const items: MenuEntry[] = sections?.length
    ? sections.flatMap((s, i) => [...(i ? [{ type: "separator" as const }] : []), { type: "heading" as const, label: s.title }, ...s.items])
    : [{ type: "heading", label: "Exports and reports" }, { label: "Open the Schematic tab for exports and reports", disabled: true, onSelect: () => undefined }];
  return <Menu label="Project" icon="report" items={items} align="end" testId="project-menu" />;
}

function UserMenu({ onAbout }: { onAbout: () => void }) {
  const me = useMe();
  const email = me?.email ?? null;
  const items: MenuEntry[] = [
    { type: "heading", label: email ? (me?.auth === "dev-bypass" ? "Local dev identity" : "Signed in with Cloudflare Access") : "Not signed in" },
    { label: email ?? "No Access identity: edits cannot be saved", disabled: true, onSelect: () => undefined, id: "user-email" },
    { type: "separator" },
    { label: "About & licenses", icon: "info", onSelect: onAbout, id: "about" },
  ];
  return (
    <span data-brink-editor={email ?? ""} className="inline-flex">
      <Menu
        label={<span className="hidden max-w-[14rem] truncate lg:inline">{email ?? "Not signed in"}</span>}
        ariaLabel={email ? `Signed in as ${email}` : "Not signed in"}
        icon="user"
        items={items}
        align="end"
        testId="user-menu"
      />
    </span>
  );
}

export function AppHeader() {
  const { project, status, menu } = useChrome();
  const { dark } = useThemeMode();
  const [about, setAbout] = useState(false);
  return (
    <header data-bk-chrome data-print-hide className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0 border-b border-line bg-panel pl-3 pr-2 shadow-sm">
      <Link to="/" className="bk-focus flex h-12 shrink-0 items-center gap-2.5 rounded-ctl pr-1 text-ink no-underline hover:text-ink" aria-label="Brink Design: all projects">
        <Logo size={30} />
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">Brink Design</span>
      </Link>
      {project && (
        <>
          <span aria-hidden="true" className="h-5 w-px bg-line" />
          <ProjectSwitcher {...project} />
          <nav aria-label="Project views" className="order-last -mx-3 flex w-[calc(100%+20px)] overflow-x-auto border-t border-line px-2 [scrollbar-width:none] md:order-none md:mx-0 md:w-auto md:border-t-0 md:px-0">
            {PROJECT_TABS.map((t, i) => (
              <NavLink key={t.path} to={`/projects/${project.id}/${t.path}`} data-tab={t.path} title={`${t.label} (Alt+${i + 1})`} className={({ isActive }) => tabClass(isActive)}>
                <Icon name={t.icon} size={15} />
                {t.label}
                {t.phase && <span className="rounded-full bg-hover px-1.5 text-2xs font-medium text-ink-3">{t.phase}</span>}
              </NavLink>
            ))}
          </nav>
        </>
      )}
      <div className="ml-auto flex h-12 shrink-0 items-center gap-1.5">
        {status && <div className="hidden items-center sm:flex">{status}</div>}
        <span className="px-1.5">
          <LivePill />
        </span>
        {project && <ProjectMenu sections={menu} />}
        <IconButton icon={dark ? "sun" : "moon"} label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleDark} data-action="toggle-theme" />
        <UserMenu onAbout={() => setAbout(true)} />
      </div>
      <Dialog open={about} title="About & licenses" onClose={() => setAbout(false)} width={600}>
        <AboutDialog />
      </Dialog>
    </header>
  );
}

/** Every route renders inside this. */
export function Shell() {
  return (
    <div className="bk flex h-dvh flex-col bg-app text-ink">
      <a href="#main" className="bk-focus sr-only z-50 rounded-ctl bg-panel px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2">
        Skip to content
      </a>
      <AppHeader />
      <main id="main" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
