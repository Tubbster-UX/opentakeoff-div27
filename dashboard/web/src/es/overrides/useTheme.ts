// Replaces EasySchematic's src/hooks/useTheme.ts. Upstream keeps its own light / dark
// state per hook instance and toggles the `.dark` class itself. In the Brink app the
// one theme belongs to the app (web/src/design/theme.ts, the header's toggle), which
// sets the same `.dark` class; this returns that theme in upstream's shape.
import { toggleDark, useThemeMode } from "../../design/theme.js";

export function useTheme(): { isDark: boolean; toggle: () => void } {
  const { dark } = useThemeMode();
  return { isDark: dark, toggle: toggleDark };
}
