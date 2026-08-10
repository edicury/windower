/**
 * Operator MCP tools: `run_operator`, `get_operator_run`, `abort_operator_run`
 * (contracts/mcp-tools.md §run_operator/§get_operator_run/§abort_operator_run).
 *
 * Thin wrappers over `DaemonClient` — the same `@windower/core` client the
 * CLI's `windower operate` uses — with input/output validated by the exact
 * Zod schemas `@windower/core` exports, so these results are schema-identical
 * to `windower operate --json`.
 *
 * `list_operator_runs` exists as a daemon RPC (backing `windower operate
 * list`) but is deliberately NOT exposed here: contracts/mcp-tools.md lists
 * exactly three operator tools.
 *
 * The descriptions below intentionally restate the guidance in
 * `plugins/claude-code/SKILL.md`, because an agent may reach this server with
 * no skill loaded (contracts/mcp-tools.md §"Tool descriptions").
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AbortOperatorRunParamsSchema,
  AbortOperatorRunResultSchema,
  type DaemonClient,
  type DaemonHelloEnv,
  GetOperatorRunParamsSchema,
  GetOperatorRunResultSchema,
  RunOperatorParamsSchema,
  RunOperatorResultSchema,
} from "@windower/core";
import type { GetBackend } from "../backend.js";
import { connectForOperatorRun, toMcpError } from "../daemon-client.js";
import { buildOperatorHelloEnv } from "../operator-env.js";

/**
 * Injectable so tests can fake the env-scoped `run_operator` connection
 * without spawning/connecting a real daemon — production callers omit this
 * and get the real `connectForOperatorRun` (`../daemon-client.js`).
 */
export type ConnectForOperatorRun = (env: DaemonHelloEnv | undefined) => Promise<DaemonClient>;

