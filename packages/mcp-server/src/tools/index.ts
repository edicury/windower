/**
 * Barrel that wires every tool module into the server. Each tool module
 * exports a `register*Tools(server, getClient)` function with this shape:
 *
 *   (server: McpServer, getClient: () => Promise<DaemonClient>) => void
 *
 * `getClient` is `getDaemonClient` from `../daemon-client.js` — a memoized
 * accessor for the process-wide `DaemonClient`, not a fresh connection per
 * call. Handlers should `await getClient()` and wrap the whole body in
 * `try { ... } catch (err) { return toMcpError(err); }`.
 *
 * Add new tool files here as they land (e.g. `./session.ts` for the
 * recording-lifecycle tools) — this is the single place `server.ts` needs
 * to know about.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonClient } from "@windower/core";
import { registerOperatorTools } from "./operator.js";
import { registerReadTools } from "./read.js";
import { registerSessionTools } from "./session.js";

export function registerTools(server: McpServer, getClient: () => Promise<DaemonClient>): void {
  registerReadTools(server, getClient);
  registerSessionTools(server, getClient);
  registerOperatorTools(server, getClient);
}
