// Toasts: short, non-blocking messages, bottom-right, announced politely to screen
// readers. One store for the whole app: Brink code calls toast(); EasySchematic's own
// addToast() lands here too (its ToastContainer is replaced, web/src/es/overrides/ToastContainer.tsx).
import { useSyncExternalStore } from "react";
import { Icon, type IconName } from "../icons.js";

export type ToastTone = "info" | "ok" | "warn" | "danger";
export interface ToastItem {
  id: string;
  tone: ToastTone;
  text: string;
}

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
let seq = 0;
const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: string): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Show a toast; returns its id. `ms` 0 keeps it until dismissed. */
export function toast(text: string, tone: ToastTone = "info", ms = 5000): string {
  const id = `t${++seq}`;
  items = [...items.slice(-4), { id, tone, text }];
  emit();
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const ICON: Record<ToastTone, IconName> = { info: "info", ok: "check", warn: "warn", danger: "error" };
const ACCENT: Record<ToastTone, string> = { info: "text-accent", ok: "text-ok", warn: "text-warn", danger: "text-danger" };

/** Renders the extra toasts passed in (EasySchematic's) after the app's own. */
export function Toaster({ extra = [], onDismissExtra }: { extra?: ToastItem[]; onDismissExtra?: (id: string) => void }) {
  const own = useSyncExternalStore(subscribe, () => items);
  const all = [...own.map((t) => ({ ...t, own: true })), ...extra.map((t) => ({ ...t, own: false }))];
  return (
    <div className="bk pointer-events-none fixed right-4 bottom-4 z-[400] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" role="region" aria-label="Notifications">
      <div aria-live="polite" className="contents">
        {all.map((t) => (
          <div
            key={t.id}
            data-toast={t.tone}
            className="pointer-events-auto flex items-start gap-2.5 rounded-panel border border-line bg-panel px-3.5 py-2.5 text-sm text-ink shadow-lg [animation:bk-toast-in_.18s_ease-out]"
          >
            <Icon name={ICON[t.tone]} className={`mt-0.5 shrink-0 ${ACCENT[t.tone]}`} />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.text}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="bk-focus -mr-1 shrink-0 cursor-pointer rounded-ctl p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
              onClick={() => (t.own ? dismissToast(t.id) : onDismissExtra?.(t.id))}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
