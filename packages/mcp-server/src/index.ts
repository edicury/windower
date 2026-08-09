#!/usr/bin/env node
/**
 * @windower/mcp-server — MCP tools exposing Windower to agents, a thin wrapper
 * over @windower/core using the same Zod schemas as the CLI's --json output.
 *
 * Runnable entrypoint: builds the server (`./server.js`) and connects it to
 * stdio, the primary transport per contracts/mcp-tools.md. This is the
 * `bin` target — `npx @windower/mcp-server` (or a Claude Desktop/Code MCP
 * config entry) runs this file directly.
 *
 * See specs/001-windower-mvp/contracts/mcp-tools.md.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export const MCP_SERVER_PACKAGE_NAME = "@windower/mcp-server";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `[windower-mcp-server] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
