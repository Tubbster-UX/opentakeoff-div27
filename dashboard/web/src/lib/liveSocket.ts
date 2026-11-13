// One browser WebSocket to the relay (/api/projects/:id/live or /api/live),
// with reconnect (exponential backoff), keep-alive pings, and the upstream
// status it reports. Holds no keys: the relay holds the Supabase subscription.
import type { ServerMessage, UpstreamStatus } from "../../../src/shared/protocol.js";
import { setLiveStatus } from "./liveStatus.js";

export type LiveState = UpstreamStatus | "offline";

export interface LiveSocketHandlers {
  /** The socket (re)opened: send any per-socket state (e.g. the import being shown). */
  onOpen?(socket: LiveSocket): void;
  onMessage(msg: ServerMessage): void;
}

export class LiveSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly path: string, private readonly h: LiveSocketHandlers) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (this.stopped) return;
    setLiveStatus("offline");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${this.path}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onOpen?.(this);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage | { type: "pong" };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "status") setLiveStatus(msg.upstream, msg.detail);
      this.h.onMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws || this.stopped) return;
      setLiveStatus("offline");
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
}
