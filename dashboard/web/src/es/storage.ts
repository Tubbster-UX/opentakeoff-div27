// The editor frame's localStorage. EasySchematic keeps its document and
// several per-document settings in localStorage (its autosave, custom
// templates, signal colors). In the Brink app the database is the store of
// record and each frame shows one project, so those keys live in memory for
// the frame's lifetime and never leak between projects or tabs. A short list
// of personal UI preferences (theme, minimap, report layouts) persists, under
// a "brink-es:" prefix so they never collide with a standalone EasySchematic
// on the same origin. Installed before any EasySchematic module runs; no
// vendored file is changed.

import { CURRENT_SCHEMA_VERSION } from "../../../../brink-merge/src/vendor/esEnums.generated.js";

const PREFIX = "brink-es:";
/** Personal preferences, kept across visits. Everything else is memory-only. */
const PERSIST = [/^easyschematic-theme$/, /^easyschematic-show-minimap$/, /^easyschematic-autoroute-pref$/, /^easyschematic-.*-layout$/, /^easyschematic-default-(stub-label-mode|header-color)$/];
/** EasySchematic's autosave key. Seeded with an empty document so it opens empty (no demo), then the project loads. */
const AUTOSAVE = "easyschematic-autosave";

class FrameStorage implements Storage {
  private readonly mem = new Map<string, string>();
  private readonly real: Storage | null;
  constructor(real: Storage | null) {
    this.real = real;
  }
  private persisted(key: string): boolean {
    return PERSIST.some((r) => r.test(key));
  }
  get length(): number {
    return this.keys().length;
  }
  private keys(): string[] {
    const out = [...this.mem.keys()];
    if (this.real) for (let i = 0; i < this.real.length; i++) {
      const k = this.real.key(i);
      if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
    return out;
  }
  key(index: number): string | null {
    return this.keys()[index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.persisted(key)) {
      try {
        return this.real?.getItem(PREFIX + key) ?? null;
      } catch {
        return null;
      }
    }
    return this.mem.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.persisted(key)) {
      try {
        this.real?.setItem(PREFIX + key, String(value));
      } catch {
        /* storage full or blocked: preferences are a convenience */
      }
      return;
    }
    this.mem.set(key, String(value));
  }
  removeItem(key: string): void {
    if (this.persisted(key)) {
      try {
        this.real?.removeItem(PREFIX + key);
      } catch {
        /* ignore */
      }
      return;
    }
    this.mem.delete(key);
  }
  clear(): void {
    this.mem.clear();
  }
}

export function installFrameStorage(): void {
  let real: Storage | null = null;
  try {
    real = window.localStorage;
  } catch {
    real = null;
  }
  const storage = new FrameStorage(real);
  storage.setItem(AUTOSAVE, JSON.stringify({ version: CURRENT_SCHEMA_VERSION, name: "", nodes: [], edges: [] }));
  Object.defineProperty(window, "localStorage", { configurable: true, enumerable: true, get: () => storage });
}
