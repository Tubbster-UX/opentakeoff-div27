// stdio entry for the brink MCP server.
//   DATABASE_URL       hosted or local Supabase / Postgres (service-role connection string)
//   BRINK_PGLITE_DIR   otherwise: a local PGlite database directory (default: in memory)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../db/db.js";
import { buildServer, prepare } from "./server.js";

const db = await openDb();
const state = { db };
await prepare(state);
const server = buildServer(state);
await server.connect(new StdioServerTransport());
console.error(`brink MCP server ready (${db.kind}${db.kind === "pglite" && !process.env.BRINK_PGLITE_DIR ? ", in memory: set BRINK_PGLITE_DIR to keep data" : ""})`);
