## Phase 20 — Daemon-Optional (v1.3)

**Goal:** `npx windower record ...` works out of the box with **zero daemon management** — no background process the user has to know exists, start, stop, or reason about. The daemon stops being Windower's front door and becomes an implementation detail of the two flows that genuinely need one.

**Context / why now:** Phase 19's live testing failed on daemon ergonomics, not on operator code. `windower operate` died with `OPERATOR_MISSING_API_KEY` while being invoked from a shell that had the key, because `spawnDaemonDetached` (`packages/core/src/daemon/connect.ts:69-77`) passes `env: process.env` and that environment is then **frozen for the daemon's entire lifetime** — the daemon that happened to be listening had been spawned by a keyless shell 20 minutes earlier. macOS TCC grants are inherited the same way, from whichever process first won the spawn race. Both are invisible to the user and unreported by `windower doctor`.

Investigating that turned up how little of Windower actually needs a daemon. Only `start`/`stop`/`cancel` (split-invocation recording) and `operate --detach`/`operate abort` need state that outlives the CLI process. `targets`, `doctor`, `permission request`, and `resize` are already one-shot transient sidecar spawns via `PassthroughService` (`apps/daemon/src/passthrough.ts:13-84`, measured at ~113ms cold). `status`, `list`, `operate status`, `operate list` are plain disk reads. `config` never touches the daemon at all. And `record --duration` (`packages/cli/src/commands/record.ts:31-46`) holds the socket open for the whole recording in a single CLI process — the daemon is a pure intermediary there, adding a spawn race, a frozen environment, and a 30-minute idle lifetime for nothing.

Three latent bugs found alongside, all of which bite hardest in exactly the `npx` case this phase targets:

1. **No daemon version handshake exists** (`packages/core/src/daemon/methods.ts` has no version method). `npx windower@latest` silently drives whatever stale daemon is already listening, possibly weeks old.
2. **`daemon stop` orphans recordings.** `shutdown` (`apps/daemon/src/server.ts:246-256` → `main.ts:57-59`) closes the socket and exits without stopping sessions or terminating sidecars; capture processes are orphaned mid-recording and the next daemon start rewrites those sessions to `failed`.
3. **Spawn race.** `ensureDaemonRunning` (`connect.ts:105-111`) unlinks a stale socket then spawns with no lockfile or pidfile — two concurrent invocations can both spawn, and the loser can unlink the winner's live socket.

### Settled decisions (do not relitigate during implementation)

- **Daemon-optional.** `record`, `targets`, `doctor`, `permission`, `resize`, `status`, `list`, `config` run with **no daemon**. The daemon auto-starts only for `start`/`stop`/`cancel`/`operate --detach`/`operate abort`.
- **`operate` blocks by default**, streaming step progress, so it works daemon-free; `--detach` restores today's `{runId}` behavior. **MCP's `run_operator` stays non-blocking and daemon-backed** — MCP hosts impose per-tool-call timeouts far shorter than `DEFAULT_OPERATOR_TIMEOUT_MS` (a blocking tool would time out at the host and orphan a live run), a run must stay visible to `windower operate status` from a terminal and to a second MCP host (which requires a shared owner), and the two-call shape deliberately mirrors `start_recording`/`stop_recording`.
- **Scoped env snapshot over the socket.** A `hello` RPC carries only the model's API-key variable plus any `env:` secret refs named in that request — never `process.env` wholesale, never logged. The socket is already `0600` with no authentication (`server.ts:96`), so a same-UID process can already drive the daemon and read the CLI's environment directly; this crosses no new trust boundary on macOS. Blocking `operate` — the default path — never puts a key on the socket at all.
- **New public `@windower/engine`** holds recording orchestration; `apps/daemon` keeps only socket + lifecycle. This also keeps `ffmpeg-static` (~70MB) out of `@windower/core`.
- Graceful shutdown **finalizes** in-flight recordings (`--discard` cancels instead). First Ctrl-C on `record` finalizes, second cancels. Blocking `operate --json` emits the `OperatorRun` as-is with `id` (no `runId` alias — `operate` has never shipped). Any non-`succeeded` terminal state exits 1, reusing existing codes per `contracts/cli.md`.

