// RealtimeRelay: one Durable Object instance holds ONE Supabase Realtime
// subscription (service-role key) and fans row changes out to browser
// WebSockets. The brink tables have RLS on and no policies, so browsers
// cannot subscribe themselves; they never see a Supabase key.
//
// Browser sockets use the hibernation API (ctx.acceptWebSocket). Each socket's
// attachment records the project it opened and the import it shows, which is
// all routing needs. The upstream is opened with the first browser and closed
// with the last, so an idle relay can be evicted; an alarm re-opens it if the
// object was restarted while browsers were still attached.
import { DurableObject } from "cloudflare:workers";
import { connectSupabaseRealtime, type Upstream } from "./realtime.js";
import type { ClientMessage, RowChange, ServerMessage, UpstreamStatus } from "./shared/protocol.js";
import { route, type ClientState } from "./shared/routing.js";
import type { Env } from "./env.js";

const WATCHDOG_MS = 30_000;
const OPEN = 1;

export class RealtimeRelay extends DurableObject<Env> {
  private upstream: Upstream | null = null;
  private status: UpstreamStatus = "connecting";
  private statusDetail: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const projectId = new URL(req.url).searchParams.get("project");
    if (!projectId) return new Response("missing project", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ projectId, importId: null } satisfies ClientState);
    this.ensureUpstream();
    server.send(this.statusMessage());
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }
    if (msg?.type === "watch") {
      const st = ws.deserializeAttachment() as ClientState;
      ws.serializeAttachment({ ...st, importId: typeof msg.importId === "string" ? msg.importId : null } satisfies ClientState);
    }
    // A message after the object restarted (hibernation, eviction) re-opens the upstream.
    if (!this.upstream) {
      this.ensureUpstream();
      ws.send(this.statusMessage());
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    await this.stopIfIdle(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.stopIfIdle(ws);
  }

  override async alarm(): Promise<void> {
    if (this.openSockets().length === 0) {
      await this.stopUpstream();
      return;
    }
    if (!this.upstream) {
      this.ensureUpstream();
      this.broadcast(this.statusMessage());
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  /** Fan one change out to the sockets it concerns (exported for tests through the relay's own path). */
  private onChange(change: RowChange): void {
    const body = JSON.stringify({ type: "change", change } satisfies ServerMessage);
    for (const ws of this.openSockets()) {
      const st = ws.deserializeAttachment() as ClientState;
      const { send, next } = route(change, st);
      if (next !== st) ws.serializeAttachment(next);
      if (send) safeSend(ws, body);
    }
  }

  private onStatus(status: UpstreamStatus, detail?: string): void {
    if (status === this.status && detail === this.statusDetail && status !== "live") return;
    this.status = status;
    this.statusDetail = detail;
    this.broadcast(this.statusMessage());
  }

  private ensureUpstream(): void {
    if (this.upstream) return;
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = this.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      this.status = "unconfigured";
      this.statusDetail = "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set";
      return;
    }
    this.upstream = connectSupabaseRealtime(
      { supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY },
      { onChange: (c) => this.onChange(c), onStatus: (s, d) => this.onStatus(s, d) },
    );
  }

  private async stopIfIdle(closing: WebSocket): Promise<void> {
    if (this.openSockets().some((w) => w !== closing)) return;
    await this.stopUpstream();
  }

  private async stopUpstream(): Promise<void> {
    const up = this.upstream;
    this.upstream = null;
    this.status = "connecting";
    this.statusDetail = undefined;
    await this.ctx.storage.deleteAlarm();
    if (up) await up.close().catch(() => undefined);
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => w.readyState === OPEN);
  }

  private broadcast(body: string): void {
    for (const ws of this.openSockets()) safeSend(ws, body);
  }

  private statusMessage(): string {
    return JSON.stringify({ type: "status", upstream: this.status, ...(this.statusDetail ? { detail: this.statusDetail } : {}) } satisfies ServerMessage);
  }
}

function safeSend(ws: WebSocket, body: string): void {
  try {
    ws.send(body);
  } catch {
    /* socket went away between the filter and the send */
  }
}
