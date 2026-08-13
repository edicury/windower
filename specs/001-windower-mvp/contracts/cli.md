# CLI Contract

Binary name: `windower`. Every command supports `--json` for machine-readable output (agent-preferred); without it, output is human-readable text. Exit code `0` on success, non-zero with a `{ error: { code, message } }` JSON body (or matching text) on failure — codes match the sidecar error taxonomy in `contracts/sidecar-protocol.md` plus daemon-level ones (`DAEMON_UNREACHABLE`, `INVALID_ARGS`).

## Daemon policy

Windower is **daemon-optional**, not daemon-first. Every command resolves to exactly one of three backend modes, and the mapping is fixed — no command decides at runtime whether to use a daemon:

| Mode | Meaning |
|---|---|
| `local` | Runs entirely in the invoking CLI process (or a one-shot transient sidecar spawn for that single call). No daemon is started, contacted, or required. |
| `daemon` | Auto-starts a daemon if none is listening (subject to the version handshake and spawn lock — see `contracts/daemon-rpc.md`), then talks to it over the unix socket. |
| `attach` | Connects to a daemon **only if one is already listening**; never spawns. If nothing is listening, falls back to a local, best-effort resolution (e.g. marking an orphaned session `failed`/`canceled`) rather than starting a fresh daemon that can't actually know about the session. |

| Command | Mode |
|---|---|
| `record` | `local` |
| `targets` | `local` |
| `doctor` | `local` |
| `permission request` | `local` |
| `resize` | `local` |
| `status` | `local` |
| `list` | `local` |
| `config get`/`config set` | `local` |
| `start` | `daemon` |
| `stop` | `attach` |
| `cancel` | `attach` |
| `daemon status` | `attach` |
| `daemon stop` | `attach` |
| `daemon restart` | `attach` (must find a live daemon to restart; refuses if none is running) |
| `daemon kill` | none of the three — never opens the socket at all; reads `~/.windower/daemon.json`/`sidecar-pids.json` directly and force-kills by OS pid. Documented as `local` in the policy table purely for test-completeness bookkeeping (see `packages/core/src/daemon/policy.ts`); the real command bypasses `withBackend`/`acquireBackend` entirely. |

Every registered command has an explicit entry in this table (enforced by a test in `packages/cli`) — a new command can never silently default to the wrong mode.

Two debugging escape hatches override the table above for any command: the global flags `--daemon` / `--no-daemon`, and the environment variable `WINDOWER_BACKEND=local|daemon`. These force a command that would otherwise resolve to `local` to go through the daemon, or vice versa — useful for reproducing daemon-specific bugs or working around a local-mode issue. `attach`-mode commands (`stop`, `cancel`, `daemon status`, `daemon stop`, `daemon restart`) are unaffected by these flags, since attaching to (rather than spawning) an existing daemon is inherent to their correctness.

## `windower targets [--kind display|window|app] [--json]`
Lists current `CaptureTarget`s. Agents use this first to discover what's on screen.

## `windower doctor [--json]`
Runs `PermissionReport` + an expanded daemon/sidecar/environment health check. Never triggers a permission prompt — read-only. Runs entirely `local`: it spawns its own transient sidecar to probe capabilities and **probes** the daemon (connects if one happens to be listening) without ever spawning one itself.

Report shape:
- `daemon`: `{ running, pid, version, protocolVersion, startedAt, ageSeconds, socketPath, versionMatchesClient }` — `running: false` and the rest `null`/omitted when nothing is listening.
- `client`: `{ name, version, protocolVersion }` — identity of the `doctor` process itself, so a mismatch against `daemon.protocolVersion`/`daemon.version` is visible in one line without printing anything sensitive.
- `sidecar`: `{ available, version, resolvedPath, source: "env-override"|"dev-build"|"npm-package", expectedVersion }`.
- `windowerHome`: `{ path, fromEnvOverride }`.
- `outputDir`: `{ path, writable }`.
- `activeSessions`: counts (or ids) of in-flight recordings, sourced from the daemon when reachable and from disk-persisted state otherwise.

## `windower permission request <screenRecording|accessibility|microphone>`
Explicitly triggers the OS permission prompt for one capability. Separate from `doctor` so agents don't accidentally spam prompts while just checking status.

## `windower resize --window <id> --width <px> --height <px> [--x <px>] [--y <px>] [--json]`
Resizes/repositions a window before recording. Returns `actualBounds` and `result: success|partial|unsupported`.

## `windower start --target <id> [--kind window|display|region] [--region x,y,w,h] [video/audio flags below] [--json]`
Starts a session in the background daemon (auto-starting one if needed — see Daemon policy above), returns immediately with `{ sessionId }`. Does not block.

