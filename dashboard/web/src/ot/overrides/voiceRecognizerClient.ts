// Replaces OpenTakeoff's lib/voiceRecognizerClient.ts (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream's push-to-talk dictation runs Whisper in a worker (@huggingface/transformers on
// onnxruntime-web) from a model each deployment stages under /models. The Brink app stages
// none and does not bundle the engine, so the recognizer always reports "uninstalled", the
// state upstream itself shows on a deployment without the model (and the command box that
// uses it is gated off by default upstream).
export type { VoiceModelStatus } from "../../../../vendor/opentakeoff/src/lib/voiceRecognizerClient.ts";
import type { VoiceModelStatus } from "../../../../vendor/opentakeoff/src/lib/voiceRecognizerClient.ts";

export function createVoiceRecognizerClient(onStatus: (s: VoiceModelStatus) => void) {
  return {
    async ensureReady(): Promise<boolean> {
      onStatus({ phase: "uninstalled" });
      return false;
    },
    transcribe(_pcm: Float32Array): Promise<string> {
      return Promise.reject(new Error("recognizer not installed"));
    },
    dispose(): void {
      /* nothing started */
    },
  };
}
