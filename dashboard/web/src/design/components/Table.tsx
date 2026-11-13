import type { ReactNode } from "react";

export interface Column {
  label: string;
  numeric?: boolean;
}

/**
 * A data table. It scrolls sideways inside its own box on narrow screens (.table-scroll),
 * never the page. Rows are passed in so callers keep their keys and live-flash flags.
 */
export function DataTable({ columns, rows, empty, caption }: { columns: Column[]; rows: ReactNode[]; empty: string; caption?: string }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} scope="col" className={c.numeric ? "num" : undefined}>
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
