// The Brink Design logo (Brand Guidelines v1.0, "Logo"; files in web/public/brand/, see its README).
//
// - `shield` is the primary logo; `wordmark` (BRINK over DESIGN, no shield) is for narrow
//   places such as the app header. Never show both on the same surface.
// - Navy on white and light grounds, white on Brink Navy / Navy 700. Never another colour,
//   no effects, never stretched (the image keeps the vector's own aspect ratio).
// - Minimum on screen: shield 80 px wide, wordmark 64 px wide. Smaller requests are raised
//   to the minimum; for tiny icons use the app icon instead.
// - Clear space on every side: X, the height of the word DESIGN (about 10% of the logo's
//   width). The component pads itself by X unless `clearSpace={false}` (when the caller
//   provides at least that much room itself).
import shieldNavy from "../../public/brand/brink-design-shield-navy.svg";
import shieldWhite from "../../public/brand/brink-design-shield-white.svg";
import wordmarkNavy from "../../public/brand/brink-design-wordmark-navy.svg";
import wordmarkWhite from "../../public/brand/brink-design-wordmark-white.svg";
import { useThemeMode } from "./theme.js";

/** Width / height of each vector's viewBox. DESIGN is 75.379 units tall in both (the clear-space unit X). */
const ART = {
  shield: { w: 744, h: 641, navy: shieldNavy, white: shieldWhite, min: 80 },
  wordmark: { w: 743.366, h: 315.886, navy: wordmarkNavy, white: wordmarkWhite, min: 64 },
} as const;
const DESIGN_HEIGHT = 75.379;

export const LOGO_MIN_WIDTH = { shield: ART.shield.min, wordmark: ART.wordmark.min } as const;

/** The clear space X, in px, for a logo of this width. */
export const logoClearSpace = (variant: keyof typeof ART, width: number) => (DESIGN_HEIGHT / ART[variant].w) * Math.max(width, ART[variant].min);

export function Logo({
  variant = "wordmark",
  width,
  tone = "auto",
  clearSpace = true,
  className = "",
}: {
  variant?: "shield" | "wordmark";
  /** Rendered width in CSS px; at least the guide's minimum. */
  width?: number;
  /** `auto`: navy on the light theme, white on the dark theme. Use `white` on a navy field. */
  tone?: "auto" | "navy" | "white";
  clearSpace?: boolean;
  className?: string;
}) {
  const { dark } = useThemeMode();
  const art = ART[variant];
  const w = Math.max(width ?? art.min, art.min);
  const h = (w * art.h) / art.w;
  const white = tone === "white" || (tone === "auto" && dark);
  const x = clearSpace ? logoClearSpace(variant, w) : 0;
  return (
    <span className={`inline-flex shrink-0 ${className}`} style={{ padding: x }} data-brink-logo={variant}>
      <img src={white ? art.white : art.navy} alt="Brink Design" width={w} height={h} className="block" draggable={false} />
    </span>
  );
}
