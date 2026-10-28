import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ROOT = dirname(fileURLToPath(import.meta.url));
/** EasySchematic, vendored verbatim (vendor/PATCHES.md). */
const ES_SRC = resolve(ROOT, "vendor/easyschematic/src");
const ES_LOCK = JSON.parse(readFileSync(resolve(ROOT, "vendor/easyschematic.lock.json"), "utf8")) as { commit: string };
const ES_PKG = JSON.parse(readFileSync(resolve(ROOT, "vendor/easyschematic/package.json"), "utf8")) as { version: string };

/**
 * EasySchematic modules the Brink app replaces from outside the vendored tree (vendor/PATCHES.md says why).
 * Imports of these, from inside vendor/easyschematic/src, resolve to the Brink module instead. Brink
 * modules that import the upstream original (to wrap or re-place it) live outside the vendored tree, so
 * their own import of it is not redirected.
 */
const OVERRIDES: Record<string, string> = {
  // No EasySchematic cloud, accounts, service worker or local MCP bridge.
  "templateApi.ts": "web/src/es/overrides/templateApi.ts",
  "cloudSync.ts": "web/src/es/overrides/cloudSync.ts",
  "sw-register.ts": "web/src/es/overrides/sw-register.ts",
  "mcpBridge.ts": "web/src/es/overrides/mcpBridge.ts",
  "components/UserMenuButton.tsx": "web/src/es/overrides/UserMenuButton.tsx",
  "components/LoginDialog.tsx": "web/src/es/overrides/LoginDialog.tsx",
  "components/PendingSubmissionBanner.tsx": "web/src/es/overrides/PendingSubmissionBanner.tsx",
  // The Brink UI in upstream App's layout slots.
  "components/MenuBar.tsx": "web/src/es/brink/SchematicToolbar.tsx",
  "components/DeviceLibrary.tsx": "web/src/es/brink/LibraryPanel.tsx",
  "components/ViewOptionsPanel.tsx": "web/src/es/brink/RightPanel.tsx",
  "components/ShowInfoPanel.tsx": "web/src/es/overrides/Nothing.tsx",
  "components/SignalColorPanel.tsx": "web/src/es/overrides/Nothing.tsx",
  "components/UpdatePill.tsx": "web/src/es/overrides/Nothing.tsx",
  "components/BetaBanner.tsx": "web/src/es/overrides/Nothing.tsx",
  "components/MobileGate.tsx": "web/src/es/overrides/Nothing.tsx",
  "components/ToastContainer.tsx": "web/src/es/overrides/ToastContainer.tsx",
  "hooks/useTheme.ts": "web/src/es/overrides/useTheme.ts",
};
/** OpenTakeoff's canvas, vendored from this repository's main web/ (vendor/PATCHES.md, OpenTakeoff). */
const OT_SRC = resolve(ROOT, "vendor/opentakeoff/src");
const OT_PKG = JSON.parse(readFileSync(resolve(ROOT, "vendor/opentakeoff/package.json"), "utf8")) as { version: string };

/**
 * OpenTakeoff modules the Brink app replaces from outside the vendored tree (vendor/PATCHES.md, OpenTakeoff
 * section 3 says why). Same rule as OVERRIDES: imports of these from inside vendor/opentakeoff/src resolve to
 * the Brink module; a Brink module that wraps the upstream original imports it from outside, unredirected.
 */
const OT_OVERRIDES: Record<string, string> = {
  // No on-device OCR or voice engines (their models are staged per deployment; the app stages none).
  "lib/ocr/client.ts": "web/src/ot/overrides/ocrClient.ts",
  "lib/voiceRecognizerClient.ts": "web/src/ot/overrides/voiceRecognizerClient.ts",
  // No Microsoft 365 sync (the project database is the store of record).
  "lib/msgraph/auth.js": "web/src/ot/overrides/msgraphAuth.ts",
  // One theme for the app (the .dark class), one layout (the Brink chrome).
  "lib/theme.js": "web/src/ot/overrides/theme.ts",
  "lib/focusMode.js": "web/src/ot/overrides/focusMode.ts",
  "components/WorkspaceLayout.jsx": "web/src/ot/overrides/WorkspaceLayout.tsx",
  // The plan-set gallery without its premium, tour, connect-AI and clear-workspace entry points.
  "components/PlanNavigator.jsx": "web/src/ot/overrides/PlanNavigator.tsx",
};

/**
 * Literal colours in SVG presentation attributes (which cannot read CSS variables), re-pointed at Brink literals at
 * build time, per file. Only the canvas's on-screen overlay chrome (selection, drafting, calibration guide, grips,
 * the sanctioned SVG constants): never condition colours, hatches, markup or stamp colours (user data) and never the
 * marked set PDF (lib/markedset.js keeps upstream's print colours). vendor/PATCHES.md lists every pair.
 */
