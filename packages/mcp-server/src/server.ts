/**
 * Builds the Windower MCP server instance: tool registration only, no
 * transport concerns (see `index.ts` for the stdio entrypoint). Kept
 * separate from `index.ts` so it can be constructed and driven in-process
 * by tests without touching stdin/stdout.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultGetBackend } from "./backend.js";
import { registerTools } from "./tools/index.js";

export const MCP_SERVER_NAME = "windower";
export const MCP_SERVER_VERSION = "0.0.0";

export function createServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  registerTools(server, defaultGetBackend());

  return server;
}
