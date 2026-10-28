import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent border-transparent hover:bg-accent-hover",
  secondary: "bg-panel text-ink border-line-strong hover:bg-hover",
  quiet: "bg-transparent text-ink-2 border-transparent hover:bg-hover hover:text-ink",
  danger: "bg-panel text-danger border-line-strong hover:bg-danger-soft",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-8 px-3 text-sm gap-2",
};

export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = "") =>
  `bk-focus inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-ctl border font-medium no-underline transition-colors duration-100 cursor-pointer select-none disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${SIZE[size]} ${extra}`;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Shown after the label, e.g. a chevron. */
  trailing?: ReactNode;
}

/** A text button. `type` defaults to "button" so it never submits a form by accident. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, icon, trailing, className = "", children, type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: the accessible name, also shown as the tooltip. */
  label: string;
  /** Keyboard shortcut, shown in the tooltip. */
  shortcut?: string;
  variant?: "quiet" | "secondary";
  size?: ButtonSize;
  /** Toggle buttons: rendered as pressed. */
  pressed?: boolean;
}

/** An icon-only button. Its label is its accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, variant = "quiet", size = "md", pressed, className = "", type = "button", ...rest },
  ref,
) {
  const dim = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const on = pressed ? "bg-accent-soft text-accent border-transparent hover:bg-accent-soft" : VARIANT[variant];
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`bk-focus inline-flex shrink-0 items-center justify-center rounded-ctl border transition-colors duration-100 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${dim} ${on} ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});
