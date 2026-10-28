// The Brink icon set (Brand Guidelines v1.0, "Iconography": one outline family, one stroke
// weight, never mixed with filled icons). 16 px grid, outline only, round caps and joins,
// a 1.5 px stroke at EVERY rendered size (non-scaling stroke, `.bk-icon` in theme.css),
// currentColor, so icons are navy on light grounds and white on navy. Decorative by
// default (aria-hidden); a control that shows only an icon carries its own label.
import type { ReactNode, SVGProps } from "react";

const P = {
  undo: <path d="M3 7h7a3 3 0 0 1 0 6H9M6 4 3 7l3 3" />,
  redo: <path d="M13 7H6a3 3 0 0 0 0 6h1M10 4l3 3-3 3" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  chevronRight: <path d="m6 4 4 4-4 4" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  library: <path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 3l2.6-.6 2 10.8-2.6.5z" />,
  inspector: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M10 2.5v11M11.8 5h0M11.8 7.5h0" />
    </>
  ),
  layers: <path d="m8 2 6 3.2L8 8.4 2 5.2zM2 8l6 3.2L14 8M2 10.8 8 14l6-3.2" />,
  report: (
    <>
      <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" />
      <path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5M6 5.5h2" />
    </>
  ),
  download: <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />,
  print: (
    <>
      <path d="M4.5 6V2h7v4M4.5 11.5h-2v-5.5h11v5.5h-2" />
      <path d="M4.5 9.5h7v4.5h-7z" />
    </>
  ),
  save: <path d="M3 2.5h8l2.5 2.5v8.5h-10.5zM5 2.5v3.5h5v-3.5M5 13.5v-4.5h6v4.5" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
  plus: <path d="M8 3v10M3 8h10" />,
  room: <path d="M2.5 2.5h11v11h-11zM2.5 8h5M7.5 8v5.5" />,
  note: <path d="M3 2.5h10v8l-3 3h-7zM10 13.5v-3h3" />,
  shape: (
    <>
      <rect x="2" y="2" width="6.5" height="6.5" />
      <circle cx="11" cy="11" r="3" />
    </>
  ),
  align: <path d="M2.5 2v12M5 4.5h8M5 8h5M5 11.5h7" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  route: <path d="M3 13V8.5a2 2 0 0 1 2-2h6a2 2 0 0 0 2-2V2.5M11 4.5l2-2 2 2" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7v4.5M8 4.8v.1" />
    </>
  ),
  warn: <path d="M8 2 14.5 13.5h-13zM8 6.5v3.5M8 11.8v.1" />,
  error: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="m5.5 5.5 5 5M10.5 5.5l-5 5" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
    </>
  ),
  folder: <path d="M1.5 4h4.5l1.5 1.5h7v8h-13z" />,
  grid: <path d="M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z" />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v4h-9.5V4h4" />,
  plan: <path d="M1.5 3.5 5.5 2l5 1.5 4-1.5v10.5l-4 1.5-5-1.5-4 1.5zM5.5 2v10.5M10.5 3.5V14" />,
  schematic: (
    <>
      <rect x="1.5" y="3" width="4.5" height="3.5" />
      <rect x="10" y="9.5" width="4.5" height="3.5" />
      <path d="M6 4.75h2.5v6.5H10" />
    </>
  ),
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h0M2.5 8h0M2.5 12h0" />,
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1" />
      <path d="M4 6.5h0M6.5 6.5h0M9 6.5h0M11.5 6.5h0M5 9.5h6" />
    </>
  ),
  // The takeoff canvas (web/src/ot/brink/): drawing tools and view controls, in the same family.
  pointer: <path d="M3.5 2.5 12 8.5l-3.9.8 2.3 4.2-1.6.9-2.3-4.2L3.5 13z" />,
  area: <path d="M2.5 4 7 2.5l6.5 2.5-1 7.5-6.5 1-3.5-3.5z" />,
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  linear: (
    <>
      <path d="M2.5 12.5 6.5 6l3.5 3.5 3.5-6" />
      <path d="M2.5 12.5h0M13.5 3.5h0" />
    </>
  ),
  surface: <path d="M2.5 13.5V5L8 2.5 13.5 5v8.5M2.5 9h11M8 2.5v11" />,
  count: (
    <>
      <circle cx="4.5" cy="5" r="1.8" />
      <circle cx="11.5" cy="5" r="1.8" />
      <circle cx="8" cy="11" r="1.8" />
    </>
  ),
  symbol: (
    <>
      <path d="M2 2h3M2 2v3M14 2h-3M14 2v3M2 14h3M2 14v-3M14 14h-3M14 14v-3" />
      <circle cx="8" cy="8" r="2.5" />
    </>
  ),
  deduct: (
    <>
      <path d="M2.5 4 7 2.5l6.5 2.5-1 7.5-6.5 1-3.5-3.5z" />
      <path d="M5.5 8h5" />
    </>
  ),
  markup: <path d="M2.5 13.5 3 11l7.5-7.5 2 2L5 13zM9.5 4.5l2 2" />,
  ruler: (
    <>
      <path d="M1.5 10.5 10.5 1.5l4 4-9 9z" />
      <path d="M4.5 7.5l1.5 1.5M7 5l1 1M9.5 2.5 11 4" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5M5 7h4M7 5v4" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5M5 7h4" />
    </>
  ),
  fit: <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5M5.5 5.5h5v5h-5z" />,
  snap: (
    <>
      <path d="M2.5 13.5h11M2.5 13.5V2.5" />
      <circle cx="9" cy="7" r="2" />
    </>
  ),
  angle: <path d="M2.5 13.5h11M2.5 13.5 11 5M7.5 13.5a5 5 0 0 0-1.4-3.6" />,
  upload: <path d="M8 10.5V2M4.5 5.5 8 2l3.5 3.5M2.5 13.5h11" />,
  invert: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 0 0 12z" />
    </>
  ),
  panelLeft: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M6 2.5v11" />
    </>
  ),
  panelRight: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M10 2.5v11" />
    </>
  ),
  quantities: <path d="M2.5 13.5h11M4 13.5V8M7 13.5V4M10 13.5V9.5M13 13.5V6" />,
  trash: <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className = "", ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      className={`bk-icon ${className}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {P[name]}
    </svg>
  );
}