const OT_LITERALS: Record<string, [string, string][]> = {
  "lib/ui.js": [
    ['cobalt: "#0e636b"', 'cobalt: "#1f5a96"'], // Brink Blue
    ['danger: "#b03a26"', 'danger: "#b42318"'],
    ['positive: "#1f6b4a"', 'positive: "#17703e"'],
    ['cobalt: "#62d4dc"', 'cobalt: "#8ebbea"'], // Brink Blue on navy (dark)
    ['danger: "#ff6b57"', 'danger: "#ff8f86"'],
    ['positive: "#35d48f"', 'positive: "#6fd69a"'],
  ],
  "pages/TakeoffCanvas.jsx": [
    ['"#1f3fc7"', '"#1f5a96"'],
    ["rgba(31,63,199,", "rgba(31,90,150,"],
    ["rgba(37,99,235,", "rgba(31,90,150,"],
    ['"#b03a26"', '"#b42318"'],
    // the source-trace highlight was amber: Brink has no amber, so it is the accent
    ["rgba(196,122,16,.18)", "rgba(31,90,150,.18)"],
    ['"#c47a10"', '"#1f5a96"'],
    // warm greys and cream (vertex grips, sheet captions, the scale guide's label) -> Brink neutrals
    ['"#faf6ea"', '"#ffffff"'],
    ['"#0b0e14"', '"#0d161f"'],
    ['"#9a917f"', '"#a9b4bf"'],
    ['"#6b6256"', '"#4e5b67"'],
    ['"#5b544a"', '"#4e5b67"'],
    ['"#8a8577"', '"#6b7884"'],
    ['"#c9c2b2"', '"#a9b4bf"'],
    ['"#1c1914"', '"#16222f"'],
    ['"#14120e"', '"#0d161f"'],
  ],
};

function openTakeoffOverrides(): Plugin {
  const inOt = (p: string | undefined) => !!p && (p === OT_SRC || p.startsWith(OT_SRC + sep));
  return {
    name: "brink-opentakeoff-overrides",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!inOt(importer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !inOt(resolved.id)) return resolved;
      const rel = relative(OT_SRC, resolved.id.split("?")[0]!).split(sep).join("/");
      const override = OT_OVERRIDES[rel];
      return override ? resolve(ROOT, override) : resolved;
    },
    // Upstream inlines its package version as __APP_VERSION__ (lib/contribute.js); EasySchematic uses the same
    // global for its own. Inside OpenTakeoff's tree it is OpenTakeoff's version.
    transform(code, id) {
      const file = id.split("?")[0]!;
      if (!inOt(file)) return null;
      let out = code;
      if (out.includes("__APP_VERSION__")) out = out.replaceAll("__APP_VERSION__", JSON.stringify(`${OT_PKG.version}+brink`));
      for (const [from, to] of OT_LITERALS[relative(OT_SRC, file).split(sep).join("/")] ?? []) {
        if (!out.includes(from)) this.error(`OpenTakeoff literal ${from} is gone from ${file}: update OT_LITERALS and vendor/PATCHES.md`);
        out = out.replaceAll(from, to);
      }
      return out === code ? null : { code: out, map: null };
    },
  };
}

/** Upstream generates this at build time (api/seed/generate-fallback.ts); the app builds the same list as a module. */
const FALLBACK_JSON = "deviceLibrary.fallback.json";
const FALLBACK_ID = "\0brink-es-device-library-fallback";

function easySchematicOverrides(): Plugin {
  const inEs = (p: string | undefined) => !!p && (p === ES_SRC || p.startsWith(ES_SRC + sep));
  return {
    name: "brink-easyschematic-overrides",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!inEs(importer)) return null;
      if (source.endsWith(FALLBACK_JSON)) return FALLBACK_ID;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !inEs(resolved.id)) return resolved;
      const rel = relative(ES_SRC, resolved.id.split("?")[0]!).split(sep).join("/");
      const override = OVERRIDES[rel];
      return override ? resolve(ROOT, override) : resolved;
    },
    load(id) {
      if (id !== FALLBACK_ID) return null;
      const lib = JSON.stringify(resolve(ES_SRC, "deviceLibrary.ts"));
      return `import { DEVICE_TEMPLATES, CARD_TEMPLATES } from ${lib};\nexport default [...DEVICE_TEMPLATES, ...CARD_TEMPLATES];\n`;
    },
  };
}

// The app lives in web/; the Worker serves the build from dist/ ([assets] in wrangler.toml).
// Same toolchain as EasySchematic (React 19, Vite 8, Tailwind 4 through PostCSS). One page: the
// EasySchematic editor mounts in the app itself (the Schematic tab), in the same document and the
// same Tailwind build (web/src/app.css).
export default defineConfig({
  root: "web",
  plugins: [easySchematicOverrides(), openTakeoffOverrides(), react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  // EasySchematic's fonts (its PDF export and CSS fetch /fonts/*) and favicon.
  publicDir: resolve(ROOT, "vendor/easyschematic/public"),
  define: {
    __APP_VERSION__: JSON.stringify(`${ES_PKG.version}+brink`),
    __BUILD_HASH__: JSON.stringify(ES_LOCK.commit.slice(0, 7)),
  },
  resolve: {
    // As upstream: TypeScript sources before .js.
    extensions: [".mjs", ".mts", ".ts", ".tsx", ".js", ".jsx", ".json"],
    alias: {
      // The shell's typed entries to the Schematic and Takeoff workspaces (web/src/es-workspace.d.ts, ot-workspace.d.ts).
      "@brink/schematic-workspace": resolve(ROOT, "web/src/es/load.ts"),
      "@brink/takeoff-workspace": resolve(ROOT, "web/src/ot/load.ts"),
      // The canvas's one patch (vendor/opentakeoff-patches/0001-host-bridge.patch) imports the host bridge by this name.
      "@brink/ot-host": resolve(ROOT, "web/src/ot/host.ts"),
    },
  },
  // OpenTakeoff's tile and room workers code-split (as upstream configures them): ES module workers.
  worker: { format: "es" },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(ROOT, "web/index.html") } },
  },
  // `npm run dev:web` (Vite HMR) forwards the API and the live sockets to `wrangler dev` on :8787.
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
});
