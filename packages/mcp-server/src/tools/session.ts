/**
 * Session-lifecycle MCP tools: `start_recording`, `get_session`,
 * `stop_recording`, `cancel_recording`, `list_sessions` (contracts/mcp-tools.md).
 *
 * Backend routing (Phase 20): `get_session`/`list_sessions` run `local`
 * (a direct session-store read, no daemon involved); `start_recording`/
 * `stop_recording`/`cancel_recording` stay `daemon`-backed — split-invocation
 * recording needs a process that outlives the calling tool call. Input/
 * output are validated by the exact Zod schemas `@windower/core` exports, so
 * MCP results are schema-identical to the CLI's `--json` output.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CancelRecordingParamsSchema,
  CancelRecordingResultSchema,
  GetSessionParamsSchema,
  GetSessionResultSchema,
  ListSessionsParamsSchema,
  ListSessionsResultSchema,
  StartRecordingParamsSchema,
  StartRecordingResultSchema,
  StopRecordingParamsSchema,
  StopRecordingResultSchema,
} from "@windower/core";
import type { GetBackend } from "../backend.js";
import { toMcpError } from "../daemon-client.js";

export function registerSessionTools(server: McpServer, getBackend: GetBackend): void {
  server.registerTool(
    "start_recording",
    {
      title: "Start a recording (non-blocking, two-call pattern)",
      description:
        "Starts recording the given `target` (a `CaptureTarget` from `list_targets`, or " +
        "`{ targetId }`) and returns IMMEDIATELY with `{ sessionId }` — it does NOT wait for " +
        "the recording to finish. This is the single most important thing to understand about " +
        "this tool: it is the FIRST call of a two-call pattern. After calling `start_recording`, " +
        "perform the on-screen actions you want captured (click, type, navigate, etc.), and only " +
        "THEN call `stop_recording` with the returned `sessionId` to finalize the file. Do not " +
        "expect this call to block until recording ends — there is no such blocking variant here. " +
        "Optionally override `video`/`audio` settings (partial overrides of `VideoSettings`/" +
        "`AudioSettings`) and `outputDir` (defaults to the daemon's configured output directory). " +
        "Use `check_permissions` beforehand to fail fast on missing Screen Recording/Microphone " +
        "grants rather than getting a confusing capture error here.",
      inputSchema: StartRecordingParamsSchema,
      outputSchema: StartRecordingResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("start_recording");
        const result = await backend.startRecording(params);
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
    "get_session",
    {
      title: "Get recording session status",
      description:
        "Looks up the current status of a recording session by `sessionId` (as returned by " +
        "`start_recording`). Returns the full `RecordingSession` record — including its " +
        "lifecycle state (e.g. recording/stopping/completed/canceled/failed), target, and " +
        "timing info. Useful for polling progress or confirming a session is still active " +
        "before calling `stop_recording` or `cancel_recording`.",
      inputSchema: GetSessionParamsSchema,
      outputSchema: GetSessionResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("get_session");
        const result = await backend.getSession(params);
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
    "stop_recording",
    {
      title: "Stop a recording and finalize output",
      description:
        "Stops the recording session identified by `sessionId` (from `start_recording`) and " +
        "finalizes its output. This is the SECOND call of the two-call recording pattern: call " +
        "`start_recording`, perform the on-screen actions to demo, then call this. Optionally " +
        "attach `narration` (a pre-recorded audio file plus its `offsetMs` start offset within " +
        "the recording) to mux in. Returns the final `outputPath` (video file), `manifestPath`, " +
        "an optional `eventTimelinePath`, and the full `OutputManifest`.",
      inputSchema: StopRecordingParamsSchema,
      outputSchema: StopRecordingResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("stop_recording");
        const result = await backend.stopRecording(params);
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
    "cancel_recording",
    {
      title: "Cancel a recording without saving output",
      description:
        "Cancels the recording session identified by `sessionId` and discards any in-progress " +
        "output — use this instead of `stop_recording` when the demo went wrong and you don't " +
        "want the partial capture saved. Returns `{ canceled: true }` on success.",
      inputSchema: CancelRecordingParamsSchema,
      outputSchema: CancelRecordingResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("cancel_recording");
        const result = await backend.cancelRecording(params);
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
    "list_sessions",
    {
      title: "List recording sessions",
      description:
        "Lists recording sessions known to the daemon, optionally filtered by `state` (e.g. " +
        "recording/stopping/completed/canceled/failed). Useful for finding a `sessionId` you've " +
        "lost track of, or auditing recent recordings across a daemon restart (session state is " +
        "disk-persisted).",
      inputSchema: ListSessionsParamsSchema,
      outputSchema: ListSessionsResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("list_sessions");
        const result = await backend.listSessions(params);
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
