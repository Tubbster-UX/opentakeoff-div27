// The MCP endpoints (docs/design/HOSTED_SERVER.md):
//
//   /mcp        Streamable HTTP, stateful. Each MCP session owns one OpenTakeoff
//               takeoff Session (the engine's own buildServer) plus the project
//               and document tools (src/projectTools.ts) on the same McpServer.
//   /mcp/brink  Streamable HTTP, stateless. The Brink parts list / schematic
//               tools (brink-merge) over one shared database.
//
// Both sit behind the bearer `guard`. The OpenTakeoff engine is the built bundle
// mcp/dist/server-core.js (`cd mcp && npm ci && npm run build`); brink-merge is
// imported from its TypeScript sources (tsx). Their shapes are declared in
// src/vendor.d.ts so this package's tsc never typechecks them.
//
// Tool hooks: every tool handler on a takeoff server is wrapped (through the
// SDK's tool registry, the one place both the engine's tools and ours live):
//   - path arguments of the engine's tools (load_plan, import_takeoff, export_*)
//     are confined to the open project's workspace; a bare file name lands in
//     the project's outputs dir;
//   - after any call on a session with an open project, the workspace's outputs
//     are pushed to the store (debounced); after an export_* call they are pushed
//     at once and the reply gains a download link per new output.
//
// Memory: a takeoff session holds its PDFs parsed in memory, so live sessions
// are capped (default 12, the longest-idle is evicted) and a session idle for
// 4 h is closed. Closing always lands the auto-save and pushes outputs first.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Autosave, Session } from "opentakeoff-core";
import type { BrinkState } from "brink-merge-mcp";
import type { AppDeps, MountMcp, ProjectId } from "./types.ts";
import {
  LINK_TTL_SEC, PROJECT_INSTRUCTIONS, PROJECT_TOOL_NAMES, UserError, fail, linksForPushed, registerProjectTools,
  type OpenState, type ToolReply,
} from "./projectTools.ts";
import { BID_INSTRUCTIONS, registerBidTools } from "./bidTools.ts";

type Core = typeof import("opentakeoff-core");
type BrinkMcp = typeof import("brink-merge-mcp");
type BrinkDb = typeof import("brink-merge-db");

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
/** OPENTAKEOFF_CORE / BRINK_MERGE_DIR override the repository layout (tests, odd deploys). */
const CORE_PATH = process.env.OPENTAKEOFF_CORE ?? here("../../mcp/dist/server-core.js");
const BRINK_DIR = process.env.BRINK_MERGE_DIR ?? here("../../brink-merge");

let corePromise: Promise<Core> | null = null;
/** The OpenTakeoff engine bundle (loaded once; note: it routes console.log to stderr). */
export function loadCore(): Promise<Core> {
  corePromise ??= (import(pathToFileURL(CORE_PATH).href) as Promise<Core>).catch((e) => {
    corePromise = null;
    throw new Error(`OpenTakeoff engine not found at ${CORE_PATH} (build it: cd mcp && npm ci && npm run build): ${e instanceof Error ? e.message : e}`);
  });
  return corePromise;
}

export interface McpMountOptions {
  /** Close a takeoff session idle this long (default 4 h). */
  idleMs?: number;
  /** Most live takeoff sessions; the longest-idle is evicted past it (default 12). */
  maxSessions?: number;
  /** How often idle sessions are looked for (default min(idleMs / 4, 60 s)). */
  sweepMs?: number;
  /** Debounce of the after-call output push (default 2000 ms). */
  syncDebounceMs?: number;
  /** Download link lifetime (default 24 h). */
  linkTtlSec?: number;
  /** OpenTakeoff auto-save timings (default: the engine's 750 ms / 2 s). */
  autosave?: { debounceMs?: number; maxWaitMs?: number };
  /** false: no /mcp/brink (default on). */
  brink?: boolean;
  log?: (line: string) => void;
}

type Handler = (...a: unknown[]) => Promise<ToolReply> | ToolReply;
interface ToolSlot { handler: Handler; inputSchema?: unknown }

