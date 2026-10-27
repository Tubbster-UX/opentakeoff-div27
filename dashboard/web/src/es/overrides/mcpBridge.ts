// Brink override of EasySchematic's src/mcpBridge.ts (vendor/PATCHES.md).
// Upstream's bridge lets a local EasySchematic MCP server drive the editor
// over a localhost WebSocket. An internal web page should not reach into the
// user's machine, and agents drive Brink through brink-merge's MCP server, so
// the bridge never connects here.

export type BridgeStatus = "off" | "connecting" | "connected" | "error";

export function useMcpBridge(): void {}
