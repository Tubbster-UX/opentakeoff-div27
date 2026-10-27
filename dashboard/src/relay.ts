// RealtimeRelay: one Durable Object instance holds ONE Supabase Realtime
// subscription (service-role key) and fans row changes out to browser
// WebSockets. The brink tables have RLS on and no policies, so browsers
// cannot subscribe themselves; they never see a Supabase key.
//
// Browser sockets use the hibernation API (ctx.acceptWebSocket). Each socket's
// attachment records what it opened (ClientState): one project and the import
// it shows, or the project list. That is all routing needs. Project sockets get
// routed row changes; list sockets get a coalesced "touch" naming the tables
// that changed, and re-read the list.
//
// The upstream is opened with the first browser and closed with the last, so
// an idle relay can be evicted; an alarm re-opens it if the object was
// restarted while browsers were still attached. Before opening it, the relay
// asks Postgres (Hyperdrive) which OPTIONAL tables are in the realtime
// publication; Realtime refuses a channel that names a missing table.
import { DurableObject } from "cloudflare:workers";
import { publishedTables, withClient } from "./db.js";
import { connectSupabaseRealtime, type Upstream } from "./realtime.js";
import { CORE_TABLES, OPTIONAL_TABLES, type ClientMessage, type RowChange, type ServerMessage, type TableName, type UpstreamStatus } from "./shared/protocol.js";
import { isListClient, route, type ClientState } from "./shared/routing.js";
import type { Env } from "./env.js";

const WATCHDOG_MS = 30_000;
/** List sockets are told at most this often (a re-import writes hundreds of rows). */
const TOUCH_MS = 300;
const OPEN = 1;

export class RealtimeRelay extends DurableObject<Env> {
  private upstream: Upstream | null = null;
  private starting: Promise<void> | null = null;
  /** Bumped by every stop, so a start that was still checking tables does not open a stale upstream. */
  private generation = 0;
  private status: UpstreamStatus = "connecting";
  private statusDetail: string | undefined;
  private pendingTouch = new Set<TableName>();
  private touchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const q = new URL(req.url).searchParams;
    const projectId = q.get("project");
    const state: ClientState | null = q.get("scope") === "list" ? { kind: "list" } : projectId ? { kind: "project", projectId, importId: null } : null;
    if (!state) return new Response("missing project", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(state);
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
    const st = ws.deserializeAttachment() as ClientState;
    if (msg?.type === "watch" && !isListClient(st)) {
      ws.serializeAttachment({ ...st, importId: typeof msg.importId === "string" ? msg.importId : null } satisfies ClientState);
    }
    // A message after the object restarted (hibernation, eviction) re-opens the upstream.
    if (!this.upstream && !this.starting) {
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
    if (!this.upstream && !this.starting) {
      this.ensureUpstream();
      this.broadcast(this.statusMessage());
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  /** Fan one change out: routed to the project sockets it concerns, noted for the list sockets. */
  private onChange(change: RowChange): void {
    const body = JSON.stringify({ type: "change", change } satisfies ServerMessage);
    let lists = false;
    for (const ws of this.openSockets()) {
      const st = ws.deserializeAttachment() as ClientState;
      if (isListClient(st)) {
        // The project list shows nothing from the schematic edit layer: no re-read for it.
        lists = change.table !== "brink_schematic_edits";
        continue;
      }
      const { send, next } = route(change, st);
      if (next !== st) ws.serializeAttachment(next);
      if (send) safeSend(ws, body);
    }
    if (lists) {
      this.pendingTouch.add(change.table);
      this.touchTimer ??= setTimeout(() => this.flushTouch(), TOUCH_MS);
    }
  }

  private flushTouch(): void {
    this.touchTimer = undefined;
    if (!this.pendingTouch.size) return;
    const body = JSON.stringify({ type: "touch", tables: [...this.pendingTouch] } satisfies ServerMessage);
    this.pendingTouch.clear();
    for (const ws of this.openSockets()) if (isListClient(ws.deserializeAttachment() as ClientState)) safeSend(ws, body);
  }

  private onStatus(status: UpstreamStatus, detail?: string): void {
    if (status === this.status && detail === this.statusDetail && status !== "live") return;
    this.status = status;
    this.statusDetail = detail;
    this.broadcast(this.statusMessage());
  }

  private ensureUpstream(): void {
    if (this.upstream || this.starting) return;
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = this.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      this.status = "unconfigured";
      this.statusDetail = "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set";
      return;
    }
    const gen = this.generation;
    this.status = "connecting";
    this.starting = (async () => {
      const optional = await this.publishedOptionalTables();
      if (gen !== this.generation) return;
      this.upstream = connectSupabaseRealtime(
        { supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY, tables: [...CORE_TABLES, ...optional] },
        { onChange: (c) => this.onChange(c), onStatus: (s, d) => this.onStatus(s, d) },
      );
    })().finally(() => {
      if (gen === this.generation) this.starting = null;
    });
  }

  /** Optional tables (Portal pushes) that this database publishes to Realtime; none when Postgres cannot be asked. */
  private async publishedOptionalTables(): Promise<TableName[]> {
    try {
      const set = await withClient(this.env.HYPERDRIVE.connectionString, (p) => void p, (db) => publishedTables(db, OPTIONAL_TABLES));
      return [...set];
    } catch (e) {
      console.warn("relay: could not check optional realtime tables; subscribing to the core tables only", e);
      return [];
    }
  }

  private async stopIfIdle(closing: WebSocket): Promise<void> {
    if (this.openSockets().some((w) => w !== closing)) return;
    await this.stopUpstream();
  }

  private async stopUpstream(): Promise<void> {
    const up = this.upstream;
    this.upstream = null;
    this.starting = null;
    this.generation++;
    this.status = "connecting";
    this.statusDetail = undefined;
    clearTimeout(this.touchTimer);
    this.touchTimer = undefined;
    this.pendingTouch.clear();
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
