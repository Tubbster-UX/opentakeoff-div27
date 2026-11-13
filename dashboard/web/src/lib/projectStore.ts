// One project, live: reads a snapshot over /api, then applies row changes
// relayed by the Worker's Durable Object. Framework-free (React reads it with
// useSyncExternalStore), and shared by every tab of the project, so switching
// tabs keeps the socket and the data.
//
// Ordering rules (unchanged from the first dashboard):
// - changes that arrive while a snapshot is being read are buffered and
//   replayed after it (upserts by primary key: idempotent);
// - every "live" status from the relay triggers a re-read, which covers
//   changes made before the subscription was in place;
// - a change that moves current_import_id (re-import / re-merge) triggers a re-read.
import { PROJECT_TABLES, type ClientMessage, type RowChange, type ServerMessage, type Snapshot } from "../../../src/shared/protocol.js";
import { applyChange } from "../../../src/shared/state.js";
import { short } from "./format.js";
import { LiveSocket } from "./liveSocket.js";

export interface FeedItem {
  id: number;
  at: string;
  text: string;
}

export interface ProjectState {
  snap: Snapshot | null;
  notFound: boolean;
  error: string | null;
  /** Newest first, at most FEED_MAX. */
  feed: FeedItem[];
  /** Row keys (`table:pk`) changed live, with a sequence number so a repeat change re-flashes. */
  flash: Record<string, number>;
}

const FEED_MAX = 12;
const FLASH_MS = 2600;

export class ProjectStore {
  private state: ProjectState = { snap: null, notFound: false, error: null, feed: [], flash: {} };
  private readonly listeners = new Set<() => void>();
  /** Raw relayed changes, for views that keep their own state (the schematic editor frame). */
  private readonly changeListeners = new Set<(c: RowChange) => void>();
  private readonly socket: LiveSocket;
  private loading = false;
  private resyncAgain = false;
  private buffer: RowChange[] = [];
  private seq = 0;
  private stopped = false;
  private emitQueued = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly projectId: string) {
    this.socket = new LiveSocket(`/api/projects/${projectId}/live`, {
      onOpen: () => this.sendWatch(),
      onMessage: (m) => this.onMessage(m),
    });
  }

  start(): void {
    this.stopped = false;
    void this.resync();
    this.socket.start();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket.stop();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): ProjectState => this.state;

  /** Every relayed row change, as it arrives (before the snapshot logic). */
  onChange(l: (c: RowChange) => void): () => void {
    this.changeListeners.add(l);
    return () => this.changeListeners.delete(l);
  }

  private set(patch: Partial<ProjectState>): void {
    this.state = { ...this.state, ...patch };
    // Many changes can land in one burst: render once per frame.
    if (this.emitQueued) return;
    this.emitQueued = true;
    const flush = () => {
      this.emitQueued = false;
      for (const l of this.listeners) l();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  private onMessage(m: ServerMessage): void {
    if (m.type === "status") {
      // Changes made before the relay's subscription was live were not delivered: read again.
      if (m.upstream === "live") void this.resync();
    } else if (m.type === "change") {
      for (const l of this.changeListeners) l(m.change);
      // The edit layers and plan sheets are not part of the snapshot: only the workspaces use them.
      if (PROJECT_TABLES.includes(m.change.table)) return;
      if (this.loading || !this.state.snap) this.buffer.push(m.change);
      else this.applyOne(m.change, true);
    }
  }

  private sendWatch(): void {
    const msg: ClientMessage = { type: "watch", importId: (this.state.snap?.import?.id as string | undefined) ?? null };
    this.socket.send(msg);
  }

  private async resync(): Promise<void> {
    if (this.loading) {
      this.resyncAgain = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.resyncAgain = false;
        const res = await fetch(`/api/projects/${this.projectId}`, { cache: "no-store" });
        if (this.stopped) return;
        if (res.status === 404) {
          this.set({ snap: null, notFound: true, error: null });
          return;
        }
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const prevImport = this.state.snap?.import?.id;
        const snap = (await res.json()) as Snapshot;
        this.set({ snap, notFound: false, error: null });
        if (prevImport && prevImport !== snap.import?.id) this.log(`switched to import ${short(snap.import?.id)} (current_import_id changed)`);
        this.sendWatch();
        // Replay what arrived while reading (upserts by primary key, in order: idempotent).
        const pending = this.buffer;
        this.buffer = [];
        for (const c of pending) this.applyOne(c, false);
      } while (this.resyncAgain);
    } catch (e) {
      this.set({ error: `Could not read the project: ${(e as Error).message}. Retrying…` });
      this.retryTimer = setTimeout(() => void this.resync(), 3000);
    } finally {
      this.loading = false;
    }
  }

  private applyOne(c: RowChange, flash: boolean): void {
    const snap = this.state.snap;
    if (!snap) return;
    const r = applyChange(snap, c);
    if (r.kind === "applied") {
      const patch: Partial<ProjectState> = { snap: r.snapshot };
      if (r.key && flash) {
        const k = `${c.table}:${r.key}`;
        const n = ++this.seq;
        patch.flash = { ...this.state.flash, [k]: n };
        setTimeout(() => {
          if (this.state.flash[k] !== n) return;
          const { [k]: _gone, ...rest } = this.state.flash;
          this.set({ flash: rest });
        }, FLASH_MS);
      }
      this.set(patch);
      this.log(`${c.type.toLowerCase()} ${c.table.replace("brink_", "")} ${r.key ?? ""}`);
    } else if (r.kind === "resync") {
      this.log(`${r.reason}: reloading`);
      if (this.loading) this.resyncAgain = true;
      else void this.resync();
    }
  }

  private log(text: string): void {
    const item: FeedItem = { id: ++this.seq, at: new Date().toLocaleTimeString(), text };
    this.set({ feed: [item, ...this.state.feed].slice(0, FEED_MAX) });
  }
}
