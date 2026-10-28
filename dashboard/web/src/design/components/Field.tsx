import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

const CONTROL =
  "bk-focus h-8 w-full rounded-ctl border border-line-strong bg-panel px-2.5 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-ink-3 focus:border-accent disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...rest }, ref) {
  return <input ref={ref} className={`${CONTROL} ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = "", children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={`${CONTROL} cursor-pointer appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7 ${className}`}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236e6e76' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")" }}
      {...rest}
    >
      {children}
    </select>
  );
});

/** A labelled control: the label is tied to the control by id; hint / error are described-by. */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }) {
  const id = useId();
  const describe = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children({ id, "aria-describedby": describe, "aria-invalid": error ? true : undefined })}
      {error ? (
        <p id={`${id}-e`} className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-h`} className="m-0 text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
