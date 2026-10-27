import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTOR_TYPES, CURRENT_SCHEMA_VERSION, DEVICE_TYPES, ES_SOURCE_COMMIT, SIGNAL_TYPES } from "../src/vendor/esEnums.generated.js";

describe("vendored EasySchematic enums", () => {
  it("carry the source commit, a schema version and the Div 27 types", () => {
    expect(ES_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
    for (const t of ["camera", "ptz-camera", "turret-camera", "access-point", "network-switch", "patch-panel", "wall-plate", "door-strike", "ups"]) expect(DEVICE_TYPES).toContain(t);
    expect(SIGNAL_TYPES).toContain("ethernet");
    expect(CONNECTOR_TYPES).toContain("rj45");
  });

  // With an EasySchematic checkout (ES_DIR), prove the vendored copy is current.
  it.runIf(!!process.env.ES_DIR)("match the EasySchematic checkout in ES_DIR", () => {
    const script = fileURLToPath(new URL("../scripts/vendor-es.mjs", import.meta.url));
    expect(() => execFileSync("node", [script, "--es", process.env.ES_DIR!, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
