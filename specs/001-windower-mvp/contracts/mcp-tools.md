# MCP Tools Contract

Server: `packages/mcp-server`, stdio transport (SSE optional, not required for MVP). Every tool's input/output schema is the corresponding Zod type from `packages/core` (`data-model.md`) — no bespoke MCP-only shapes. Semantics mirror `contracts/cli.md` 1:1; an agent should get identical results whether it goes through the CLI or MCP.

## `list_targets`
**Input:** `{ kinds?: ("display"|"window"|"app")[] }`
**Output:** `{ targets: CaptureTarget[] }`

## `check_permissions`
**Input:** `{}`
**Output:** `PermissionReport`
Read-only, never prompts.

## `request_permission`
**Input:** `{ kind: "screenRecording"|"accessibility"|"microphone" }`
**Output:** `{ status: PermissionStatus }`

## `resize_window`
**Input:** `{ targetId: string, bounds: Rect }`
**Output:** `{ actualBounds: Rect, result: "success"|"partial"|"unsupported" }`

## `start_recording`
**Input:** `{ target: CaptureTarget | { targetId: string }, video?: Partial<VideoSettings>, audio?: Partial<AudioSettings>, outputDir?: string }`
**Output:** `{ sessionId: string }`
Returns immediately — does not wait for the recording to finish. This is the key affordance for agents: call this, then perform the on-screen actions to demo, then call `stop_recording`.

## `get_session`
**Input:** `{ sessionId: string }`
**Output:** `RecordingSession`

## `stop_recording`
**Input:** `{ sessionId: string, narration?: { filePath: string, offsetMs: number } }`
**Output:** `{ outputPath: string, manifestPath: string, eventTimelinePath?: string, manifest: OutputManifest }`

## `cancel_recording`
**Input:** `{ sessionId: string }`
**Output:** `{ canceled: true }`

## `list_sessions`
**Input:** `{ state?: SessionState }`
**Output:** `{ sessions: RecordingSession[] }`

## `run_operator`
**Input:** `{ task: string, model: ModelConfig, recording?: { video?: Partial<VideoSettings>, audio?: Partial<AudioSettings>, outputDir?: string, disabled?: boolean }, secrets?: SecretRef[], guardrails?: { maxSteps?: number, timeoutSeconds?: number, unbounded?: boolean } }`
**Output:** `{ runId: string }`
Returns immediately — does not wait for the run to finish. Same non-blocking two-call shape as `start_recording`: call this, the operator perceives/acts/records on its own, then poll `get_operator_run` or wait for completion.

## `get_operator_run`
**Input:** `{ runId: string }`
**Output:** `OperatorRun` (includes `steps[]`)

## `abort_operator_run`
**Input:** `{ runId: string }`
**Output:** `{ aborted: true }`

**Why a nested agent is justified here** (rather than expecting the calling harness to drive input itself): the MCP harness invoking these tools may have **no native mouse/keyboard/screenshot tool at all** — `run_operator` gives it one, mediated entirely through the sidecar's `performInput`/`captureFrame`. And the operator's underlying model is **chosen by the user** (`ModelConfig`, provider-swappable via the Vercel AI SDK), independent of and often different from whatever model is powering the calling/orchestrating agent — e.g. Claude Code driving `run_operator`, which in turn drives its own separately-configured model against the task. Nesting an agent inside a tool call is normally a smell; here it's the point.

## `shutdown` — daemon-only, not an MCP tool

**Added in Phase 7 (CLI)** to back `windower daemon stop` (contracts/cli.md). This is a **daemon RPC method** (`packages/core/src/daemon/methods.ts`, dispatched in `apps/daemon/src/server.ts`), not exposed through the MCP server — agents have no legitimate reason to shut the daemon down mid-session, so it is intentionally absent from `packages/mcp-server`'s tool list.

**Input:** `{}`
**Output:** `{ shuttingDown: true }`

Responds first, then closes the socket and exits the daemon process. Before this addition there was no way to cleanly stop a running daemon over the wire (only `SIGTERM`, unreachable from a plain RPC client) — `contracts/cli.md`'s `daemon status|stop` explicitly calls for lifecycle control from the CLI, so the protocol was extended rather than the CLI reaching around it (per repo `CLAUDE.md` — "protocol before platform").

## Tool descriptions (as surfaced to the model)

Each tool's MCP `description` field is written to be self-sufficient for an agent that has never seen `SKILL.md` — e.g. `start_recording`'s description explicitly states "returns immediately; call stop_recording when done; perform your on-screen actions in between." This matters because an agent might reach the MCP server directly without the Claude Code plugin's skill instructions loaded (e.g., a different MCP host). The Claude Code `SKILL.md` (Phase 9) adds workflow guidance and recipes on top but the tools must be usable standalone.
