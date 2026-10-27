import { defineConfig } from "vite";

// The page lives in web/; the Worker serves the build from dist/ ([assets] in wrangler.toml).
export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
});
