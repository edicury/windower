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

## Tool descriptions (as surfaced to the model)

Each tool's MCP `description` field is written to be self-sufficient for an agent that has never seen `SKILL.md` — e.g. `start_recording`'s description explicitly states "returns immediately; call stop_recording when done; perform your on-screen actions in between." This matters because an agent might reach the MCP server directly without the Claude Code plugin's skill instructions loaded (e.g., a different MCP host). The Claude Code `SKILL.md` (Phase 9) adds workflow guidance and recipes on top but the tools must be usable standalone.
