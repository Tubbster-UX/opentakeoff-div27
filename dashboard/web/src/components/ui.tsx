// Page-level pieces built from the Brink design system (web/src/design/).
import type { ReactNode } from "react";
import { Icon } from "../design/index.js";

export { Panel, DataTable, Tag, type Column } from "../design/index.js";

/** A page: title row, optional meta line and actions, then content, at a readable max width. */
export function Page({ title, meta, actions, children, wide }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wide ? "max-w-[1440px]" : "max-w-[1280px]"} px-4 pt-5 pb-10 sm:px-6`}>
      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-xl font-bold">{title}</h1>
          {meta && <div className="meta mt-1 text-xs text-ink-3 [overflow-wrap:anywhere]">{meta}</div>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ k, v, tone }: { k: string; v: ReactNode; tone?: "warn" | "error" }) {
  const color = tone === "error" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rounded-panel border border-line bg-panel px-3.5 py-3 shadow-sm">
      <div className="bk-label text-ink-3">{k}</div>
      <div className={`num mt-1 text-xl font-bold leading-tight ${color}`}>{v}</div>
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2.5">{children}</div>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`notice mx-auto my-4 flex w-full max-w-[1280px] items-start gap-2.5 rounded-panel border px-4 py-3 text-sm ${tone === "error" ? "error border-danger/30 bg-danger-soft text-danger" : "border-line bg-panel text-ink-2"}`}
    >
      <Icon name={tone === "error" ? "error" : "info"} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Loading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 flex items-center gap-2 px-6 py-8 text-sm text-ink-3">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-hidden="true" />
      {children}
    </p>
  );
}
