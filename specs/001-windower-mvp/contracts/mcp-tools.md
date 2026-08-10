# MCP Tools Contract

Server: `packages/mcp-server`, stdio transport (SSE optional, not required for MVP). Every tool's input/output schema is the corresponding Zod type from `packages/core` (`data-model.md`) — no bespoke MCP-only shapes. Semantics mirror `contracts/cli.md` 1:1; an agent should get identical results whether it goes through the CLI or MCP.

## Backend routing (Phase 20)

Each tool routes through one of the three backend modes defined by the single policy table in `packages/core/src/daemon/policy.ts` and documented in full in `contracts/daemon-rpc.md`. Per that table: `check_permissions`, `list_targets`, `resize_window`, `get_session`, and `list_sessions` now run **`local`** — a transient, daemon-free sidecar call or direct store read, with no daemon spawned or contacted. `run_operator`, `get_operator_run`, and `abort_operator_run` stay **`daemon`-backed** — see the justification under `run_operator` below. `start_recording`/`stop_recording`/`cancel_recording` also stay `daemon`-backed (split-invocation recording needs a process that outlives the calling tool call). This mirrors `contracts/cli.md`'s Daemon policy section — the routing decision lives in one table, consumed identically by the CLI and MCP server.

## `list_targets`
**Input:** `{ kinds?: ("display"|"window"|"app")[] }`
**Output:** `{ targets: CaptureTarget[] }`
Runs `local` (Phase 20) — a transient sidecar spawn per call, no daemon involved.

## `check_permissions`
**Input:** `{}`
**Output:** `PermissionReport`
Read-only, never prompts. Runs `local` (Phase 20) — a transient sidecar probe plus a non-blocking daemon check, no daemon spawned as a side effect of calling this tool.

**`PermissionReport` additions (Phase 20)** — mirrors the same shape added to `data-model.md`'s `PermissionReport`; all fields below are **optional**, so a response produced by a pre-Phase-20 daemon still parses:
- `daemon?: { running: boolean, pid?: number, version?: string, protocolVersion?: number, startedAt?: string, ageSeconds?: number, socketPath?: string, versionMatchesClient?: boolean }` — identity of the daemon this check probed, read from `~/.windower/daemon.json` without requiring a live connection; `running: false` means no daemon is up, in which case the other `daemon.*` fields are omitted.
- `client?: { name: string, version: string, protocolVersion: number }` — identity of the process serving this tool call (the MCP server), for comparison against `daemon.version`/`daemon.protocolVersion`.
- `sidecar?: { available: boolean, version?: string, resolvedPath?: string, source?: "env-override"|"dev-build"|"npm-package", expectedVersion?: string }` — how the native sidecar binary was resolved and whether its version matches what this build expects.
- `windowerHome?: { path: string, fromEnvOverride: boolean }` — the effective `~/.windower` (or `WINDOWER_HOME`-overridden) directory this check read/wrote against.
- `outputDir?: { path: string, writable: boolean }` — the effective default recording output directory and whether it's writable.
- `activeSessions?: number` — count of sessions currently in a non-terminal state, from the local session store.
- `activeRuns?: number` — count of operator runs currently in a non-terminal state, from the local operator-run store.
- API-key environment variable presence: booleans only, **never values** (e.g. `anthropicApiKeyPresent`, `openaiApiKeyPresent`, `openaiCompatibleApiKeyPresent`, and presence for the configured `apiKeyEnvVar`) — reported separately for the calling process (`client`) and, when a daemon is running, for the daemon's own environment, so a mismatch between "present in the MCP host's env" and "present in the daemon's env" is visible without ever printing a secret. See `data-model.md` for the exact field names once finalized there.

## `request_permission`
**Input:** `{ kind: "screenRecording"|"accessibility"|"microphone" }`
**Output:** `{ status: PermissionStatus }`

## `resize_window`
**Input:** `{ targetId: string, bounds: Rect }`
**Output:** `{ actualBounds: Rect, result: "success"|"partial"|"unsupported" }`
Runs `local` (Phase 20) — a transient sidecar spawn per call, no daemon involved.

## `start_recording`
**Input:** `{ target: CaptureTarget | { targetId: string }, video?: Partial<VideoSettings>, audio?: Partial<AudioSettings>, outputDir?: string }`
**Output:** `{ sessionId: string }`
Returns immediately — does not wait for the recording to finish. This is the key affordance for agents: call this, then perform the on-screen actions to demo, then call `stop_recording`.

## `get_session`
**Input:** `{ sessionId: string }`
**Output:** `RecordingSession`
Runs `local` (Phase 20) — reads the session store directly, no daemon involved.

## `stop_recording`
**Input:** `{ sessionId: string, narration?: { filePath: string, offsetMs: number } }`
**Output:** `{ outputPath: string, manifestPath: string, eventTimelinePath?: string, manifest: OutputManifest }`

## `cancel_recording`
**Input:** `{ sessionId: string }`
**Output:** `{ canceled: true }`

## `list_sessions`
**Input:** `{ state?: SessionState }`
**Output:** `{ sessions: RecordingSession[] }`
Runs `local` (Phase 20) — reads the session store directly, no daemon involved.

