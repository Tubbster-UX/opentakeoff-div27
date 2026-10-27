#!/usr/bin/env node
// Starts the headless brink MCP server (stdio) through tsx.
import { register } from "tsx/esm/api";
register();
await import("../src/mcp/main.ts");
