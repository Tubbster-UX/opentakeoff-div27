// Menu / dropdown (ARIA menu button pattern).
//   - The trigger is a button with aria-haspopup / aria-expanded; Enter, Space or
//     ArrowDown opens the menu and focuses its first item, ArrowUp its last.
//   - In the menu: Up / Down / Home / End move, Enter / Space activate, Escape or Tab
//     closes (Escape returns focus to the trigger), typing a letter jumps to an item.
//   - The menu renders in a portal with fixed positioning, so a scrolling toolbar never clips it.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons.js";
import { buttonClass, type ButtonVariant } from "./Button.js";

export type MenuEntry =
  | { type?: "item"; label: string; onSelect: () => void; icon?: IconName; shortcut?: string; checked?: boolean; disabled?: boolean; hint?: string; id?: string }
  | { type: "separator" }
  | { type: "heading"; label: string };

export interface MenuProps {
  label: ReactNode;
  /** Accessible name when `label` is not text (icon-only triggers). */
  ariaLabel?: string;
  items: MenuEntry[];
  icon?: IconName;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  align?: "start" | "end";
  /** Hide the chevron (icon-only triggers). */
  bare?: boolean;
  /** data-* hook for checks. */
  testId?: string;
  triggerClassName?: string;
}

export function Menu({ label, ariaLabel, items, icon, variant = "quiet", size = "md", align = "start", bare, testId, triggerClassName = "" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const id = useId();

  const place = useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(220, r.width);
    const left = align === "end" ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), minWidth: width });
  }, [align]);

  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([aria-disabled=true])") ?? [])];
    requestAnimationFrame(() => {
      const list = items();
      (focusOnOpen.current === "last" ? list[list.length - 1] : list[0])?.focus();
    });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close, place]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusOnOpen.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([aria-disabled=true])") ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const from = list.slice(i + 1).concat(list.slice(0, i + 1));
      from.find((el) => el.textContent?.trim().toLowerCase().startsWith(k))?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
        data-menu={testId}
        onClick={() => {
          focusOnOpen.current = "first";
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKey}
        className={buttonClass(variant, size, `${open ? "bg-pressed text-ink" : ""} ${triggerClassName}`)}
      >
        {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
        {label}
        {!bare && <Icon name="chevronDown" size={12} className="text-ink-3" />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
            onKeyDown={onMenuKey}
            data-bk-chrome
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, maxHeight: `calc(100dvh - ${pos.top + 12}px)` }}
            className="bk fixed z-[200] overflow-y-auto rounded-panel border border-line bg-panel p-1 text-sm text-ink shadow-lg"
          >
            {items.map((it, n) =>
              it.type === "separator" ? (
                <div key={n} role="separator" className="my-1 h-px bg-line" />
              ) : it.type === "heading" ? (
                <div key={n} role="presentation" className="px-2 pt-2 pb-1 bk-label text-ink-3">
                  {it.label}
                </div>
              ) : (
                <div
                  key={n}
                  role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={it.checked}
                  aria-disabled={it.disabled || undefined}
                  tabIndex={-1}
                  title={it.hint}
                  data-menuitem={it.id ?? it.label}
                  onClick={() => {
                    if (it.disabled) return;
                    close(true);
                    it.onSelect();
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !it.disabled) {
                      e.preventDefault();
                      e.stopPropagation();
                      close(true);
                      it.onSelect();
                    }
                  }}
                  className={`flex h-8 cursor-pointer items-center gap-2 rounded-ctl px-2 outline-none select-none focus:bg-hover hover:bg-hover ${it.disabled ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <span className="flex w-4 shrink-0 justify-center text-ink-3">
                    {it.checked ? <Icon name="check" size={14} className="text-ink" /> : it.icon ? <Icon name={it.icon} size={14} /> : null}
                  </span>
                  <span className="flex-1 whitespace-nowrap">{it.label}</span>
                  {it.shortcut && <kbd className="ml-4 font-ui text-2xs text-ink-3">{it.shortcut}</kbd>}
                </div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