export function registerOperatorTools(
  server: McpServer,
  getBackend: GetBackend,
  connectForRun: ConnectForOperatorRun = connectForOperatorRun,
): void {
  server.registerTool(
    "run_operator",
    {
      title: "Delegate a task to Windower's operator (fallback, non-blocking)",
      description:
        "Hands ONE natural-language `task` to Windower's own operator agent, which perceives the " +
        "`target` you give it and drives real mouse/keyboard input against it. Returns " +
        "IMMEDIATELY with `{ runId }` — it does NOT wait for the run to finish; poll " +
        "`get_operator_run` for `state` and the step transcript, and use `abort_operator_run` to " +
        "stop a run that has gone wrong.\n\n" +
        "THE OPERATOR RECORDS NOTHING. It is a peer capability alongside recording, not a " +
        "recorder: it never starts, stops, or looks up a recording, and it behaves identically " +
        "whether or not the screen is being recorded. YOU are the orchestrator. If you want video " +
        "of a run, you issue the calls yourself, in this order: `start_recording(target)` → " +
        "`run_operator(target, task)` → poll `get_operator_run` until `state` is terminal → " +
        "optionally allow a short settle period → `stop_recording(sessionId)`. The two calls share " +
        "only the `target` value; nothing links them, and stopping the recording is always your " +
        "job, including when the run fails, times out, or is aborted.\n\n" +
        "NOT the default. The default remains the two-call `start_recording` → do the on-screen " +
        "actions with YOUR OWN tools (e.g. your browser tool) → `stop_recording` flow: you " +
        "understand the user's intent, so you drive and Windower records. Reach for `run_operator` " +
        "only when (a) the UI is something you have no tool for — a native/desktop app, a system " +
        "dialog, a preferences pane, an installer, a menu bar item — or (b) the user gave you a " +
        "single instruction to be executed end-to-end and decomposing it would add " +
        "nothing. Keep driving it yourself when the demo is in a browser you can reach, when you " +
        "need to interleave shell/file/API work with the on-screen steps, or when the user wants " +
        "to review each step (there is no per-step approval surface).\n\n" +
        "`target` is the SAME target selector `start_recording` takes — a `CaptureTarget` or " +
        "`{ targetId }` from `list_targets`. It is the operator's own target: it is what the " +
        "operator observes and drives, and what its coordinate clamp is evaluated against.\n\n" +
        "By default the operator OBSERVES via accessibility elements (exact rects for buttons, " +
        "fields, links, etc.) rather than a screenshot, and falls back to a screenshot only when " +
        "elements are absent/insufficient or a checkpoint needs a visual check. Pass " +
        '`observe: "vision"` to force screenshot-only observation (e.g. canvas/WebGL-heavy UI), ' +
        'or `observe: "ax"` to require element-only observation.\n\n' +
        "`models` selects the operator's OWN model(s) — independent of whatever model is running " +
        "you. Pass a single `{ provider, model, baseUrl?, apiKeyEnvVar? }` (e.g. " +
        "anthropic:claude-sonnet-5, openai:gpt-5, or openai-compatible + `baseUrl` for a local " +
        "server) to use one model for everything, or `{ planner, executor? }` to split the work: " +
        "a strong `planner` model writes the plan once, and a cheaper `executor` model (worth " +
        "configuring — it decides each step's action against an already-labeled element list, " +
        "which is close to mechanical) executes it and only hands control back to the planner when " +
        "a checkpoint fails. Omitting `executor` uses the planner for both. API keys come from the " +
        "environment; never pass one in these arguments — a run with two different providers needs " +
        "both providers' env vars present in this server's own environment.\n\n" +
        "SECRETS: never put a password/token in `task`. Pass `secrets: [{ name, source: " +
        '"env"|"keychain"|"literal", ref }]` and refer to it in the task as `{{name}}`. The ' +
        "operator's model only ever sees the `{{name}}` placeholder — the real value is resolved " +
        "and substituted immediately before the input is typed, and a redaction filter scrubs the " +
        'transcript, logs, and event timeline before anything is written. `"literal"` is ' +
        "discouraged (shell/argument exposure); prefer env or keychain.\n\n" +
        "GUARDRAILS are enforced by the runtime, not requested in a prompt: `maxSteps` (default " +
        "40), wall-clock `timeoutSeconds` (default 300), `maxBatchActions` (default 8), `maxReplans` " +
        "(default 3 — how many times the executor may hand a stalled plan back to the planner " +
        "before the run gives up rather than burning its whole step budget), a clamp of every " +
        "coordinate to the run's OWN target's bounds unless `unbounded` is set, and abort. " +
        "Hitting one ends the run as `failed` with a structured error — report that plainly rather " +
        "than retrying blindly. The operator's tool surface is closed: element/screenshot " +
        "observation, mouse, keyboard, wait, list targets, resize window, done/fail. It has no shell, filesystem, or " +
        "network tool.\n\n" +
        "The run's only artifact is its own transcript, in operator-owned storage at " +
        "`~/.windower/operator-runs/<runId>/transcript.json` (frames alongside it). There is no " +
        "video, manifest, or event timeline from a run — those come from the recording YOU start " +
        'and stop around it, and synthetic input is tagged `source: "operator"` in that ' +
        "timeline if one is running.",
      inputSchema: RunOperatorParamsSchema,
      outputSchema: RunOperatorResultSchema,
    },
    async (params) => {
      // `run_operator` gets its own connection, per call, rather than
      // `getBackend`'s memoized daemon client — see `connectForOperatorRun`'s
      // doc for why: this call's `hello` must carry THIS call's scoped
      // API-key/`env:`-secret snapshot (sourced from this MCP server
      // process's own environment — i.e. the `mcpServers.<name>.env` block
      // the user configured in their MCP host), and a memoized connection's
      // `hello` may have already fired for a different (or no) model.
      let client: DaemonClient | undefined;
      try {
        const env = buildOperatorHelloEnv(params);
        client = await connectForRun(env);
        const result = await client.runOperator(params);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toMcpError(err);
      } finally {
        // The run itself continues server-side once accepted — only this
        // short-lived calling connection is torn down here.
        client?.dispose();
      }
    },
  );

  server.registerTool(
    "get_operator_run",
    {
      title: "Get operator run status and step transcript",
      description:
        "Looks up an operator run by `runId` (as returned by `run_operator`) and returns the full " +
        "`OperatorRun` record: `state` (pending/running/succeeded/failed/aborted/timed_out), the " +
        "resolved `target` the run drives, the `steps[]` transcript of what the operator saw and " +
        "did, timings, `transcriptPath`, the run's own `summary` of what it accomplished or why it " +
        "stopped (present once the run reports a terminal result; absent if it crashed without " +
        "reporting one), and a structured `error` when the run " +
        "failed (including guardrail violations such as the step cap, the wall-clock timeout, or " +
        "an out-of-bounds coordinate). This is the polling half of `run_operator`'s non-blocking " +
        "two-call shape, and the ONLY way to learn a run has finished — a run carries no recording " +
        "or session identifier, and nothing about it surfaces through `get_session`. Poll this " +
        "until `state` is terminal, then stop whatever recording you started yourself. Secret " +
        "values never appear here — tool-call arguments are already redacted to `{{name}}` " +
        "placeholders.",
      inputSchema: GetOperatorRunParamsSchema,
      outputSchema: GetOperatorRunResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("get_operator_run");
        const result = await backend.getOperatorRun(params);
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
    "abort_operator_run",
    {
      title: "Abort an in-progress operator run (kill switch)",
      description:
        "Stops the operator run identified by `runId` mid-flight — the runtime kill switch for a " +
        "run that is doing the wrong thing, stuck, or no longer wanted. It affects the run and " +
        "NOTHING else: a recording you started keeps recording, untouched, until you call " +
        "`stop_recording` yourself, so the partial video and its transcript are both still " +
        "written. Returns `{ aborted: true }`. Aborting an already-finished run reports the run is " +
        "not abortable rather than silently succeeding.",
      inputSchema: AbortOperatorRunParamsSchema,
      outputSchema: AbortOperatorRunResultSchema,
    },
    async (params) => {
      try {
        const backend = await getBackend("abort_operator_run");
        const result = await backend.abortOperatorRun(params);
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
