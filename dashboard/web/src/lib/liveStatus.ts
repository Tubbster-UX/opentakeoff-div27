// The live pill in the header: the status of whichever live socket the current page holds.
import { useSyncExternalStore } from "react";
import type { LiveState } from "./liveSocket.js";

let current: { state: LiveState; detail?: string } = { state: "offline" };
const listeners = new Set<() => void>();

export function setLiveStatus(state: LiveState, detail?: string): void {
  if (current.state === state && current.detail === detail) return;
  current = { state, detail };
  for (const l of listeners) l();
}

export function useLiveStatus(): { state: LiveState; detail?: string } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
