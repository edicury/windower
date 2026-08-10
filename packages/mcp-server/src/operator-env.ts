/**
 * `run_operator`'s scoped `hello` env snapshot. The implementation lives in
 * `@windower/core` (`daemon/operator-env.ts`) so this MCP server and
 * `windower operate --detach` share ONE copy — both are daemon clients that
 * must forward their own API key/`env:` secrets to a daemon whose
 * `process.env` was frozen at spawn time. Re-exported here so the existing
 * `./operator-env.js` import sites (and their tests) keep working.
 *
 * Sourced from the MCP SERVER PROCESS's own `process.env` — i.e. whatever
 * `mcpServers.<name>.env` block the user configured in their MCP host.
 */
export { buildOperatorHelloEnv } from "@windower/core";
