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
 * Imports of these, from inside vendor/easyschematic/src, resolve to web/src/es/overrides/ instead.
 */
const OVERRIDES: Record<string, string> = {
  "templateApi.ts": "web/src/es/overrides/templateApi.ts",
  "cloudSync.ts": "web/src/es/overrides/cloudSync.ts",
  "sw-register.ts": "web/src/es/overrides/sw-register.ts",
  "mcpBridge.ts": "web/src/es/overrides/mcpBridge.ts",
  "components/UserMenuButton.tsx": "web/src/es/overrides/UserMenuButton.tsx",
  "components/LoginDialog.tsx": "web/src/es/overrides/LoginDialog.tsx",
  "components/PendingSubmissionBanner.tsx": "web/src/es/overrides/PendingSubmissionBanner.tsx",
};
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
// Same toolchain as EasySchematic (React 19, Vite 8, Tailwind 4 through PostCSS).
// Two pages: the app (index.html) and the EasySchematic editor frame (es-frame.html), which the
// Schematic tab embeds so the editor keeps its own document (styles, shortcuts, store).
export default defineConfig({
  root: "web",
  plugins: [easySchematicOverrides(), react()],
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
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(ROOT, "web/index.html"), editor: resolve(ROOT, "web/es-frame.html") } },
  },
  // `npm run dev:web` (Vite HMR) forwards the API and the live sockets to `wrangler dev` on :8787.
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
});
