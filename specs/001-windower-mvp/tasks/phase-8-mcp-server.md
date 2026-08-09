## Phase 8 — MCP Server

**Goal:** Ship `packages/mcp-server` implementing every tool in `contracts/mcp-tools.md`, giving MCP-capable agents (Claude Desktop, Claude Code, others) direct programmatic access without shelling out to the CLI.

- 🔵 `@modelcontextprotocol/sdk` server scaffold, stdio transport (primary), SSE optional.
- 🔵 Implement all tools: `list_targets`, `check_permissions`, `request_permission`, `resize_window`, `start_recording`, `get_session`, `stop_recording`, `cancel_recording`, `list_sessions` — each a thin wrapper over the Phase 6 daemon client (same `packages/core` client the CLI uses, not a reimplementation).
- 🔵 Tool `description` fields written to be self-sufficient per `contracts/mcp-tools.md`'s note — explicit about non-blocking `start_recording` semantics, since a model reading only the tool description (no `SKILL.md`) needs to understand the two-call pattern.
- 🔵 Input/output schemas generated from the same Zod schemas as the CLI's `--json` shapes — single source of truth, no drift.
- 🔵 Packaging: runnable via `npx @windower/mcp-server` and registerable in a Claude Desktop/Code MCP config.

**Exit criteria**

- Matches `spec.md` acceptance item: MCP server exposes all tools and a real MCP client (Claude Desktop or Claude Code) can drive a full record-a-demo loop through it (enumerate → resize → start → [agent performs actions] → stop) with no CLI involvement.
- Tool outputs are byte-for-byte structurally identical (schema-wise) to the CLI's `--json` output for the equivalent operation.
- Manually verified in an actual Claude Desktop/Code session: connect the MCP server, ask the agent to record a short demo, confirm the resulting file plays correctly.
