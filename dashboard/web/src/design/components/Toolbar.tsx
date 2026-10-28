import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * A toolbar (ARIA toolbar pattern): Left / Right / Home / End move focus between its
 * controls (each also stays reachable with Tab). Children are Buttons, IconButtons, Menus, ToolbarGroups and
 * ToolbarDividers.
 */
export function Toolbar({ label, children, className = "", end }: { label: string; children: ReactNode; className?: string; end?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target.closest("[role=menu]") || target.tagName === "INPUT" || target.tagName === "SELECT") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])].filter((b) => !b.closest("[role=menu]"));
    const i = items.indexOf(target);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`flex min-h-11 items-center gap-1 border-b border-line bg-panel px-2 ${className}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">{children}</div>
      {end && <div className="flex shrink-0 items-center gap-1">{end}</div>}
    </div>
  );
}

export function ToolbarGroup({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-0.5">
      {children}
    </div>
  );
}

export function ToolbarDivider() {
  return <div role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px shrink-0 bg-line" />;
}
