import { Link, Outlet } from "react-router";
import { useLiveStatus } from "../lib/liveStatus.js";

const LABEL = { live: "Live", connecting: "Connecting", down: "Realtime down", unconfigured: "Realtime not configured", offline: "Offline" } as const;

const TONE: Record<keyof typeof LABEL, { pill: string; dot: string }> = {
  live: { pill: "text-ok border-ok", dot: "bg-ok" },
  connecting: { pill: "text-muted border-line", dot: "bg-warn" },
  down: { pill: "text-error border-error", dot: "bg-error" },
  unconfigured: { pill: "text-error border-error", dot: "bg-error" },
  offline: { pill: "text-muted border-line", dot: "bg-muted" },
};

export function LivePill() {
  const { state, detail } = useLiveStatus();
  const t = TONE[state];
  return (
    <span id="live" data-state={state} title={detail ?? "Live updates"} className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${t.pill}`}>
      <span className={`h-2 w-2 rounded-full ${t.dot}`} />
      <span id="live-text">{LABEL[state]}</span>
    </span>
  );
}

/** The app frame: header and the routed page. Every route renders inside it. */
export function Shell() {
  return (
    <>
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2.5">
        <Link to="/" className="font-semibold text-ink no-underline">
          Brink
        </Link>
        <span className="text-xs text-muted">internal · read-only</span>
        <LivePill />
      </header>
      <main className="mx-auto max-w-[1280px] p-4">
        <Outlet />
      </main>
    </>
  );
}
