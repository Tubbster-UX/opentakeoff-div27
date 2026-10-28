import type { ReactNode } from "react";
import { Badge, Icon, type IconName } from "../design/index.js";

/** A clearly labeled slot for a workspace a later phase mounts. */
export function Placeholder({ phase, title, icon = "plan", children }: { phase: string; title: string; icon?: IconName; children: ReactNode }) {
  return (
    <section data-placeholder={phase} className="mb-4 flex flex-col items-center rounded-panel border border-dashed border-line-strong bg-panel px-6 py-12 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Icon name={icon} size={22} />
      </span>
      <Badge tone="accent">{phase} · not built yet</Badge>
      <h2 className="mt-3 mb-2 text-lg font-semibold">{title}</h2>
      <div className="max-w-xl space-y-2 text-sm text-ink-2 [&_p]:m-0">{children}</div>
    </section>
  );
}
