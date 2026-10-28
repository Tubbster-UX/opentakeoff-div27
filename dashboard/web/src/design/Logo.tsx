// The Brink Design logo: the owner's black / white transparent PNGs
// (web/public/brand/, see its README: placeholders until the Drive originals are copied in).
// The black mark shows on the light theme, the white one on the dark theme.
import black from "../../public/brand/Logo Transparent Black@2x.png";
import white from "../../public/brand/Logo Transparent White@2x.png";
import { useThemeMode } from "./theme.js";

export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  const { dark } = useThemeMode();
  return <img src={dark ? white : black} alt="Brink Design" width={size} height={size} className={`block shrink-0 object-contain ${className}`} data-brink-logo />;
}
