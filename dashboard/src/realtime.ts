// The relay's one upstream: a Supabase Realtime channel listening to
// postgres_changes on every table the dashboard reflects. It runs inside the
// Durable Object with the service-role key, which never leaves the Worker.
import { RealtimeClient, type RealtimeChannel } from "@supabase/realtime-js";
import { CORE_TABLES, fromRealtimePayload, type RowChange, type TableName, type UpstreamStatus } from "./shared/protocol.js";

export interface UpstreamHandlers {
  onChange(change: RowChange): void;
  onStatus(status: UpstreamStatus, detail?: string): void;
}

export interface Upstream {
  close(): Promise<void>;
}

/** https://<ref>.supabase.co (or http://127.0.0.1:54321) -> the Realtime socket endpoint realtime-js expects. */
export function realtimeEndpoint(supabaseUrl: string): string {
  const u = new URL(supabaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/realtime/v1`;
  u.search = "";
  return u.toString();
}

/**
 * `tables` must all exist and be in the supabase_realtime publication: Realtime rejects the whole
 * channel join over one bad binding, so optional tables are added only after the relay has checked.
 */
export function connectSupabaseRealtime(
  opts: { supabaseUrl: string; serviceKey: string; channel?: string; tables?: readonly TableName[] },
  h: UpstreamHandlers,
): Upstream {
  const client = new RealtimeClient(realtimeEndpoint(opts.supabaseUrl), {
    params: { apikey: opts.serviceKey },
    heartbeatIntervalMs: 25_000,
  });
  // `wait` asks the server to reply to the join only once the postgres_changes
  // listener is in place, so "live" means changes from here on are delivered.
  const channel: RealtimeChannel = client.channel(opts.channel ?? "brink-dashboard", {
    config: { postgres_changes_options: { wait: true } },
  });
  for (const table of opts.tables ?? CORE_TABLES) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
      const change = fromRealtimePayload(payload as Parameters<typeof fromRealtimePayload>[0]);
      if (change) h.onChange(change);
    });
  }
  channel.on("system", {}, (p: { status?: string; message?: string; extension?: string }) => {
    if (p?.extension !== "postgres_changes") return;
    if (p.status === "ok") h.onStatus("live");
    else h.onStatus("down", p.message ?? "postgres_changes error");
  });
  h.onStatus("connecting");
  channel.subscribe((status, err) => {
    if (status === "SUBSCRIBED") h.onStatus("live");
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") h.onStatus("down", err?.message ?? status);
    else if (status === "CLOSED") h.onStatus("down", "channel closed");
  });
  return {
    async close() {
      try {
        await client.removeAllChannels();
      } finally {
        client.disconnect();
      }
    },
  };
}