Shared video/audio flags (also used by `record`, below):
```
--fps 24|30|60                  (default 30)
--codec h264|hevc               (default h264)
--container mp4|mov             (default mp4)
--resolution WxH                (default: target's native resolution)
--quality low|medium|high|lossless_ish  (default high)
--no-cursor                     (default: cursor shown)
--audio-system                  (default: off)
--audio-mic [--mic-device <id>] (default: off)
--separate-tracks               (default: on when >1 audio source)
--out <dir>                     (default: configured output folder)
```

## `windower status <sessionId> [--json]`
Returns the current `RecordingSession` — state, elapsed time, target.

## `windower stop <sessionId> [--narration <file> --narration-offset <ms>] [--json]`
Finalizes the recording. Returns `outputPath`, `manifestPath`, `eventTimelinePath`. `attach` mode: connects only to a daemon already listening. Because `start` always spawns a daemon, a session in `recording` state always has a live owner unless that daemon has since died — if nothing is listening at `stop` time, the local fallback marks the session `failed`/`canceled` with a clear message instead of spawning a fresh daemon that would just answer `SESSION_NOT_FOUND`.

## `windower cancel <sessionId> [--json]`
Discards an in-progress recording — no output file produced. `attach` mode, with the same dead-owner fallback behavior as `stop`.

## `windower record [same flags as start] --duration <seconds> [--discard] [--json]`
Convenience wrapper: `start` + sleep `duration` + `stop`, blocking. For unattended/scripted captures where no agent action needs to happen mid-recording (see `spec.md` US-05/06 — `start`/`stop` is the primary agent-facing flow; `record` is sugar). Runs entirely `local` — no daemon is started or contacted; the CLI process itself holds the capture session for the recording's whole life.

Ctrl-C semantics: the **first** Ctrl-C finalizes the in-flight recording (video, manifest, and event timeline are written, same as a normal `stop`) and exits. A **second** Ctrl-C, sent before the first has finished finalizing, cancels/discards it instead (same as `cancel` — no output file). `--discard` makes Ctrl-C cancel on the first press instead of finalizing, for scripted callers that would rather discard a recording than keep a partial one.

## `windower config get|set <key> <value>`
Reads/writes `~/.windower/config.json` — output folder, filename template, daemon idle-timeout, default video/audio settings.

## `windower daemon status|stop|restart|kill [--discard] [--force] [--json]`
Explicit daemon lifecycle control, mostly for debugging. `status`/`stop`/`restart` are `attach` mode — they act on a daemon that is already listening and never spawn one. The daemon itself auto-starts only for `start` and `stop`/`cancel` (attaching to whatever `start` spawned) — see Daemon policy above; it is no longer true that any other command brings a daemon up.

- `daemon status`: reports the same `daemon` block as `windower doctor` (`{running, pid, version, protocolVersion, startedAt, ageSeconds, socketPath, versionMatchesClient}`), or `running: false` if nothing is listening.
- `daemon stop`: graceful by default — stops accepting new connections and **finalizes** every in-flight recording (video, manifest, and event timeline all land, exactly as if each had received an explicit `stop`) before closing the socket and exiting. `--discard` cancels those in-flight recordings instead of finalizing them, mirroring `record --discard`. Errors with `DAEMON_UNREACHABLE` if nothing is listening.
- `daemon restart`: stops the running daemon (same finalize semantics as `daemon stop`, respecting `--discard`) and starts a fresh one. Refuses with `DAEMON_BUSY` (naming the active session ids) if a recording is in flight, unless `--force` is passed to override the busy check and finalize/discard anyway. Errors with `DAEMON_UNREACHABLE` if nothing is running to restart.
- `daemon kill`: the force-kill fallback for when `daemon stop` can't reach the daemon at all (unreachable/hung socket) — the situation that otherwise leaves stray `windower` processes behind with no cleanup path but a manual `ps`/`kill`. Does **not** use the socket or the version handshake; reads `~/.windower/daemon.json` for the daemon pid and `~/.windower/sidecar-pids.json` for any native sidecar child pids (capture/control surfaces) the daemon recorded, and force-kills each: SIGTERM, then SIGKILL if still alive after a short grace period. Also clears `daemon.json`, `sidecar-pids.json`, and `capture.lock` if its recorded holder matches the pid just killed. Idempotent — running it with nothing running reports `{daemonKilled: false, sidecarPidsKilled: []}` and exits cleanly, not an error. Scoped deliberately narrow: only the daemon process and the sidecar pids it itself recorded — never `mcp-server` or any other Windower process, which have no presence in either state file and are out of scope for this command.

## `windower list [--state recording|finalized|...] [--json]`
Lists known sessions (from `~/.windower/sessions/`), most recent first — lets an agent recover context after a restart ("what was I recording?").

