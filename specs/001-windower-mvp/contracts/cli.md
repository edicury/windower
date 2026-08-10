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
| `operate` (blocking, default) | `local` |
| `operate status` | `local` |
| `operate list` | `local` |
| `start` | `daemon` |
| `operate --detach` | `daemon` |
| `operate abort` | `daemon` |
| `stop` | `attach` |
| `cancel` | `attach` |
| `daemon status` | `attach` |
| `daemon stop` | `attach` |
| `daemon restart` | `attach` (must find a live daemon to restart; refuses if none is running) |

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
- `activeSessions`, `activeRuns`: counts (or ids) of in-flight recordings/operator runs, sourced from the daemon when reachable and from disk-persisted state otherwise.
- API-key environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, and the configured `apiKeyEnvVar`): **presence only, never values** — reported separately for the client (`doctor`'s own process env) and the daemon (if reachable), so an environment drift between the invoking shell and a long-lived daemon is visible directly (e.g. `present in CLI: yes` / `present in daemon: no`).

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

## `windower daemon status|stop|restart [--discard] [--force] [--json]`
Explicit daemon lifecycle control, mostly for debugging. All three subcommands are `attach` mode — they act on a daemon that is already listening and never spawn one. The daemon itself auto-starts only for `start`, `stop`/`cancel` (attaching to whatever `start` spawned), and `operate --detach`/`operate abort` — see Daemon policy above; it is no longer true that any other command brings a daemon up.

- `daemon status`: reports the same `daemon` block as `windower doctor` (`{running, pid, version, protocolVersion, startedAt, ageSeconds, socketPath, versionMatchesClient}`), or `running: false` if nothing is listening.
- `daemon stop`: graceful by default — stops accepting new connections, **finalizes** every in-flight recording (video, manifest, and event timeline all land, exactly as if each had received an explicit `stop`) and aborts every in-flight operator run independently of that, before closing the socket and exiting. `--discard` cancels those in-flight recordings instead of finalizing them, mirroring `record --discard`. Errors with `DAEMON_UNREACHABLE` if nothing is listening.
- `daemon restart`: stops the running daemon (same finalize semantics as `daemon stop`, respecting `--discard`) and starts a fresh one. Refuses with `DAEMON_BUSY` (naming the active session/run ids) if a recording or operator run is in flight, unless `--force` is passed to override the busy check and finalize/discard anyway. Errors with `DAEMON_UNREACHABLE` if nothing is running to restart.

## `windower list [--state recording|finalized|...] [--json]`
Lists known sessions (from `~/.windower/sessions/`), most recent first — lets an agent recover context after a restart ("what was I recording?").

## `windower operate "<task>" --target <id> [--kind window|display|region] [--region x,y,w,h] [--model p:m] [--base-url u] [--secret name=source:ref]... [--max-steps n] [--timeout s] [--max-batch n] [--unbounded] [--detach] [--json]`
Starts a guided operator run: an LLM-driven loop that perceives the screen (`captureFrame`), synthesizes mouse/keyboard input (`performInput`), and drives `<task>` to completion.

`--target`/`--kind`/`--region` are **the exact same target flags `windower start` takes**, reusing the same selector — not an operator-specific parallel set. They name what the operator perceives and drives, and what its bounds clamp is evaluated against.

`--model p:m` selects a provider:model pair (e.g. `openai:gpt-4o`, `anthropic:claude-sonnet-5`, `openai-compatible:llama3` for a local server via `--base-url`); the operator's model is independent of and unrelated to whatever agent/model is calling the CLI. `--secret name=source:ref` (repeatable) resolves a named secret (e.g. `password=keychain:waroom`) at call time and substitutes it into typed input — the raw value is never written to the CLI's own argv logging or the operator's transcript. `--max-steps`/`--timeout` bound the run and `--max-batch` bounds actions per turn; `--unbounded` explicitly opts out of the step and time bounds (use with care).

**Recording independence (Phase 21, normative).** `operate` is completely unaware of recording: the run never knows whether a recording exists, never starts, stops, cancels, or looks one up, never routes frames through a recording session, and never carries a session id. **The same run behaves identically whether the screen is being recorded or not.** An orchestrator that wants video sequences `windower start` and `windower stop` around it — see the three-call example below.

**Breaking change (Phase 21) to Phase 19's shipped surface.** `operate` previously accepted the shared video/audio recording flags and auto-started a recording it owned, with `--no-record` to opt out; a Phase 21 draft additionally proposed `--session <sessionId>` to attach a run to an existing session. **All of it is removed** — the recording flags, `--no-record`, `--session`, and the `INVALID_ARGS` mutual-exclusivity between them. Rationale: owning a recording required the Operator to start one and attaching required it to hold a session id; each independently violates the prohibitions above. Scripts using the old all-in-one form migrate to the three-call flow below.

The twelve removed flags — `--no-record`, `--session`, `--fps`, `--codec`, `--container`, `--resolution`, `--quality`, `--audio-system`, `--audio-mic`, `--mic-device`, `--separate-tracks`, `--out` — stay **registered but hidden** on `operate`, absent from `--help`, so that passing one is not swallowed as an unknown option. Doing so fails with `INVALID_ARGS` naming the specific flag *and* printing the caller-side recipe (`windower start --target <id> [recording flags]` → `windower operate "<task>" --target <id>` → `windower stop <sessionId>`), so a script written against the old surface is told what to do rather than just what not to do. No new exit code is introduced for this — it is an ordinary argument-validation failure. There is likewise **no** `--api-key` flag, in this command or any other (`contracts/operator.md` §Model configuration).

**Blocks by default**, `local` mode: the operator engine runs in-process against the invoking CLI's own environment, so the API key is read from the invoking shell — the run can never end up driven by a different, frozen environment than the one that started it. Step-by-step progress (`onStep`) streams to **stderr** as it happens; the terminal `OperatorRun` is written to **stdout** when `--json` is passed (plain text otherwise). The emitted object is the `OperatorRun` as-is, with its `id` field — there is no `runId` alias, since blocking is the only mode `operate` has ever shipped with a stable stdout contract for. Ctrl-C aborts the run; any recording running concurrently is untouched and keeps recording until its own owner stops it. Any terminal state other than `succeeded` (e.g. `failed`, `aborted`, timed out) causes the command to **exit 1**, reusing the existing `0`/`1`/`2`/`3` exit-code scheme documented above — no new codes are introduced.

`--detach` opts out of the default and restores the original non-blocking two-call shape: `daemon` mode, auto-starting a daemon if needed, returns immediately with `{ runId }`, and `windower operate status`/`operate abort` are then used to poll and control it — identical to `start`/`stop` for recordings. This is the shape MCP's `run_operator` always uses (see `contracts/mcp-tools.md`); `--detach` is how a terminal user opts into the same non-blocking behavior.

Examples:
```
# blocking (default) — streams progress to stderr, final OperatorRun on stdout. No recording.
windower operate "Open waroom.co, log in as {{user}}/{{password}}, create an incident" \
  --target <id> --secret password=keychain:waroom --json

# detached — returns { runId } immediately, poll with `operate status`
windower operate "Open waroom.co, log in as {{user}}/{{password}}, create an incident" \
  --target <id> --secret password=keychain:waroom --detach --json

# three-call orchestrated flow — the caller owns the recording end to end, and
# passes the SAME target flags to `start` and `operate`
SESSION=$(windower start --target <id> --json | jq -r .sessionId)
windower operate "Open waroom.co and create an incident" --target <id> --json
windower stop "$SESSION" --json
```

## `windower operate status <runId>`
Returns the current `OperatorRun` — state, steps so far, elapsed time. `local` mode: reads the run store directly, no daemon required — works for both a still-detached run and a finished blocking run's persisted record.

## `windower operate abort <runId>`
Aborts an in-progress operator run mid-flight. No recording is stopped, canceled, or otherwise touched — a run never owns one. `daemon` mode — only meaningful against a detached run, which is the only kind with an id that outlives the invoking process.

## `windower operate list [--state <state>]`
Lists known operator runs, most recent first — same recovery-after-restart affordance as `windower list` for sessions. `local` mode: reads the run store directly.

No new exit codes are introduced for `operate` — it reuses the existing `0`/`1`/`2`/`3` scheme documented above. In blocking mode, a terminal `OperatorRun.state` other than `succeeded` maps to exit `1`.
