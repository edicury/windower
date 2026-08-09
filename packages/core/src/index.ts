/**
 * @windower/core — shared Zod schemas (data-model.md), sidecar protocol client,
 * and daemon client, consumed by the CLI, MCP server, and Claude Code plugin.
 *
 * See specs/001-windower-mvp/plan.md and contracts/sidecar-protocol.md.
 */
export const CORE_PACKAGE_NAME = "@windower/core";

export * from "./schemas/index.js";
export * from "./protocol/index.js";
export * from "./process/index.js";
export * from "./daemon/index.js";
export * from "./operator/index.js";
