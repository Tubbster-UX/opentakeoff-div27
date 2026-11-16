// Shapes of the two engines brink-server loads at runtime, declared here so
// this package's tsc never typechecks their sources (each has its own
// node_modules, tsconfig and checks):
//
//   "opentakeoff-core"  → ../../mcp/dist/server-core.js (the OpenTakeoff MCP
//                          bundle: `cd mcp && npm ci && npm run build`)
//   "brink-merge-mcp"   → ../../brink-merge/src/mcp/server.ts (run by tsx)
//   "brink-merge-db"    → ../../brink-merge/src/db/db.ts
//
// src/mcp.ts imports them by file URL and casts to these module types. Only
// what brink-server uses is declared.

declare module "opentakeoff-core" {
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

  export type AutosaveMode =
    | { kind: "off" }
    | { kind: "default" }
    | { kind: "file"; path: string }
    | { kind: "dir"; path: string };

  export interface FoundAutosave {
    path: string;
    saved_at: string | null;
    tool: string | null;
    plan: string | null;
    shapes: number;
    conditions: number;
    cable_runs: number;
  }

  export interface AutosaveLoadInfo {
    path: string | null;
    disabled?: true;
    found?: FoundAutosave;
    error?: string;
  }

  export interface AutosaveStatus {
    path: string | null;
    saved_at: string | null;
    error?: string;
    pending?: true;
    disabled?: true;
    moved_aside?: string;
  }

  export class Autosave {
    constructor(opts?: {
      mode?: AutosaveMode;
      debounceMs?: number;
      maxWaitMs?: number;
      now?: () => Date;
      log?: (line: string) => void;
    });
    readonly mode: AutosaveMode;
    readonly enabled: boolean;
    readonly path: string | null;
    writes: number;
    attach(session: Session): this;
    touch(tool: string, opts?: { weak?: boolean }): void;
    flush(): Promise<void>;
    flushSync(): void;
    idle(): Promise<void>;
    status(): AutosaveStatus;
  }

  export interface SheetSummary {
    sheet: string;
    page: number;
    sheet_number?: string;
    detected_scale?: string;
    [k: string]: unknown;
  }

  export interface LoadPlanResult {
    file: string;
    files: string[];
    page_count: number;
    sheets: SheetSummary[];
    autosave?: AutosaveLoadInfo;
    note: string;
  }

  export class Session {
    constructor();
    autosave: Autosave | null;
    file: string | null;
    filePath: string | null;
    readonly files: string[];
    loadPlan(filePath: string, opts?: { merge?: boolean }): Promise<LoadPlanResult>;
    /** Private in the engine; read only to release PDF documents when an MCP session closes. */
    readonly docs?: Map<string, { doc: { destroy(): Promise<void> }; path: string }>;
  }

  export function buildServer(session?: Session, opts?: { stagedTools?: boolean; oneClick?: boolean }): McpServer;
  export function installExitFlush(autosave: Autosave, proc?: NodeJS.Process): () => void;
}

declare module "brink-merge-db" {
  export interface Db {
    readonly kind: "postgres" | "pglite";
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
  }
  export function openDb(opts?: { url?: string | null; pgliteDir?: string | null }): Promise<Db>;
}

declare module "brink-merge-mcp" {
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import type { Db } from "brink-merge-db";
  export interface BrinkState {
    db: Db;
    ready?: Promise<void>;
  }
  export const INSTRUCTIONS: string;
  export function prepare(state: BrinkState, mapPath?: string): Promise<void>;
  export function buildServer(state: BrinkState): McpServer;
}
