import type { ReactNode } from "react";

/** A clearly labeled slot for a workspace a later phase mounts. */
export function Placeholder({ phase, title, children }: { phase: string; title: string; children: ReactNode }) {
  return (
    <section data-placeholder={phase} className="mb-3.5 border border-dashed border-accent bg-accent-soft px-4 py-3.5">
      <div className="font-mono text-[11px] font-semibold tracking-wide text-accent uppercase">{phase} · not built yet</div>
      <h2 className="mt-1 mb-1.5 text-base font-semibold">{title}</h2>
      <div className="space-y-1.5 text-sm [&_p]:m-0">{children}</div>
    </section>
  );
}