/** The SDK keeps registered tools in McpServer._registeredTools (name → {handler, ...});
 * the engine's buildServer does not hand them out, so this is the one seam that
 * reaches both its tools and ours. Checked at session start, so an SDK change
 * fails loudly in the tests, not silently in production. */
function toolSlots(server: McpServer): Record<string, ToolSlot> {
  const slots = (server as unknown as { _registeredTools?: Record<string, ToolSlot> })._registeredTools;
  if (!slots || typeof slots !== "object") throw new Error("MCP SDK internals changed: McpServer._registeredTools is missing (src/mcp.ts wraps tool handlers through it)");
  return slots;
}

/** Wrap every registered handler; returns the unwrapped originals by name. */
function wrapTools(server: McpServer, wrap: (name: string, inner: Handler, hasInput: boolean) => Handler): Record<string, Handler> {
  const inner: Record<string, Handler> = {};
  for (const [name, slot] of Object.entries(toolSlots(server))) {
    if (typeof slot.handler !== "function") continue;
    inner[name] = slot.handler;
    slot.handler = wrap(name, slot.handler, slot.inputSchema !== undefined);
  }
  return inner;
}

/** Server instructions are fixed at construction; the SDK keeps them in Server._instructions. */
function appendInstructions(server: McpServer, text: string): void {
  const s = server.server as unknown as { _instructions?: string };
  if (typeof s._instructions !== "string") throw new Error("MCP SDK internals changed: Server._instructions is missing (src/mcp.ts extends the instructions)");
  s._instructions = `${s._instructions}\n${text}`;
}

const within = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const withText = (reply: ToolReply, text: string): ToolReply => ({ ...reply, content: [...reply.content, { type: "text", text }] });
const linkText = (project: string, links: { path: string; url: string }[], ttlSec: number) =>
  `Saved to project ${project}. Download links (valid ${Math.round(ttlSec / 3600)} h; give them to the user, they open on the phone):\n${links.map((l) => `- ${l.path}: ${l.url}`).join("\n")}`;

/** Engine tool arguments that name a file on disk. */
const PATH_ARGS = ["path", "xlsx_path"];
const BRINK_PATH_ARGS = ["path", "takeoff_path", "report_path"];

interface Live extends OpenState {
  id: string | null;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  session: Session;
  lastUsed: number;
  inflight: number;
  syncTimer: ReturnType<typeof setTimeout> | null;
  syncChain: Promise<unknown>;
  /** Export calls in progress collect what every push during them delivered,
   * so a debounced push that lands mid-export still gets its link. */
  recorders: Set<string[]>;
  closing: Promise<void> | null;
}

const rpcError = (res: Response, status: number, message: string) => {
  if (!res.headersSent) res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
};

