# MCP Tools Contract

Server: `packages/mcp-server`, stdio transport (SSE optional, not required for MVP). Every tool's input/output schema is the corresponding Zod type from `packages/core` (`data-model.md`) — no bespoke MCP-only shapes. Semantics mirror `contracts/cli.md` 1:1; an agent should get identical results whether it goes through the CLI or MCP.

## Backend routing (Phase 20)

Each tool routes through one of the three backend modes defined by the single policy table in `packages/core/src/daemon/policy.ts` and documented in full in `contracts/daemon-rpc.md`. Per that table: `check_permissions`, `list_targets`, `resize_window`, `get_session`, and `list_sessions` now run **`local`** — a transient, daemon-free sidecar call or direct store read, with no daemon spawned or contacted. `start_recording`/`stop_recording`/`cancel_recording` stay `daemon`-backed (split-invocation recording needs a process that outlives the calling tool call). This mirrors `contracts/cli.md`'s Daemon policy section — the routing decision lives in one table, consumed identically by the CLI and MCP server.

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

## `shutdown` — daemon-only, not an MCP tool

**Added in Phase 7 (CLI)** to back `windower daemon stop` (contracts/cli.md). This is a **daemon RPC method** (`packages/core/src/daemon/methods.ts`, dispatched in `apps/daemon/src/server.ts`), not exposed through the MCP server — agents have no legitimate reason to shut the daemon down mid-session, so it is intentionally absent from `packages/mcp-server`'s tool list.

**Input:** `{ mode?: "graceful" | "immediate" }` (default `"graceful"`)
**Output:** `{ shuttingDown: true }`

Responds first, then shuts the daemon process down. Before this addition there was no way to cleanly stop a running daemon over the wire (only `SIGTERM`, unreachable from a plain RPC client) — `contracts/cli.md`'s `daemon status|stop` explicitly calls for lifecycle control from the CLI, so the protocol was extended rather than the CLI reaching around it (per repo `CLAUDE.md` — "protocol before platform").

**`mode` (Phase 20):**
- `"graceful"` (default) — stop accepting new connections, `stopRecording` every session still in `recording` so video, manifest, and `.events.json` all land, then close the socket, unlink `~/.windower/daemon.json`, and exit. Bounded to roughly 30s; if it doesn't complete in time it escalates to `immediate`.
- `"immediate"` — closes the socket and exits without waiting for in-flight sessions to finalize. Matches the pre-Phase-20 behavior of `shutdown`; capture processes for any still-`recording` session are left orphaned and the next daemon start rewrites those sessions to `failed`, same as before. Use only when graceful shutdown has already failed or is known to be unsafe to wait for.

Full lifecycle semantics (lockfile, `hello` version handshake, `DAEMON_BUSY`) are specified in `contracts/daemon-rpc.md`.

## Tool descriptions (as surfaced to the model)

Each tool's MCP `description` field is written to be self-sufficient for an agent that has never seen `SKILL.md` — e.g. `start_recording`'s description explicitly states "returns immediately; call stop_recording when done; perform your on-screen actions in between." This matters because an agent might reach the MCP server directly without the Claude Code plugin's skill instructions loaded (e.g., a different MCP host). The Claude Code `SKILL.md` (Phase 9) adds workflow guidance and recipes on top but the tools must be usable standalone.
