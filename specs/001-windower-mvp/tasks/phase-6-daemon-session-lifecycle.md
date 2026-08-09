## Phase 6 — Daemon & Session Lifecycle

**Goal:** Build `apps/daemon` — the long-running process that owns session state, spawns/manages sidecar processes, and exposes the non-blocking start/stop model agents need.

- 🔵 Unix domain socket server (`~/.windower/daemon.sock`, `0600` perms) speaking JSON-RPC 2.0, mirroring the operations in `contracts/mcp-tools.md` (`start_recording`, `stop_recording`, `get_session`, `cancel_recording`, `list_sessions`, plus `enumerate`/`resize`/`permissions` pass-throughs).
- 🔵 Session state machine (`pending → recording → stopping → finalized|canceled|failed`) per `data-model.md`, persisted to `~/.windower/sessions/<id>.json` on every transition.
- 🔵 `startCapture` handling: spawn a fresh sidecar process for this session, run the Phase 1 handshake, call `startCapture`, return `sessionId` to the caller **before** waiting for the sidecar's stream to actually begin producing frames (non-blocking per `spec.md` US-05) — but do surface a fast-fail if the sidecar rejects the request synchronously (bad target, permission denied).
- 🔵 `stopCapture` handling: call sidecar `stopCapture`, await `outputFilePath`, write `manifest.json` (Phase 12 owns the full manifest writer, this phase wires the call site), terminate the sidecar process, transition session to `finalized`.
- 🔵 Concurrency policy: reject a second `start` on the exact same `targetId` while one is active (`TARGET_ALREADY_RECORDING`); allow concurrent sessions on different targets.
- 🔵 Crash recovery: on daemon startup, scan `~/.windower/sessions/` for sessions stuck in `recording`/`stopping` from a previous (crashed) daemon instance and mark them `failed` with a clear error, rather than leaving stale state.
- 🔵 Idle shutdown: configurable timeout (`config.daemonIdleTimeoutMs`, default e.g. 30 min) with zero active sessions.
- 🔵 Auto-spawn: a client library helper in `packages/core` that checks if the daemon is reachable and spawns it (detached) if not, used by both CLI and MCP server.

**Exit criteria**

- Matches `spec.md` acceptance item: `start` returns a `sessionId` in under 1s and does not block the caller; `stop <id>` finalizes a valid file; two concurrent sessions on different targets both complete correctly.
- Killing the daemon process mid-recording, then restarting it, results in the orphaned session correctly marked `failed` (not stuck in `recording` forever).
- `list_sessions` after a restart still shows prior sessions (state survives process restart via the on-disk JSON).
- Idle daemon exits on its own after the configured timeout with no active sessions.
