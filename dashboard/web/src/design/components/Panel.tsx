import type { ReactNode } from "react";
import { IconButton } from "./Button.js";

/** A titled content panel (cards on the Projects / BOM pages). */
export function Panel({ title, count, children, id, actions, className = "" }: { title: string; count?: ReactNode; children: ReactNode; id?: string; actions?: ReactNode; className?: string }) {
  return (
    <section id={id} aria-label={title} className={`mb-4 min-w-0 overflow-hidden rounded-panel border border-line bg-panel shadow-sm ${className}`}>
      <header className="flex min-h-11 items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="m-0 text-lg font-bold">{title}</h2>
        {count != null && <span className="num text-xs text-ink-3">{count}</span>}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * A docked side panel (the schematic's library / inspector). It fills the height it is
 * given; the header holds the title, optional tabs and a close button.
 */
export function SidePanel({
  title,
  side,
  onClose,
  children,
  tabs,
  width = 300,
  id,
}: {
  title: string;
  side: "left" | "right";
  onClose?: () => void;
  children: ReactNode;
  tabs?: ReactNode;
  width?: number;
  id?: string;
}) {
  return (
    <aside
      id={id}
      aria-label={title}
      data-bk-chrome
      style={{ width }}
      className={`flex h-full min-h-0 shrink-0 flex-col bg-panel-2 ${side === "left" ? "border-r" : "border-l"} border-line`}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <h2 className="m-0 flex-1 truncate bk-label text-ink-3">{title}</h2>
        {onClose && <IconButton icon="close" label={`Close ${title.toLowerCase()}`} size="sm" onClick={onClose} />}
      </header>
      {tabs && <div className="shrink-0 border-b border-line px-2">{tabs}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

/** A label / value list (inspector, import details). */
export function PropertyList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(84px,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
