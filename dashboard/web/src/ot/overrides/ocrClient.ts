// Replaces OpenTakeoff's lib/ocr/client.ts (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream's client starts an on-device OCR worker (ppu-paddle-ocr on onnxruntime-web,
// ~25 MB of models staged per deployment by scripts/stage-ocr-model.mjs). The Brink app
// stages no models and does not bundle that engine, so this client always answers the
// way upstream does on a build with VITE_OCR=off: "disabled". Every caller already
// handles that state (the read-page / copy-text controls say on-device reading is off).
// The text layer of a PDF is still read (pdf.js), as upstream does without OCR.
import type { OcrProbe, OcrReady, OcrRegion } from "../../../../vendor/opentakeoff/src/lib/ocr/client.ts";
import type { OcrWord } from "../../../../vendor/opentakeoff/src/lib/ocr/types.ts";

export type { OcrProbe, OcrProgress, OcrReady, OcrRegion, WorkerLike, OcrClientDeps } from "../../../../vendor/opentakeoff/src/lib/ocr/client.ts";

/** A read the worker never answered within its deadline (kept for upstream's imports; never thrown here). */
export class OcrTimeoutError extends Error {
  constructor() {
    super("The on-device reader stopped responding.");
    this.name = "OcrTimeoutError";
  }
}

/** Upstream's read deadline: generous, stretched by the device's speed. Kept so importers see the same numbers. */
export function readDeadlineMs(mp: number, slowdown = 1): number {
  return Math.max(30_000, Math.round(mp * 20_000 * Math.max(1, slowdown)));
}

const DISABLED = "On-device text reading is not part of the Brink app; the PDF's own text layer is still read.";

export function createOcrClient() {
  return {
    probe: async (): Promise<OcrProbe> => ({ state: "disabled" }),
    ensureReady: async (): Promise<OcrReady> => ({ ok: false, reason: "disabled" }),
    recognize: (_region: OcrRegion): Promise<OcrWord[]> => Promise.reject(new Error(DISABLED)),
    whenIdle: (): Promise<void> => Promise.resolve(),
    dispose: (): void => undefined,
  };
}

export type OcrClient = ReturnType<typeof createOcrClient>;

let shared: OcrClient | null = null;

export function getOcrClient(): OcrClient {
  shared ??= createOcrClient();
  return shared;
}
