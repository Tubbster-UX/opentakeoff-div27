// The project list, live: GET /api/projects, re-read whenever the relay's
// list socket (/api/live) says a brink table changed (coalesced on the server,
// debounced here), and on every "live" status (covers missed changes).
// Rows whose figures changed since the last read are flagged for highlighting.
import { useEffect, useState } from "react";
import type { ProjectList, ProjectSummary } from "../../../src/shared/protocol.js";
import { LiveSocket } from "./liveSocket.js";

export interface ProjectListState {
  list: ProjectList | null;
  error: string | null;
  /** Project ids whose row changed on the last re-read, with a sequence number so a repeat re-flashes. */
  changed: Record<string, number>;
}

const DEBOUNCE_MS = 250;

const fingerprint = (p: ProjectSummary): string => JSON.stringify(p);

export function useProjectList(): ProjectListState {
  const [state, setState] = useState<ProjectListState>({ list: null, error: null, changed: {} });

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let prev = new Map<string, string>();

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        do {
          again = false;
          const res = await fetch("/api/projects", { cache: "no-store" });
          if (!res.ok) throw new Error(`projects ${res.status}`);
          const list = (await res.json()) as ProjectList;
          if (stopped) return;
          const next = new Map(list.projects.map((p) => [p.id, fingerprint(p)]));
          const changed: Record<string, number> = {};
          if (prev.size) for (const [id, f] of next) if (prev.get(id) !== f) changed[id] = ++seq;
          prev = next;
          setState((s) => ({ list, error: null, changed: Object.keys(changed).length ? changed : s.changed }));
        } while (again && !stopped);
      } catch (e) {
        if (!stopped) setState((s) => ({ ...s, error: (e as Error).message }));
      } finally {
        inFlight = false;
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), DEBOUNCE_MS);
    };

    const socket = new LiveSocket("/api/live", {
      onMessage: (m) => {
        if (m.type === "touch") soon();
        else if (m.type === "status" && m.upstream === "live") soon();
      },
    });
    void load();
    socket.start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket.stop();
    };
  }, []);

  return state;
}