### Contracts (first — per `CLAUDE.md`, fix the contract before implementing)

- 🔵 `contracts/cli.md`: new **Daemon policy** section naming the three backend modes (`local` / `daemon` / `attach`) and listing which commands are in each — this replaces the current blanket claim that "the daemon auto-starts on first use of any other command", which becomes false. Update `operate` (blocking by default, `--detach` opt-out, API key read from the invoking shell in blocking mode), `record` (explicitly daemon-free, Ctrl-C semantics), `doctor` (expanded report), and `daemon` (add `restart`, document `stop`'s finalize semantics and `--discard`).
- 🔵 `contracts/mcp-tools.md`: `run_operator` stays non-blocking and daemon-backed — **write the justification into the contract** so it isn't re-opened. New `PermissionReport` fields on `check_permissions`. `shutdown` gains `mode`.
- 🔵 New `contracts/daemon-rpc.md`: `hello`, `daemon_info`, `DAEMON_PROTOCOL_VERSION`, and the new `DAEMON_VERSION_MISMATCH` / `DAEMON_BUSY` error codes. Split out of `mcp-tools.md` because the daemon protocol now has versioning semantics that are not MCP tools.
- 🔵 `data-model.md`: `PermissionReport` additions (all optional, so old daemons' responses still parse), `RecordingSession.owner`.

### Core primitives (`packages/core`)

- 🔵 `src/fs/atomic-write.ts` — `writeFileAtomic` (temp + rename), the pattern `apps/daemon/src/operator-run-store.ts` already uses.
- 🔵 `src/fs/file-lock.ts` — `FileLock`: `O_EXCL` acquire, pid-liveness stale steal, unlink release. Backs both the spawn lock and the target lock.
- 🔵 `src/daemon/protocol.ts` — `DAEMON_PROTOCOL_VERSION` + `hello`/`daemon_info` schemas.
- 🔵 `src/daemon/state-file.ts` — `~/.windower/daemon.json` (`{pid, version, protocolVersion, startedAt, socketPath, windowerHome, execPath, entryPath}`), written on listen, unlinked on stop. Lets `doctor` report daemon identity without connecting, and lets stale-socket detection check pid liveness instead of blindly unlinking.
- 🔵 `src/daemon/backend.ts` — the `WindowerBackend` interface (the `DaemonMethodMap` surface), implemented by both the RPC client and the local engine.
- 🔵 `src/daemon/policy.ts` — **one** command → `local` | `daemon` | `attach` table, consumed by both CLI and MCP so the routing decision lives in exactly one place.
- 🔵 `packageVersion()` helper replacing the hardcoded `WINDOWER_VERSION = "0.1.0"` (`apps/daemon/src/session-manager.ts:33`) and `.version("0.0.0")` (`packages/cli/src/index.ts:27`); also used in the manifest.
- 🔵 New daemon error codes in `src/daemon/methods.ts`: `DAEMON_VERSION_MISMATCH`, `DAEMON_BUSY`, with CLI exit-code mapping.

`attach` is the mode that makes `stop`/`cancel` correct: connect **only** if a daemon is already listening, never spawn. Because `start` always spawns a daemon, a session in `recording` state always has a daemon owner — so if nothing is listening at `stop` time, the owner is dead, and the local fallback marks the session `failed`/`canceled` with a clear message instead of spawning a fresh daemon that would answer `SESSION_NOT_FOUND`.

### Daemon lifecycle hardening (`apps/daemon`, `packages/core/src/daemon/connect.ts`)

- 🔵 `hello` handshake in `ensureDaemonRunning`: connect → `hello` → compare protocol versions → on match return; on mismatch, restart **if safe**, at most once, never looping.
  - Safe means: `list_sessions({state:"recording"})` and `list_operator_runs` are empty. If anything is in flight, refuse with `DAEMON_BUSY` naming the active ids and pointing at `windower stop <id>` / `windower daemon restart --force`.
  - Back-compat falls out free: an old 0.1.x daemon rejects an unknown method with `INVALID_ARGS` (`server.ts:172-174`), so any error from `hello` is an unambiguous "protocol version 0" signal. **This is why `hello` must be a method, not a new frame type or magic first line** — no flag day, no coordination.
- 🔵 Per-connection `RequestContext` (`{env, cwd, windowerHome}`) stored at `hello`, threaded into `SecretResolver` and the operator run engine. A detached run outlives its connection, so it **snapshots** the env at run start rather than reading the connection later.
- 🔵 `OperatorRunOptions.env` finally passed at `apps/daemon/src/operator-run-manager.ts:257-276` — this is what makes `resolveModel(config, internals.env)` (`packages/operator/src/providers.ts:67,78`) see the *caller's* key instead of the daemon's frozen environment. Root fix for the bug that started this phase.
- 🔵 Graceful `shutdown({mode: "graceful" | "immediate"})`, default graceful: stop accepting connections → abort active operator runs (their existing finalizer stops the recording cleanly) → `stopRecording` every session still `recording` so video + manifest + `.events.json` all land → close socket, unlink socket and `daemon.json`, exit. Bounded (~30s), escalating to `immediate` on timeout. `bin.ts`'s SIGTERM/SIGINT handlers use the graceful path; add a best-effort `process.on("exit")` SIGKILL sweep over `activeSidecars` so a hard exit can't orphan capture processes.
- 🔵 Spawn lockfile `~/.windower/daemon.lock`: acquire → if another holder has it, **do not spawn**, poll the socket instead → under the lock, only unlink the socket when `daemon.json`'s pid is dead or absent *and* the error was `ECONNREFUSED`, never on a transient error → spawn, poll, release.
- 🔵 `checkIdle` (`server.ts:115-127`) must count operator runs, not just sessions — an `operate --no-record` run has no session today and can be idle-shutdown out from under itself.
- 🔵 `windower daemon restart` (`packages/cli/src/commands/daemon.ts`), with `--force` to override the busy check.
- 🔵 `hello` exchanges `windowerHome` and errors loudly on disagreement, fixing the silent split-brain where CLI and daemon read `WINDOWER_HOME` independently (`packages/core/src/daemon/paths.ts:12`).

### Extract `@windower/engine` (`packages/engine`, new published package)

- 🔵 Move, largely verbatim: `session-store`, `operator-run-store`, `output-resolver`, `event-timeline-writer`, `narration-mux`, `passthrough`, `secret-resolver`, `operator-run-manager` (→ `operator-run-engine`).
- 🔵 Extract `manifest.ts` (`buildManifest` + `writeManifest`) from the block currently inlined in `SessionManager.stopRecording` (`apps/daemon/src/session-manager.ts:380-421`), along with the temp→final `rename` at `:348`.
- 🔵 `RecordingEngine` = today's `SessionManager` minus the process-local `activeTargetKeys` guard, plus `TargetLock` and the extracted manifest module. Its `activeSidecars`/`eventWriters`/`plannedOutputPaths`/`operatorRunPaths` maps are per-instance and work unchanged in both hosts — a `record --duration` CLI process holds one instance for its whole life.
- 🔵 `LocalWindower` implementing `WindowerBackend` over the engine — the daemon-free half of the routing decision.
- 🔵 `apps/daemon` re-exports the moved symbols with `@deprecated` for one minor.
- 🔵 **`narration-mux` must land in `@windower/engine`, not `@windower/core`** — it drags `ffmpeg-static`, and `@windower/mcp-server` should be able to take core without a 70MB binary.
- 🔵 **Acceptance criterion for this task:** the existing daemon tests move alongside their files and stay green with only import-path edits. Any test that needs logic changes means the extraction changed behavior — stop and reconsider.

`recoverCrashedSessions()` must stay daemon-only. It marks *every* `recording` session `failed` at startup; running it from a daemon-free CLI would kill a concurrently-running daemon's live recording.

### Cross-process safety

- 🔵 `packages/engine/src/target-lock.ts` — `~/.windower/locks/target-<sha1(targetKey)>.lock` holding `{sessionId, pid, startedAt, targetKey}`, stale-stolen when the owner pid is dead. Replaces the in-memory `activeTargetKeys` map (`session-manager.ts:113,176-192`); `targetKey()` (`:75-84`) moves verbatim. Keep this guard — a daemon-free `record` and a daemon-backed `start` on the same display would otherwise both capture, and on macOS that's two ScreenCaptureKit streams fighting. As a bonus it fixes today's behavior where a crashed daemon leaves no trace and a restarted one starts with an empty map. `TARGET_ALREADY_RECORDING` gains the owning pid and session id.
- 🔵 `SessionStore`: atomic writes (today's plain `writeFile` can be read torn, and the loader *skips* malformed records, so a torn read looks like a missing session); mtime-based cache invalidation so `get`/`list` see another process's writes; optional `RecordingSession.owner` (`{pid, startedAt}`) so a process only mutates sessions it owns or whose owner pid is dead — which is what makes the `attach`-mode local `stop`/`cancel` fallback safe. Optional field, so 0.1.x session files still parse.

### CLI routing (`packages/cli`)

- 🔵 `src/backend.ts` — `withBackend(commandId, json, fn)` replacing `withDaemon` (`src/daemon.ts:15-27`). Every command's action changes exactly one line.
- 🔵 `--daemon` / `--no-daemon` flags and `WINDOWER_BACKEND=local|daemon` as debugging escape hatches.
- 🔵 A test asserting **every registered commander command name has a policy entry**, so a new command can't silently default to the wrong mode.
- 🔵 `record` daemon-free, with SIGINT handling: first Ctrl-C finalizes, second cancels.
- 🔵 `status` / `list` / `operate status` / `operate list` read the stores directly; `stop` / `cancel` / `daemon status` / `daemon stop` use `attach`.

### `doctor` rewrite

- 🔵 Fully daemon-free: spawns its own transient sidecar and **probes** the daemon without spawning it. `daemonRunning` stops being hardcoded `true` (`apps/daemon/src/passthrough.ts:44-45,56`), where it is currently tautological — if you got a response, it was true.
- 🔵 Report (all `PermissionReport` additions optional so old daemons still parse): daemon `{running, pid, version, protocolVersion, startedAt, ageSeconds, socketPath, versionMatchesClient}`; client `{name, version, protocolVersion}`; sidecar `{available, version, resolvedPath, source: "env-override"|"dev-build"|"npm-package", expectedVersion}`; `windowerHome {path, fromEnvOverride}`; `outputDir {path, writable}`; `activeSessions`, `activeRuns`.
- 🔵 **API-key env var presence only, never values**, for both client and daemon (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, and the configured `apiKeyEnvVar`). A row reading `present in CLI: yes / present in daemon: no` is a one-line self-diagnosis of the exact bug that motivated this phase.

### `operate` blocking by default

- 🔵 Runs the operator engine in-process against `LocalWindower`; `onStep` renders progress to stderr; stdout gets the terminal `OperatorRun`. Ctrl-C aborts and finalizes the recording.
- 🔵 `--detach` → daemon-backed, returns `{runId}`, as today.
- 🔵 `@windower/cli` gains a direct `@windower/operator` dependency but keeps the existing lazy dynamic-import seam so the AI SDK only loads when `operate` actually runs.

### MCP routing (`packages/mcp-server`)

- 🔵 Same policy table. `run_operator` unchanged (non-blocking, daemon-backed). `hello` env snapshot sourced from the MCP process environment — note in the docs that an MCP host's `mcpServers.env` block is the well-defined place for a user to set the key.
- 🔵 `check_permissions`, `list_targets`, `resize_window`, `get_session`, `list_sessions` go `local`.

### Docs

- 🔵 `README.md` — the install/run section should stop implying a daemon is part of the mental model; document `npx windower record` as the zero-setup path.
- 🔵 `plugins/claude-code/SKILL.md` — blocking vs `--detach` operator guidance; MCP behavior is unchanged.
- 🔵 **A central environment-variable reference** — none exists today. `WINDOWER_HOME`, `WINDOWER_SIDECAR_BINARY_PATH`, `WINDOWER_DAEMON_BIN_PATH`, `WINDOWER_BACKEND`, `WINDOWER_OPERATOR_DEBUG`, and the provider API-key vars are currently documented across three files or not at all.
- 🔵 `~/Documents/Development/windower-site` per `CLAUDE.md`'s standing instruction — the "no daemon to manage" story is a genuine marketing point, and the install/quickstart copy should lead with `npx windower record`.
- 🔵 `STATUS.md`.

### Live verification (final task — do this last, after everything above)

TCC grants and a real model can't be scripted in CI, so this is a **manual pre-merge check** per `e2e/README.md`, not a CI job. It clears both Phase 19's outstanding debt and Phase 20's own criteria.

- 🔵 **Phase 19 debt (still unmet):** a real `windower operate` run against a real model with real TCC grants — synthetic clicks actually land; the recorded `.events.json` carries `source: "operator"` for them (the `eventSourceUserData` round-trip through the event tap is the least-proven part of Phase 19 and the most likely thing to be wrong in practice); `manifest.json`'s `operatorRunPath` points at a well-formed transcript; a `--secret` value appears nowhere in the transcript, daemon/sidecar logs, or event timeline.
- 🔵 `npx windower record --duration 10` on a machine with **no daemon running**, leaving **no daemon behind** — the headline claim of this phase, verified literally.
- 🔵 `windower daemon stop` mid-recording leaves a playable, finalized file and no orphan sidecar process (`e2e/src/lib/find-child-pid.ts` already exists for the orphan check).
- 🔵 Target-lock contention: a daemon-free `record` and a daemon-backed `start` on the same display — second one refused with `TARGET_ALREADY_RECORDING` naming the owner, not two fighting capture streams.
- 🔵 Version-mismatch auto-restart against a real older build via `WINDOWER_DAEMON_BIN_PATH`, and the `DAEMON_BUSY` refusal when a session is live.
- 🔵 Blocking `operate` end-to-end, including Ctrl-C mid-run finalizing the recording.

**Explicitly out of scope for this phase**

- Daemon-free `start`/`stop`. The split-invocation sidecar genuinely needs an owner process; orphan-and-reattach would trade one class of bug for a worse one. `start` auto-spawning the daemon is correct — with the handshake, lockfile, and graceful shutdown it becomes invisible, which is the actual goal.
- Any authentication on the unix socket beyond the existing `0600` mode.
- Windows/Linux backends (Phases 16/17), though `WindowerBackend` and the policy table must not assume a single platform.
- Reworking the MCP two-call semantics.

**Exit criteria**

- `npx windower record --duration 10` on a clean machine records successfully with **no daemon process running before or after**, and no user-visible mention of a daemon anywhere in the path.
- `windower doctor` run from a shell whose environment differs from a running daemon's makes that difference visible in one line, without printing any secret value.
- A stale daemon from an older version is detected and restarted automatically when idle, and refused with an actionable `DAEMON_BUSY` when a recording or operator run is live — never silently driven.
- `windower daemon stop` during an active recording produces a playable, finalized video with its manifest and event timeline, and leaves no orphaned sidecar process.
- Two concurrent invocations never both spawn a daemon, and never unlink each other's socket.
- `windower operate` works from any shell that has the API key, with no daemon restart required — the Phase 19 failure that motivated this phase cannot recur.
- Every command has an explicit entry in the backend policy table, enforced by a test.
- Phase 19's outstanding acceptance items (operator-tagged events, secret redaction, guardrails, model swap) are verified live, not just against fakes.