## `run_operator`
**Input:** `{ task: string, target: CaptureTarget | { targetId: string }, models?: ModelConfig | { planner: ModelConfig, executor?: ModelConfig }, observe?: "auto"|"ax"|"vision", secrets?: SecretRef[], guardrails?: { maxSteps?: number, timeoutSeconds?: number, maxBatchActions?: number, maxReplans?: number, unbounded?: boolean } }`
**Output:** `{ runId: string }`
Returns immediately — does not wait for the run to finish. Same non-blocking two-call shape as `start_recording`: call this, the operator perceives and acts on its own, then poll `get_operator_run` or wait for completion. Runs `daemon`-backed.

`target` is **the same target selector `start_recording` takes** — the identical type, reused, not an operator-specific parallel shape. It is what the operator perceives (`enumerateElements`/`captureFrame`) and drives, and what its bounds clamp is evaluated against. An orchestrator that wants a recording of the run passes the same selector to both calls; that shared value is the only thing the two capabilities have in common, and neither learns of the other through it.

**`models` (Phase 22 — two tiers, mirrors `windower operate`'s `--model`/`--planner-model`/`--executor-model`).** Accepts either a bare `ModelConfig` — sets both the planner and executor tier to it, byte-identical to the pre-Phase-22 single-model behavior — or an already-tiered `{ planner, executor? }`, where an omitted `executor` defaults to the resolved `planner`. Also optional in full: a caller may omit `models` entirely and rely on `~/.windower/config.json`'s `operator.defaultPlannerModel`/`defaultExecutorModel`/`defaultModel`, resolved daemon-side. The planner produces the plan once from a rich observation; the (optionally cheaper) executor decides each step's action against the current observation and escalates back to the planner when a checkpoint invalidates the plan (`contracts/operator.md` §Model tiers).

**`observe` (Phase 22).** `"auto"` (default) — the operator observes via `enumerateElements` (accessibility elements) by default and falls back to a screenshot only when elements are insufficient (empty/sparse list, `UNSUPPORTED_CAPABILITY`, or a visual checkpoint). `"ax"` — never captures a frame; forces element-only observation (used to verify the zero-frame exit criterion; a target that genuinely needs vision will fail rather than silently degrading). `"vision"` — restores exactly the pre-Phase-22 behavior: always capture a frame, never read elements.

The input above is **exhaustive** — `task`, `target`, model/provider config, observation policy, guardrails/planning config. See `contracts/operator.md` for the canonical `OperatorRunOptions` shape; this tool accepts exactly its members and nothing else.

**Why this stays non-blocking and daemon-backed, unchanged, even though Phase 20 made `windower operate` block by default on the CLI (settled — do not relitigate):**
- **Host timeouts.** MCP hosts impose per-tool-call timeouts far shorter than `DEFAULT_OPERATOR_TIMEOUT_MS`. A blocking `run_operator` would time out at the host well before a real operator run finishes, and the run itself — synthetic input, model calls — would be orphaned server-side with no way for the calling agent to reach it again.
- **Cross-surface visibility.** A run started here must stay visible to `windower operate status` from a terminal, and to a second MCP host attached to the same daemon. That requires a shared, daemon-backed owner of run state — a run living only inside one MCP server process's memory (the shape a blocking call would need) can't satisfy either.
- **Consistency with `start_recording`/`stop_recording`.** The two-call `run_operator`/`get_operator_run` shape deliberately mirrors the existing `start_recording`/`stop_recording` pattern — MCP's blocking-vs-non-blocking story stays uniform across both features rather than diverging just because the CLI's default changed.

The CLI's `windower operate` blocking-by-default change and its `--detach` opt-out (see `contracts/cli.md`) are a CLI-only ergonomics change; they do not alter this tool's contract.

**Recording independence (Phase 21, normative).** `run_operator` is completely unaware of recording. The operator **MUST NOT**:

1. know whether a recording exists;
2. start a recording;
3. stop a recording;
4. look up a recording (by id, by target, or by any other means);
5. route frames through a recording session;
6. carry a recording identifier, including for timeline correlation.

**The same `OperatorRun` MUST behave identically whether the screen is being recorded or not.** A recording is neither an input to nor an output of a run, and `get_operator_run` exposes no field describing one. Symmetrically, `get_session`/`list_sessions` expose **no** field describing an operator run: a `RecordingSession` must not know whether it is recording a human, Windower Operator, Claude Code, Playwright, another agent, or nothing at all (see `data-model.md`'s `RecordingSession` invariant).

**Breaking change (Phase 21) to Phase 19's shipped surface.** `run_operator` previously accepted a `recording` option and started/owned a recording of its own ("standalone mode"); a Phase 21 draft additionally proposed a `sessionId` input pointing a run at an existing session ("attach mode"). **Both are removed** — the tool accepts neither member, and the `sessionId`-vs-`recording` mutual-exclusivity `INVALID_ARGS` rule is moot and deleted rather than kept as a no-op. Rationale: standalone mode required the Operator to start a recording and attach mode required it to hold a recording identifier; each independently violates the prohibitions above, and either one preserves the lifecycle coupling this correction exists to eliminate. Callers relying on the all-in-one call migrate to the orchestrated shape below. Passing `sessionId` or `recording` now fails as an unrecognized member.

**The orchestrated shape.** Recording and Operator are peer capabilities the caller sequences (`spec.md` §1.2):

```
recording = start_recording({ target })
operator  = run_operator({ target, task })
poll get_operator_run(operator.runId) until terminal
stop_recording(recording.sessionId)
```

Both calls take the same `target`. The caller owns the recording end to end — the run never stops or cancels it under **any** outcome (`succeeded`, `failed`, `aborted`, `timed_out`, or a crashed operator loop), because it has no way to name it. The orchestrator holds both ids because it created both; Windower never joins them. This does not alter the non-blocking, `daemon`-backed reasoning above.

Correlating a run's `plan`/`action`/`checkpoint`/`narration`/`result` events with a recording's captured cursor/mouse/keyboard/window events is the **orchestration** plane's job. The daemon MAY do it by wall-clock, in memory, without either capability referencing the other; there is deliberately no persistent `DemoRun`/`WorkflowRun` model.

There is deliberately **no** push/event-stream either — the heavier alternative was evaluated and rejected in Phase 21; polling `get_operator_run` is sufficient.

**Error codes** (in addition to the shared sidecar/daemon taxonomy):
- `OPERATOR_LOOP_CRASHED` — the operator's decision-loop process died unexpectedly. The `OperatorRun` transitions to `failed` with this code. No recording anywhere on the machine is touched, because the run never held one.
- `OPERATOR_BATCH_LIMIT_EXCEEDED` — a turn issued more action tool calls than `guardrails.maxBatchActions` allows. Non-terminal: the over-limit actions are skipped, the step closes, the run continues (see `contracts/operator.md` §Action batching).

## `get_operator_run`
**Input:** `{ runId: string }`
**Output:** `OperatorRun` (includes `steps[]`)

## `abort_operator_run`
**Input:** `{ runId: string }`
**Output:** `{ aborted: true }`

**Why a nested agent is justified here** (rather than expecting the calling harness to drive input itself): the MCP harness invoking these tools may have **no native mouse/keyboard/screenshot tool at all** — `run_operator` gives it one, mediated entirely through the sidecar's `performInput`/`captureFrame`. And the operator's underlying model is **chosen by the user** (`ModelConfig`, provider-swappable via the Vercel AI SDK), independent of and often different from whatever model is powering the calling/orchestrating agent — e.g. Claude Code driving `run_operator`, which in turn drives its own separately-configured model against the task. Nesting an agent inside a tool call is normally a smell; here it's the point.

## `shutdown` — daemon-only, not an MCP tool

**Added in Phase 7 (CLI)** to back `windower daemon stop` (contracts/cli.md). This is a **daemon RPC method** (`packages/core/src/daemon/methods.ts`, dispatched in `apps/daemon/src/server.ts`), not exposed through the MCP server — agents have no legitimate reason to shut the daemon down mid-session, so it is intentionally absent from `packages/mcp-server`'s tool list.

**Input:** `{ mode?: "graceful" | "immediate" }` (default `"graceful"`)
**Output:** `{ shuttingDown: true }`

Responds first, then shuts the daemon process down. Before this addition there was no way to cleanly stop a running daemon over the wire (only `SIGTERM`, unreachable from a plain RPC client) — `contracts/cli.md`'s `daemon status|stop` explicitly calls for lifecycle control from the CLI, so the protocol was extended rather than the CLI reaching around it (per repo `CLAUDE.md` — "protocol before platform").

**`mode` (Phase 20):**
- `"graceful"` (default) — stop accepting new connections, abort active operator runs (each transitions to `aborted` and is persisted; no recording is touched, since a run never owns one), `stopRecording` every session still in `recording` so video, manifest, and `.events.json` all land, then close the socket, unlink `~/.windower/daemon.json`, and exit. Bounded to roughly 30s; if it doesn't complete in time it escalates to `immediate`.
- `"immediate"` — closes the socket and exits without waiting for in-flight sessions or operator runs to finalize. Matches the pre-Phase-20 behavior of `shutdown`; capture processes for any still-`recording` session are left orphaned and the next daemon start rewrites those sessions to `failed`, same as before. Use only when graceful shutdown has already failed or is known to be unsafe to wait for.

Full lifecycle semantics (lockfile, `hello` version handshake, `DAEMON_BUSY`) are specified in `contracts/daemon-rpc.md`.

## Tool descriptions (as surfaced to the model)

Each tool's MCP `description` field is written to be self-sufficient for an agent that has never seen `SKILL.md` — e.g. `start_recording`'s description explicitly states "returns immediately; call stop_recording when done; perform your on-screen actions in between." This matters because an agent might reach the MCP server directly without the Claude Code plugin's skill instructions loaded (e.g., a different MCP host). The Claude Code `SKILL.md` (Phase 9) adds workflow guidance and recipes on top but the tools must be usable standalone.
