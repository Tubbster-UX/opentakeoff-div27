import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    // several files each boot an in-process PGlite and migrate it in beforeAll;
    // under parallel load that can pass vitest's 10 s hook default
    hookTimeout: 60000,
  },
});
