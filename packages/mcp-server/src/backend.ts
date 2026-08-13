/**
 * Backend routing for MCP tools (Phase 20, `phase-20-daemon-optional.md`
 * "MCP routing", `contracts/mcp-tools.md`'s "Backend routing (Phase 20)"
 * section).
 *
 * `packages/core/src/daemon/policy.ts`'s `POLICY_TABLE` is keyed by the
 * CLI's `CommandId` strings (e.g. `"targets"`, `"resize"`, `"status"`),
 * which don't line up 1:1 with MCP tool names (`list_targets`,
 * `resize_window`, `get_session`, ...) — there is no single string both
 * surfaces can index the same table with. `MCP_LOCAL_TOOLS` below is the
 * MCP-facing transcription of that table's *values* for the tools that have
 * a CLI analog, plus `request_permission` (the MCP counterpart of the CLI's
 * `"permission request"` entry, itself `local`). `backend.test.ts` asserts
 * each transcribed entry still matches `resolveBackendMode` for its CLI
 * counterpart, so this file can't silently drift from `policy.ts`.
 */
import type { WindowerBackend } from "@windower/core";
import { LocalWindower } from "@windower/engine";
import { getDaemonClient } from "./daemon-client.js";

/**
 * Every MCP tool that goes through this router. `shutdown` and
 * `list_operator_runs` are deliberately absent — per `contracts/mcp-tools.md`,
 * `shutdown` is a daemon-only RPC never exposed as an MCP tool, and
 * `list_operator_runs` no longer exists (Phase 24 removed the Operator).
 */
export type McpToolId =
  | "list_targets"
  | "check_permissions"
  | "request_permission"
  | "resize_window"
  | "get_session"
  | "list_sessions"
  | "start_recording"
  | "stop_recording"
  | "cancel_recording";

/**
 * Tools routed `local` (Phase 20): a transient, daemon-free sidecar spawn
 * (`list_targets`/`check_permissions`/`request_permission`/`resize_window`,
 * via `LocalWindower`'s `PassthroughService`) or a direct session-store read
 * (`get_session`/`list_sessions`). Everything else in `McpToolId` is
 * `daemon`-backed — `start_recording`/`stop_recording`/`cancel_recording`
 * because split-invocation recording needs a process that outlives the
 * calling tool call.
 */
export const MCP_LOCAL_TOOLS: ReadonlySet<McpToolId> = new Set<McpToolId>([
  "list_targets",
  "check_permissions",
  "request_permission",
  "resize_window",
  "get_session",
  "list_sessions",
]);

let sharedLocalWindower: LocalWindower | undefined;

/**
 * One `LocalWindower` for the MCP server process's lifetime — construction
 * is cheap (no I/O; its stores lazy-load on first store-touching call), so
 * there's no benefit to constructing a fresh one per tool call, and sharing
 * one avoids redundant `SessionStore` loads.
 */
export function getLocalWindower(): LocalWindower {
  if (!sharedLocalWindower) {
    sharedLocalWindower = new LocalWindower();
  }
  return sharedLocalWindower;
}

/** Test-only hook to reset the memoized `LocalWindower` between test cases. */
export function resetLocalWindowerForTests(): void {
  sharedLocalWindower = undefined;
}

/**
 * `(toolId) => Promise<WindowerBackend>` — every tool file's handlers call
 * this with their own tool name and get back either the shared
 * `LocalWindower` or the memoized daemon connection (`getDaemonClient`),
 * never touching a daemon for a `local` tool.
 */
export type GetBackend = (toolId: McpToolId) => Promise<WindowerBackend>;

export function defaultGetBackend(): GetBackend {
  return async (toolId) => {
    if (MCP_LOCAL_TOOLS.has(toolId)) {
      return getLocalWindower();
    }
    return getDaemonClient();
  };
}