export function createMountMcp(opts: McpMountOptions = {}): MountMcp {
  return (app, deps, guard) => {
    const idleMs = opts.idleMs ?? 4 * 60 * 60 * 1000;
    const maxSessions = Math.max(1, opts.maxSessions ?? 12);
    const sweepMs = opts.sweepMs ?? Math.min(Math.max(idleMs / 4, 10), 60_000);
    const syncDebounceMs = opts.syncDebounceMs ?? 2000;
    const ttl = opts.linkTtlSec ?? LINK_TTL_SEC;
    const log = opts.log ?? ((line: string) => process.stderr.write(`[mcp] ${line}\n`));
    const json = express.json({ limit: "8mb" });
    const sessions = new Map<string, Live>();
    const projectToolNames = new Set<string>(PROJECT_TOOL_NAMES);
    let closed = false;

    // ── outputs → store ────────────────────────────────────────────────────
    const syncNow = (live: Live, project: ProjectId): Promise<string[]> => {
      if (live.syncTimer) { clearTimeout(live.syncTimer); live.syncTimer = null; }
      const p = live.syncChain.then(() => deps.workspace.syncOutputs(project)).then((pushed) => {
        for (const rec of live.recorders) rec.push(...pushed);
        return pushed;
      });
      live.syncChain = p.catch(() => {});
      return p;
    };
    const scheduleSync = (live: Live) => {
      if (live.syncTimer) clearTimeout(live.syncTimer);
      live.syncTimer = setTimeout(() => {
        live.syncTimer = null;
        const project = live.project;
        if (project) syncNow(live, project).catch((e) => log(`sync ${project} failed: ${msg(e)}`));
      }, syncDebounceMs);
      live.syncTimer.unref?.();
    };

    // ── path confinement for the engine's file arguments ───────────────────
    const confine = (live: Live, name: string, args: Record<string, unknown>): Record<string, unknown> => {
      const keys = PATH_ARGS.filter((k) => typeof args?.[k] === "string");
      if (!keys.length) return args;
      const project = live.project;
      if (!project) throw new UserError(`${name} reads or writes a file, and on this server files live in projects: call open_project first (list_projects shows them).`);
      const root = path.resolve(deps.workspace.dir(project));
      const out = path.resolve(deps.workspace.outputsDir(project));
      const copy = { ...args };
      for (const k of keys) {
        const v = String(copy[k]);
        if (v.includes("\0")) throw new UserError(`${k} is not a valid path.`);
        const abs = path.isAbsolute(v) ? path.resolve(v) : path.resolve(out, v);
        if (!within(root, abs) && !within(out, abs)) {
          throw new UserError(`${k} ${JSON.stringify(v)} is outside project ${project}'s workspace. Pass a file name (it is written to the project's outputs) or omit it for the default name.`);
        }
        copy[k] = abs;
      }
      return copy;
    };

    // ── session lifecycle ──────────────────────────────────────────────────
    const closeLive = (live: Live, reason: string): Promise<void> => {
      live.closing ??= (async () => {
        if (live.id && sessions.get(live.id) === live) sessions.delete(live.id);
        if (live.syncTimer) { clearTimeout(live.syncTimer); live.syncTimer = null; }
        try { await live.autosave?.flush(); } catch (e) { log(`autosave flush failed: ${msg(e)}`); }
        if (live.project) {
          try { await syncNow(live, live.project); } catch (e) { log(`sync ${live.project} on close failed: ${msg(e)}`); }
        }
        try { await live.server.close(); } catch { /* already closed */ }
        for (const d of live.session.docs?.values() ?? []) await d.doc.destroy().catch(() => {});
        log(`session ${live.id ?? "(uninitialized)"} closed: ${reason}`);
      })();
      return live.closing;
    };

    const evictIfFull = async () => {
      while (sessions.size >= maxSessions) {
        const all = [...sessions.values()];
        const idle = all.filter((l) => l.inflight === 0);
        const victim = (idle.length ? idle : all).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        await closeLive(victim, `evicted: ${maxSessions} live sessions is the cap`);
      }
    };

    const newLive = async (): Promise<Live> => {
      const core = await loadCore();
      await evictIfFull();
      const session = new core.Session();
      const server = core.buildServer(session);
      appendInstructions(server, PROJECT_INSTRUCTIONS);
      appendInstructions(server, BID_INSTRUCTIONS);
      const live: Live = {
        id: null, project: null, autosave: null, session, server,
        transport: null as unknown as StreamableHTTPServerTransport,
        lastUsed: Date.now(), inflight: 0, syncTimer: null, syncChain: Promise.resolve(), recorders: new Set(), closing: null,
      };
      let inner: Record<string, Handler> = {};
      registerProjectTools(server, {
        deps,
        session,
        state: live,
        linkTtlSec: ttl,
        makeAutosave: (dir: string): Autosave => new core.Autosave({ mode: { kind: "dir", path: dir }, ...opts.autosave, log: (l) => log(l) }),
        callTool: async (name, args) => {
          const h = inner[name];
          if (!h) throw new Error(`no tool ${name}`);
          return h(args, {});
        },
        othersWithProject: (project) => [...sessions.values()].filter((l) => l !== live && l.project === project && !l.closing).length,
        flushProject: async (project) => {
          try { await syncNow(live, project); } catch (e) { log(`sync ${project} failed: ${msg(e)}`); }
        },
        resourcesChanged: () => { try { server.sendResourceListChanged(); } catch { /* not connected */ } },
      });
      registerBidTools(server, { deps, session, state: live, linkTtlSec: ttl, pushOutputs: (project) => syncNow(live, project) });
      inner = wrapTools(server, (name, h, hasInput) => async (...a: unknown[]): Promise<ToolReply> => {
        live.inflight++;
        live.lastUsed = Date.now();
        const recorder: string[] = [];
        if (name.startsWith("export_")) {
          live.recorders.add(recorder);
          // the export pushes at its end; a debounced push mid-write would split it
          if (live.syncTimer) { clearTimeout(live.syncTimer); live.syncTimer = null; }
        }
        try {
          if (hasInput && !projectToolNames.has(name)) {
            try {
              a[0] = confine(live, name, (a[0] ?? {}) as Record<string, unknown>);
            } catch (e) {
              return fail(e);
            }
          }
          const reply = await h(...a);
          const project = live.project;
          if (!project) return reply;
          if (!name.startsWith("export_") || reply.isError) {
            scheduleSync(live);
            return reply;
          }
          try {
            await syncNow(live, project);
            const links = await linksForPushed(deps, project, [...new Set(recorder)], ttl);
            return links.length ? withText(reply, linkText(project, links, ttl)) : reply;
          } catch (e) {
            log(`sync ${project} after ${name} failed: ${msg(e)}`);
            return withText(reply, `The file is written on the server, but pushing it to project ${project} failed (${msg(e)}). The next tool call retries; project_outputs lists what arrived.`);
          }
        } finally {
          live.recorders.delete(recorder);
          live.inflight--;
          live.lastUsed = Date.now();
        }
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          live.id = id;
          sessions.set(id, live);
        },
      });
      transport.onclose = () => { void closeLive(live, "transport closed"); };
      live.transport = transport;
      await server.connect(transport);
      return live;
    };

    const sessionId = (req: Request) => {
      const h = req.headers["mcp-session-id"];
      return Array.isArray(h) ? h[0] : h;
    };

    app.post("/mcp", guard, json, async (req: Request, res: Response) => {
      try {
        if (closed) return rpcError(res, 503, "Server is shutting down");
        const sid = sessionId(req);
        if (sid) {
          const live = sessions.get(sid);
          if (!live) return rpcError(res, 404, "Session not found or expired; start a new session (initialize)");
          live.lastUsed = Date.now();
          await live.transport.handleRequest(req, res, req.body);
          return;
        }
        if (!isInitializeRequest(req.body)) return rpcError(res, 400, "Bad Request: no Mcp-Session-Id header and not an initialize request");
        const live = await newLive();
        await live.transport.handleRequest(req, res, req.body);
        if (!live.id) await closeLive(live, "initialize failed");
      } catch (e) {
        log(`POST /mcp failed: ${msg(e)}`);
        rpcError(res, 500, `Internal error: ${msg(e)}`);
      }
    });

    const sessionRequest = async (req: Request, res: Response) => {
      try {
        const sid = sessionId(req);
        if (!sid) return rpcError(res, 400, "Bad Request: Mcp-Session-Id header required");
        const live = sessions.get(sid);
        if (!live) return rpcError(res, 404, "Session not found or expired");
        live.lastUsed = Date.now();
        await live.transport.handleRequest(req, res);
      } catch (e) {
        log(`${req.method} /mcp failed: ${msg(e)}`);
        rpcError(res, 500, `Internal error: ${msg(e)}`);
      }
    };
    app.get("/mcp", guard, sessionRequest);
    app.delete("/mcp", guard, sessionRequest);

    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const live of sessions.values()) {
        if (live.inflight === 0 && !live.closing && now - live.lastUsed > idleMs) void closeLive(live, `idle ${Math.round((now - live.lastUsed) / 60000)} min`);
      }
    }, sweepMs);
    sweeper.unref?.();

    // ── /mcp/brink ─────────────────────────────────────────────────────────
    const brinkOn = opts.brink !== false;
    let brinkPromise: Promise<{ mod: BrinkMcp; state: BrinkState }> | null = null;
    const getBrink = () => {
      brinkPromise ??= (async () => {
        const dbMod = (await import(pathToFileURL(path.join(BRINK_DIR, "src/db/db.ts")).href)) as BrinkDb;
        const mod = (await import(pathToFileURL(path.join(BRINK_DIR, "src/mcp/server.ts")).href)) as BrinkMcp;
        const url = deps.config.databaseUrl ?? null;
        const pgliteDir = url ? null : path.join(deps.config.dataDir, "brink-pglite");
        if (pgliteDir) await mkdir(pgliteDir, { recursive: true });
        const state: BrinkState = { db: await dbMod.openDb({ url, pgliteDir }) };
        await mod.prepare(state);
        return { mod, state };
      })().catch((e) => {
        brinkPromise = null;
        throw e;
      });
      return brinkPromise;
    };
    if (brinkOn) getBrink().catch((e) => log(`brink tools unavailable: ${msg(e)}`));

    const projectForPath = async (abs: string): Promise<ProjectId | null> => {
      for (const m of await deps.projects.list()) if (within(path.resolve(deps.workspace.dir(m.id)), abs)) return m.id;
      return null;
    };

    const BRINK_HOSTED = "HOSTED: file paths (takeoff_path, report_path, export path) must be absolute paths inside a project's workspace: use the paths the opentakeoff connector's export_takeoff / export_report replies give, and write exports next to them. Exports come back with download links for the user.";

    const buildBrink = (mod: BrinkMcp, state: BrinkState): McpServer => {
      const server = mod.buildServer(state);
      appendInstructions(server, BRINK_HOSTED);
      wrapTools(server, (name, h, hasInput) => async (...a: unknown[]): Promise<ToolReply> => {
        let project: ProjectId | null = null;
        if (hasInput) {
          const args = { ...((a[0] ?? {}) as Record<string, unknown>) };
          for (const k of BRINK_PATH_ARGS) {
            if (typeof args[k] !== "string") continue;
            const v = String(args[k]);
            const owner = path.isAbsolute(v) && !v.includes("\0") ? await projectForPath(path.resolve(v)) : null;
            if (!owner) return fail(new UserError(`${k} ${JSON.stringify(v)} is not inside a project's workspace. ${BRINK_HOSTED}`));
            args[k] = path.resolve(v);
            if (k === "path") project = owner;
          }
          a[0] = args;
        }
        const reply = await h(...a);
        if (!project || !name.startsWith("export_") || reply.isError) return reply;
        try {
          const links = await linksForPushed(deps, project, await deps.workspace.syncOutputs(project), ttl);
          return links.length ? withText(reply, linkText(project, links, ttl)) : reply;
        } catch (e) {
          return withText(reply, `Written on the server, but pushing it to project ${project} failed (${msg(e)}).`);
        }
      });
      return server;
    };

    app.post("/mcp/brink", guard, json, async (req: Request, res: Response) => {
      if (!brinkOn) return rpcError(res, 404, "The Brink tools are not enabled on this server");
      try {
        const { mod, state } = await getBrink();
        const server = buildBrink(mod, state);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        log(`POST /mcp/brink failed: ${msg(e)}`);
        rpcError(res, 500, `Internal error: ${msg(e)}`);
      }
    });
    const brinkNoSession = (_req: Request, res: Response) => {
      res.set("Allow", "POST");
      rpcError(res, 405, "Method not allowed: /mcp/brink is stateless (POST only)");
    };
    app.get("/mcp/brink", guard, brinkNoSession);
    app.delete("/mcp/brink", guard, brinkNoSession);

    return {
      async close() {
        closed = true;
        clearInterval(sweeper);
        await Promise.all([...sessions.values()].map((l) => closeLive(l, "server shutting down")));
        if (brinkPromise) {
          try { await (await brinkPromise).state.db.close(); } catch { /* never opened */ }
        }
      },
    };
  };
}

/** The mount main.ts uses: 4 h idle close, 12 live sessions, /mcp/brink on. */
export const mountMcp: MountMcp = createMountMcp();
