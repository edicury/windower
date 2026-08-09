/**
 * Barrel that wires every tool module into the server. Each tool module
 * exports a `register*Tools(server, getBackend)` function with this shape:
 *
 *   (server: McpServer, getBackend: GetBackend) => void
 *
 * `getBackend` (`../backend.js`) routes each call to either the shared
 * `LocalWindower` or the memoized daemon connection, per
 * `contracts/mcp-tools.md`'s "Backend routing (Phase 20)" table
 * (`MCP_LOCAL_TOOLS`). `run_operator` is the one exception — it opens its
 * own env-scoped connection per call (`../daemon-client.js`'s
 * `connectForOperatorRun`) rather than going through `getBackend` at all.
 * Handlers should wrap the whole body in
 * `try { ... } catch (err) { return toMcpError(err); }`.
 *
 * Add new tool files here as they land — this is the single place
 * `server.ts` needs to know about.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetBackend } from "../backend.js";
import { registerOperatorTools } from "./operator.js";
import { registerReadTools } from "./read.js";
import { registerSessionTools } from "./session.js";

export function registerTools(server: McpServer, getBackend: GetBackend): void {
  registerReadTools(server, getBackend);
  registerSessionTools(server, getBackend);
  registerOperatorTools(server, getBackend);
}
