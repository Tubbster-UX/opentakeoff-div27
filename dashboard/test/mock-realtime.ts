// A mock Supabase Realtime server: just enough of the Phoenix channel protocol
// (serializer vsn 2.0.0 JSON arrays, and 1.0.0 objects) for realtime-js to join
// a postgres_changes channel, plus a push() that emits a postgres change the way
// the real server does. Used to prove the relay's fan-out path without Docker.
import { WebSocketServer, type WebSocket } from "ws";

type Msg = { join_ref: string | null; ref: string | null; topic: string; event: string; payload: Record<string, unknown> };

interface Joined {
  ws: WebSocket;
  topic: string;
  joinRef: string | null;
  bindings: { id: number; event: string; schema: string; table: string }[];
  arrays: boolean;
}

export interface MockRealtime {
  url: string;
  /** Query string of each socket connect (apikey, vsn). */
  connects: URLSearchParams[];
  joined(): number;
  waitJoined(n?: number, ms?: number): Promise<void>;
  push(table: string, type: "INSERT" | "UPDATE" | "DELETE", record: Record<string, unknown> | null, oldRecord?: Record<string, unknown> | null): void;
  close(): Promise<void>;
}

export async function startMockRealtime(): Promise<MockRealtime> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const connects: URLSearchParams[] = [];
  const channels: Joined[] = [];
  let nextId = 1000;

  const send = (ws: WebSocket, arrays: boolean, m: Msg) =>
    ws.send(JSON.stringify(arrays ? [m.join_ref, m.ref, m.topic, m.event, m.payload] : m));

  wss.on("connection", (ws, req) => {
    connects.push(new URL(req.url ?? "/", "http://x").searchParams);
    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const arrays = Array.isArray(parsed);
      const m: Msg = arrays ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] } : parsed;
      const reply = (response: Record<string, unknown>) =>
        send(ws, arrays, { join_ref: m.join_ref, ref: m.ref, topic: m.topic, event: "phx_reply", payload: { status: "ok", response } });
      if (m.topic === "phoenix" && m.event === "heartbeat") return reply({});
      if (m.event === "phx_join") {
        const cfg = (m.payload.config ?? {}) as { postgres_changes?: { event: string; schema: string; table: string }[] };
        const bindings = (cfg.postgres_changes ?? []).map((b) => ({ ...b, id: nextId++ }));
        channels.push({ ws, topic: m.topic, joinRef: m.join_ref, bindings, arrays });
        reply({ postgres_changes: bindings });
        send(ws, arrays, { join_ref: null, ref: null, topic: m.topic, event: "system", payload: { status: "ok", message: "Subscribed to PostgreSQL", extension: "postgres_changes", channel: m.topic.replace(/^realtime:/, "") } });
        return;
      }
      if (m.event === "phx_leave") {
        const i = channels.findIndex((c) => c.ws === ws && c.topic === m.topic);
        if (i >= 0) channels.splice(i, 1);
        return reply({});
      }
      reply({});
    });
    ws.on("close", () => {
      for (let i = channels.length - 1; i >= 0; i--) if (channels[i]!.ws === ws) channels.splice(i, 1);
    });
  });

  const api: MockRealtime = {
    url: `http://127.0.0.1:${port}`,
    connects,
    joined: () => channels.length,
    async waitJoined(n = 1, ms = 15_000) {
      const end = Date.now() + ms;
      while (channels.length < n) {
        if (Date.now() > end) throw new Error("no realtime channel joined");
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    push(table, type, record, oldRecord = null) {
      for (const c of channels) {
        const ids = c.bindings.filter((b) => b.table === table && (b.event === "*" || b.event === type)).map((b) => b.id);
        if (!ids.length) continue;
        send(c.ws, c.arrays, {
          join_ref: null,
          ref: null,
          topic: c.topic,
          event: "postgres_changes",
          payload: {
            ids,
            data: { schema: "public", table, commit_timestamp: new Date().toISOString(), type, record: record ?? {}, old_record: oldRecord ?? {}, columns: [], errors: null },
          },
        });
      }
    },
    close: () => new Promise((r) => wss.close(() => r())),
  };
  return api;
}
