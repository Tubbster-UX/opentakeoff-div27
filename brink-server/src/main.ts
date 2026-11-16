// brink-server entry: environment → config → store → projects/ingest/search/
// workspace → express app (login, upload page, OAuth) + MCP endpoints.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { storageFromConfig } from "./storage.ts";
import { StoreProjects } from "./projects.ts";
import { StoreIngest } from "./ingest.ts";
import { StoreSearch } from "./search.ts";
import { DiskWorkspace } from "./workspace.ts";
import { buildApp } from "./http.ts";
import { mountMcp } from "./mcp.ts";
import type { AppDeps } from "./types.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const storage = storageFromConfig(config.storage);
const projects = new StoreProjects(storage);
const deps: AppDeps = {
  config,
  storage,
  projects,
  ingest: new StoreIngest({ storage, projects, tmpDir: path.join(config.dataDir, "tmp") }),
  search: new StoreSearch({ storage, projects }),
  workspace: new DiskWorkspace({ storage, projects, dataDir: config.dataDir }),
};

const { app, close } = buildApp(deps, mountMcp);
const server = app.listen(config.port, () => {
  console.error(`brink-server listening on :${config.port} (${config.publicUrl}, store ${storage.label})`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.error(`brink-server: ${signal}, saving open work`);
  server.close();
  try {
    await close();
  } catch (e) {
    console.error("brink-server: shutdown error", e);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
