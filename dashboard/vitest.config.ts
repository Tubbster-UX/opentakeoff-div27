import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (whose root is web/): tests live in test/.
export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
