// Tabs (ARIA tabs pattern, automatic activation): Left / Right / Home / End move
// between tabs and select them; only the selected tab is in the tab order.
// `TabList` is the in-page version (panels below); routed tabs use NavLink with the
// same look via `tabClass`.
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";

export interface TabDef<K extends string> {
  key: K;
  label: string;
  icon?: IconName;
  badge?: ReactNode;
}

export const tabClass = (active: boolean, compact = false) =>
  `bk-focus relative inline-flex items-center gap-1.5 whitespace-nowrap no-underline ${compact ? "h-9 px-2 text-xs" : "h-11 px-3 text-sm"} font-medium transition-colors ${
    active ? "text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink" : "text-ink-3 hover:text-ink"
  }`;

export function TabList<K extends string>({
  tabs,
  value,
  onChange,
  label,
  compact,
  idBase,
}: {
  tabs: TabDef<K>[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  compact?: boolean;
  /** Tab i is `${idBase}-tab-${key}` and controls `${idBase}-panel-${key}`. */
  idBase: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === value);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(tabs[n]!.key);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-tab-key="${tabs[n]!.key}"]`)?.focus());
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} onKeyDown={onKey} className="flex gap-0.5 overflow-x-auto [scrollbar-width:none]">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.key}`}
          aria-selected={t.key === value}
          aria-controls={`${idBase}-panel-${t.key}`}
          tabIndex={t.key === value ? 0 : -1}
          data-tab-key={t.key}
          onClick={() => onChange(t.key)}
          className={tabClass(t.key === value, compact)}
        >
          {t.icon && <Icon name={t.icon} size={14} />}
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ idBase, k, children, className = "" }: { idBase: string; k: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${k}`} aria-labelledby={`${idBase}-tab-${k}`} className={className}>
      {children}
    </div>
  );
}
