import type { ReactNode } from "react";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "bg-hover text-ink-2",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
};
const TEXT: Record<Tone, string> = { neutral: "text-ink-3", accent: "text-accent", ok: "text-ok", warn: "text-warn", danger: "text-danger" };
const DOT: Record<Tone, string> = { neutral: "bg-ink-3", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" };

/** A small status label. Colour is never the only signal: the text says it. */
export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`tag inline-flex h-5 items-center rounded-full px-2 text-2xs font-semibold whitespace-nowrap ${TONE[tone]} ${className}`}>{children}</span>;
}

/** A dot + text status (save state, live state). */
export function Status({ tone = "neutral", children, pulse, className = "", ...rest }: { tone?: Tone; children: ReactNode; pulse?: boolean; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${TEXT[tone]} ${className}`} {...rest}>
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]} ${pulse ? "animate-pulse" : ""}`} />
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  warning: "warn",
  error: "danger",
  proposed: "warn",
  confirmed: "ok",
  unmapped: "danger",
  succeeded: "ok",
  failed: "danger",
  aborted: "danger",
  started: "warn",
  planned: "neutral",
};

/** A value from the data (severity, mapping status, push status) as a badge. */
export function Tag({ v }: { v: unknown }) {
  if (!v) return null;
  const s = String(v);
  return <Badge tone={STATUS_TONE[s] ?? "neutral"}>{s}</Badge>;
}
