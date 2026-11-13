// The page's localStorage as EasySchematic sees it. EasySchematic keeps its
// document and several per-document settings in localStorage (its autosave,
// custom templates, signal colors). In the Brink app the database is the store
// of record, so those keys live in memory only, and are reset whenever the
// editor opens a project (resetEditorDocument), so they never leak between
// projects or browser tabs. A short list of personal UI preferences (theme,
// minimap, report layouts) persists, under a "brink-es:" prefix so they never
// collide with a standalone EasySchematic on the same origin.
//
// Installed once, before the first EasySchematic module evaluates (they read
// localStorage at load): web/src/es/load.ts installs it and only then imports the
// editor. The Brink shell keeps the real storage (design/theme.ts captures it
// first). No vendored file is changed.

import { CURRENT_SCHEMA_VERSION } from "../../../../brink-merge/src/vendor/esEnums.generated.js";

const PREFIX = "brink-es:";
/** Personal preferences, kept across visits. Everything else is memory-only. */
const PERSIST = [/^easyschematic-theme$/, /^easyschematic-show-minimap$/, /^easyschematic-autoroute-pref$/, /^easyschematic-.*-layout$/, /^easyschematic-default-(stub-label-mode|header-color)$/];
/**
 * Not EasySchematic's: the Takeoff tab's OpenTakeoff canvas keeps its per-viewer preferences (units, draw style,
 * panel widths, the declared author) under these keys. The page has one localStorage, so they pass straight through
 * to the real one, unprefixed, whichever tab was opened first (vendor/PATCHES.md, OpenTakeoff section 5).
 */
const PASS_THROUGH = [/^opentakeoff[_:]/, /^ot[.-]/];
/** EasySchematic's autosave key. Seeded with an empty document so it opens empty (no demo), then the project loads. */
const AUTOSAVE = "easyschematic-autosave";

class EditorStorage implements Storage {
  private readonly mem = new Map<string, string>();
  private readonly real: Storage | null;
  constructor(real: Storage | null) {
    this.real = real;
  }
  private persisted(key: string): boolean {
    return PERSIST.some((r) => r.test(key));
  }
  private passThrough(key: string): boolean {
    return PASS_THROUGH.some((r) => r.test(key));
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
    if (this.passThrough(key)) {
      try {
        return this.real?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
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
    if (this.passThrough(key)) {
      try {
        this.real?.setItem(key, String(value));
      } catch {
        /* storage full or blocked: preferences are a convenience */
      }
      return;
    }
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
    if (this.passThrough(key)) {
      try {
        this.real?.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
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

let installed: EditorStorage | null = null;

const EMPTY_DOC = () => JSON.stringify({ version: CURRENT_SCHEMA_VERSION, name: "", nodes: [], edges: [] });

export function installEditorStorage(): void {
  if (installed) return;
  let real: Storage | null = null;
  try {
    real = window.localStorage;
  } catch {
    real = null;
  }
  const storage = new EditorStorage(real);
  storage.setItem(AUTOSAVE, EMPTY_DOC());
  installed = storage;
  Object.defineProperty(window, "localStorage", { configurable: true, enumerable: true, get: () => storage });
}

/** A project is opening in the editor: forget the previous project's memory-only keys and start from an empty document. */
export function resetEditorDocument(): void {
  if (!installed) return;
  installed.clear();
  installed.setItem(AUTOSAVE, EMPTY_DOC());
}
