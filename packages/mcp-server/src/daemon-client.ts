/**
 * Daemon connection + error-mapping helpers shared by every MCP tool file.
 *
 * Unlike the CLI's `withDaemon` (packages/cli/src/daemon.ts) — which opens a
 * connection, runs one command, and disposes — an MCP server is long-lived:
 * a single stdio process may serve many tool calls across an entire agent
 * session. We memoize one `DaemonClient` for the process lifetime instead of
 * reconnecting (or disposing) per call.
 */
import { type DaemonClient, DaemonError, ensureDaemonRunning } from "@windower/core";
import { ZodError } from "zod";

let clientPromise: Promise<DaemonClient> | undefined;

/**
 * Returns the process-wide `DaemonClient`, connecting (and auto-spawning the
 * daemon if needed) on first call. Subsequent calls reuse the same
 * connection. If a previous connection attempt failed, the next call retries
 * rather than replaying the rejection forever.
 */
export function getDaemonClient(): Promise<DaemonClient> {
  if (!clientPromise) {
    clientPromise = ensureDaemonRunning().catch((err) => {
      // Allow a later call to retry instead of being stuck on one failure
      // for the rest of the process lifetime.
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

/** Test-only hook to reset the memoized client between test cases. */
export function resetDaemonClientForTests(): void {
  clientPromise = undefined;
}

export interface McpToolErrorResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

/**
 * Maps any error thrown/rejected inside a tool handler to the MCP SDK's
 * tool error-result shape: `{ content: [...], isError: true }`. Per the SDK
 * convention, tool-level failures are reported this way (not as a
 * JSON-RPC-level error) so the calling model can see and react to them.
 */
export function toMcpError(err: unknown): McpToolErrorResult {
  if (err instanceof DaemonError) {
    return {
      content: [{ type: "text", text: `[${err.code}] ${err.message}` }],
      isError: true,
    };
  }
  if (err instanceof ZodError) {
    return {
      content: [{ type: "text", text: `[INVALID_ARGS] ${err.message}` }],
      isError: true,
    };
  }
  if (err instanceof Error) {
    return {
      content: [{ type: "text", text: `[INTERNAL_ERROR] ${err.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `[INTERNAL_ERROR] ${String(err)}` }],
    isError: true,
  };
}
