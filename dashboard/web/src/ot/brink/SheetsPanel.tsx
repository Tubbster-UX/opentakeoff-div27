// The sheets panel (left). The project's plan files (brink_sheets, PDFs in Supabase
// Storage) and their pages, with how many takeoffs each page carries. It replaces
// upstream's sheet tabs, sheet chip and plan gallery as the way to move between sheets;
// it calls the canvas's own openSheets / closePdf, and its upload is upstream's own file
// input (so upstream's ingest, revision notice and sheet naming all run as they do).
import { useState } from "react";
import { Button, Icon, IconButton, SidePanel } from "../../design/index.js";
import { getHost, useHost } from "../host";
import { setSession, useSession } from "../session";

interface Row {
  key: string;
  label: string;
  file: string;
  page: number;
  shapes: number;
}

export function SheetsPanel() {
  const { status } = useSession();
  const [confirm, setConfirm] = useState<string | null>(null);
  const v = useHost(
    (h) => {
      const counts = new Map<string, number>();
      for (const s of h.shapes) counts.set(s.sheet_id, (counts.get(s.sheet_id) ?? 0) + 1);
      const rows: Row[] = [];
      for (const f of h.sheets) {
        const n = h.knownPages[f.name] || (f.name === h.active ? h.pageCount : 1);
        for (let p = 1; p <= n; p++) {
          const key = p > 1 ? `${f.name}#${p}` : f.name;
          rows.push({ key, label: h.tabLabel(key), file: f.name, page: p, shapes: counts.get(key) ?? 0 });
        }
      }
      const files = new Set(h.sheets.map((f) => f.name));
      const missing = [...counts].filter(([k]) => !files.has(k.split("#")[0]!)).map(([k, n]) => `${k}\u0000${n}`);
      return { rows: JSON.stringify(rows), current: h.view === "canvas" ? h.sheetKey : "", missing: missing.join("\u0001"), files: h.sheets.length };
    },
    { rows: "[]", current: "", missing: "", files: 0 },
  );
  const rows = JSON.parse(v.rows) as Row[];
  const missing = v.missing ? v.missing.split("\u0001").map((m) => m.split("\u0000") as [string, string]) : [];
  const canWrite = !!status?.editor;
  const byFile = new Map<string, Row[]>();
  for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);

  return (
    <SidePanel title="Sheets" side="left" width={264} id="ot-sheets" onClose={() => setSession({ sheets: false })}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Button size="sm" variant="secondary" icon="upload" disabled={!canWrite} onClick={() => getHost()?.fileInputRef.current?.click()} title={canWrite ? "Upload plan PDFs (or drop them on the canvas)" : "Uploading needs your Cloudflare Access sign-in"} data-action="upload-plan">
          Upload plan
        </Button>
        <span className="num ml-auto text-xs text-ink-3">
          {v.files} file{v.files === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 px-3 py-4 text-sm text-ink-3">No plan files yet. Upload the plan PDF to draw on it.</p>
      ) : (
        <ul className="m-0 list-none p-0" data-sheet-list>
          {[...byFile].map(([file, pages]) => (
            <li key={file} className="border-b border-line">
              <div className="flex items-center gap-1.5 pt-2 pr-1.5 pb-1 pl-3">
                <Icon name="plan" size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-2" title={file}>
                  {file}
                </span>
                <IconButton icon="trash" size="sm" label={`Remove ${file} from the plan set`} disabled={!canWrite} onClick={() => setConfirm(file)} />
              </div>
              {confirm === file && (
                <div className="mx-3 mb-2 rounded-ctl border border-line bg-panel p-2 text-xs text-ink-2" role="alert">
                  Remove {file} from the plan set? Its takeoffs stay in the project and show again if the file is uploaded again. The stored file is kept.
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setConfirm(null);
                        void getHost()?.closePdf(file);
                      }}
                    >
                      Remove
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => setConfirm(null)}>
                      Keep
                    </Button>
                  </div>
                </div>
              )}
              <ul className="m-0 list-none pb-1.5 pl-0">
                {pages.map((r) => {
                  const on = r.key === v.current;
                  return (
                    <li key={r.key}>
                      <button
                        type="button"
                        aria-current={on ? "page" : undefined}
                        data-sheet={r.key}
                        className={`bk-focus flex w-full cursor-pointer items-center gap-2 py-1.5 pr-3 pl-8 text-left text-sm ${on ? "bg-accent-soft font-medium text-ink" : "text-ink-2 hover:bg-hover"}`}
                        onClick={() => getHost()?.openSheets([r.key], false)}
                      >
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        <span className="num shrink-0 text-xs text-ink-3" title={`${r.shapes} takeoff${r.shapes === 1 ? "" : "s"} on this sheet`}>
                          {r.shapes}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <div className="border-t border-line px-3 py-2 text-xs text-ink-3" data-missing-sheets>
          <p className="m-0 mb-1 font-medium text-ink-2">Takeoffs on sheets with no plan file</p>
          <ul className="m-0 list-none p-0">
            {missing.map(([k, n]) => (
              <li key={k} className="flex gap-2 py-0.5">
                <span className="min-w-0 flex-1 truncate font-num">{k}</span>
                <span className="num">{n}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-1">Upload a file with that name to see them.</p>
        </div>
      )}
    </SidePanel>
  );
}
