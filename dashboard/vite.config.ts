import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app lives in web/; the Worker serves the build from dist/ ([assets] in wrangler.toml).
// Same toolchain as EasySchematic (React 19, Vite 8, Tailwind 4 through PostCSS), so its editor
// can be mounted here in Phase 2 without a second pipeline.
export default defineConfig({
  root: "web",
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: "../dist", emptyOutDir: true },
  // `npm run dev:web` (Vite HMR) forwards the API and the live sockets to `wrangler dev` on :8787.
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
});
