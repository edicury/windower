/**
 * Read/control MCP tools that don't manage a recording session's lifecycle:
 * `list_targets`, `check_permissions`, `request_permission`, `resize_window`
 * (contracts/mcp-tools.md). All four run `local` (Phase 20) — a transient,
 * daemon-free sidecar spawn via the shared `LocalWindower`, never a daemon
 * connection — with input/output validated by the exact Zod schemas
 * `@windower/core` exports, so MCP results are schema-identical to the
 * CLI's `--json` output.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CheckPermissionsParamsSchema,
  CheckPermissionsResultSchema,
  DaemonRequestPermissionParamsSchema,
  DaemonRequestPermissionResultSchema,
  DaemonResizeWindowParamsSchema,
  DaemonResizeWindowResultSchema,
  ListTargetsParamsSchema,
  ListTargetsResultSchema,
} from "@windower/core";
import type { GetBackend } from "../backend.js";
import { toMcpError } from "../daemon-client.js";

export function registerReadTools(server: McpServer, getBackend: GetBackend): void {
  server.registerTool(
    "list_targets",
    {
      title: "List capture targets",
      description:
        "Lists the displays, windows, and running apps currently available to record. " +
        "Call this first to discover valid `targetId` values before `resize_window` or " +
        '`start_recording`. Optionally filter by `kinds` ("display" | "window" | "app"). ' +
        "Read-only, never prompts for permission, but returns fewer/partial results if " +
        "Screen Recording permission is not granted (see `check_permissions`).",
      inputSchema: ListTargetsParamsSchema,
      outputSchema: ListTargetsResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("list_targets");
        const result = await backend.listTargets(params);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    "check_permissions",
    {
      title: "Check OS permissions and daemon health",
      description:
        "Reports the current status of every OS permission Windower needs (Screen Recording, " +
        "Accessibility, Microphone) plus whether the daemon and native capture sidecar are " +
        'reachable. Each permission\'s status is one of "granted" | "denied" | ' +
        '"not_determined" | "not_applicable". This is read-only and NEVER triggers an OS ' +
        "permission dialog — use `request_permission` for that. Call this before " +
        "`start_recording` to fail fast with a clear diagnosis instead of a confusing capture error.",
      inputSchema: CheckPermissionsParamsSchema,
      outputSchema: CheckPermissionsResultSchema,
    },
    async () => {
      try {
        const backend = await getBackend("check_permissions");
        const result = await backend.checkPermissions();
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    "request_permission",
    {
      title: "Request an OS permission",
      description:
        "Explicitly triggers the native macOS permission dialog for one capability: " +
        '"screenRecording" | "accessibility" | "microphone". THIS IS USER-INTERACTIVE AND ' +
        "BLOCKING: it shows a system dialog and waits on the user's response (or on the OS's " +
        "already-recorded decision), so only call it when you specifically need to prompt the " +
        "user for a permission — never as part of a routine status check (use " +
        "`check_permissions` for that, which never prompts). Returns the resulting " +
        '`status` ("granted" | "denied" | "not_determined" | "not_applicable").',
      inputSchema: DaemonRequestPermissionParamsSchema,
      outputSchema: DaemonRequestPermissionResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("request_permission");
        const result = await backend.requestPermission(params);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    "resize_window",
    {
      title: "Resize/reposition a window",
      description:
        "Resizes and/or repositions a window target (by `targetId`, from `list_targets`) to " +
        "the given pixel `bounds` ({ x, y, width, height }) before recording, so the capture " +
        "has deterministic geometry. Returns `actualBounds` (what the window ended up at — may " +
        "differ from the request, e.g. due to OS minimum-size constraints) and `result`: " +
        '"success" (bounds applied as requested), "partial" (window was resized/moved but ' +
        'not to the exact requested bounds), or "unsupported" (this window/app does not allow ' +
        "programmatic resize — proceed with its current bounds instead of retrying).",
      inputSchema: DaemonResizeWindowParamsSchema,
      outputSchema: DaemonResizeWindowResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("resize_window");
        const result = await backend.resizeWindow(params);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}
