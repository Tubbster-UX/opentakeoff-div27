import type { ReactNode } from "react";

export function Panel({ title, count, children, id }: { title: string; count?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-3.5 min-w-0 border border-line bg-surface">
      <header className="flex items-baseline gap-2 border-b border-line px-3 py-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {count != null && <span className="font-mono text-xs text-muted">{count}</span>}
      </header>
      {children}
    </section>
  );
}

export interface Column {
  label: string;
  numeric?: boolean;
}

/** A table that scrolls sideways inside its own box on narrow screens. Rows are passed in so callers keep their keys and live flags. */
export function DataTable({ columns, rows, empty }: { columns: Column[]; rows: ReactNode[]; empty: string }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.numeric ? "num" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows
          ) : (
            <tr>
              <td className="empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Stat({ k, v, tone }: { k: string; v: ReactNode; tone?: "warn" | "error" }) {
  const color = tone === "error" ? "text-error" : tone === "warn" ? "text-warn" : "";
  return (
    <div className="border border-line bg-surface px-3 py-2.5">
      <div className="text-xs text-muted">{k}</div>
      <div className={`font-mono text-xl font-semibold tabular-nums leading-tight ${color}`}>{v}</div>
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="my-3.5 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2">{children}</div>;
}

const TAG_TONE: Record<string, string> = {
  warning: "text-warn bg-warn-soft border-transparent",
  error: "text-error bg-error-soft border-transparent",
  proposed: "text-warn",
  confirmed: "text-ok",
  unmapped: "text-error",
  succeeded: "text-ok bg-ok-soft border-transparent",
  failed: "text-error bg-error-soft border-transparent",
  aborted: "text-error",
  started: "text-warn",
  planned: "text-muted",
};

export function Tag({ v }: { v: unknown }) {
  if (!v) return null;
  const s = String(v);
  return <span className={`tag inline-block whitespace-nowrap border border-line px-1.5 py-px font-mono text-[11px] font-semibold ${TAG_TONE[s] ?? ""}`}>{s}</span>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return <p className={`notice border border-line bg-surface p-3 ${tone === "error" ? "error text-error" : ""}`}>{children}</p>;
}
