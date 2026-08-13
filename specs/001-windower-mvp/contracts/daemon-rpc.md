# Daemon RPC Contract

Transport: newline-delimited **JSON-RPC 2.0** over a unix domain socket (`~/.windower/daemon.sock`, mode `0600`, no authentication beyond that — see `contracts/sidecar-protocol.md`'s framing, which this reuses). This document covers the daemon protocol's own identity, versioning, and handshake — the RPC methods that carry recording/permission semantics (`start_recording`, `stop_recording`, etc.) are specified in `contracts/mcp-tools.md` and mirrored 1:1 by `contracts/cli.md`; this file does not repeat them.

Split out of `contracts/mcp-tools.md` (Phase 20) because the daemon protocol has its own versioning semantics — a `hello` handshake, a protocol-version constant, restart/busy error codes — that are not MCP tools and apply equally to the CLI's daemon client.

## Why a version handshake

Phase 20's daemon-optional work exposed a bug latent since Phase 1: nothing checked that the CLI/MCP client and the daemon it happened to be talking to were speaking the same protocol version, or even built from the same codebase. A `npx windower@latest` invocation could silently drive a `daemon` process spawned weeks earlier by an older install, with a stale environment and no version visibility anywhere. `hello` closes that gap.

## `hello`

Client → daemon handshake. Sent once per connection by `ensureDaemonRunning` (`packages/core/src/daemon/connect.ts`) before any other RPC on that connection.

**Params:**

```jsonc
{
  "clientProtocolVersion": 1,           // integer, current DAEMON_PROTOCOL_VERSION
  "windowerHome": "/Users/x/.windower", // client's resolved WINDOWER_HOME
  "cwd": "/Users/x/project"             // RequestContext.cwd — used for relative outputDir resolution
}
```

**Result:**

```jsonc
{
  "pid": 4821,
  "version": "0.3.0",
  "protocolVersion": 1,
  "startedAt": "2026-08-09T14:02:11.000Z",
  "socketPath": "/Users/x/.windower/daemon.sock",
  "windowerHome": "/Users/x/.windower",
  "execPath": "/usr/local/bin/node",
  "entryPath": "/usr/local/lib/node_modules/windower/apps/daemon/dist/main.js"
}
```

This result shape is exactly `~/.windower/daemon.json`, the daemon identity state file written on listen and unlinked on clean stop (`packages/core/src/daemon/state-file.ts`; full field-level definition lives in `data-model.md`). `hello`'s response and the state file are kept identical on purpose: whatever `doctor` reads off disk without connecting is the same shape a live handshake would return, so the two code paths can't drift.

### `windowerHome` split-brain detection

The client sends its own resolved `windowerHome` (see `packages/core/src/daemon/paths.ts`'s `WINDOWER_HOME` resolution). The daemon compares it against its own. On disagreement, the daemon rejects the handshake loudly (`DAEMON_VERSION_MISMATCH`-shaped error, `message` naming both paths) rather than silently serving sessions from the wrong home directory. Before this check, a CLI and daemon that resolved `WINDOWER_HOME` independently (e.g. one had the env var set, one didn't) could silently disagree about where session/output state lives.

### `cwd`

Threaded into the per-connection `RequestContext` (`{cwd, windowerHome}`), used wherever a daemon RPC needs to resolve a relative path (e.g. a relative `outputDir`) against the *caller's* working directory rather than the daemon process's own.

## `daemon_info`

Read-only introspection — no handshake, no env snapshot, no side effects. Used by `windower doctor` to probe whether a daemon is listening and what it is, without spawning one and without exchanging any secret material.

**Params:** `{}`

**Result:** identical shape to `hello`'s result — `{pid, version, protocolVersion, startedAt, socketPath, windowerHome, execPath, entryPath}`.

An **old (pre-Phase-20) daemon has no `daemon_info` method** and rejects it the same way it rejects `hello` — see "Version handshake semantics" below; the same rejection is the signal in both cases.

## `DAEMON_PROTOCOL_VERSION`

An integer constant, defined in `packages/core/src/daemon/protocol.ts` alongside the `hello`/`daemon_info` param/result schemas. Bumped on any wire-incompatible change to the daemon RPC surface — a new required param, a changed result shape, a removed method. Additive, backward-compatible changes (a new optional field, a new method) do **not** require a bump.

This is a **daemon protocol** version, distinct from:
- the sidecar protocol (`contracts/sidecar-protocol.md`'s `describe.version`), which is versioned independently and never conflated with this one;
- the package `version` field (semver, from `packageVersion()`), which changes on every release regardless of wire compatibility.

A client compares `DAEMON_PROTOCOL_VERSION` (its own, compiled in) against the daemon's `protocolVersion` (from `hello`'s result). Equal means compatible; anything else triggers the mismatch handling below.

## Version handshake semantics

`hello` is deliberately a **plain RPC method** — not a new frame type, not a magic first line, not a change to the newline-delimited-JSON framing itself. This is what makes back-compat free:

- An **old 0.1.x daemon** (pre-Phase-20, no `hello` method registered) responds to an unrecognized method the same way it always has — `INVALID_ARGS` (`apps/daemon/src/server.ts`'s existing unknown-method handling). That rejection is not a bug the client works around; it **is** the unambiguous "protocol version 0, pre-handshake daemon" signal. No flag day, no version sniffing before the socket is even opened, no coordinated rollout — the very first `hello` sent to any daemon, old or new, tells the client everything it needs to know from its response alone (a result vs. an `INVALID_ARGS` error).
- A **new daemon talking to a version-unaware caller** (theoretical, since the client is what initiates `hello`) is not a case this protocol needs to handle — the client always sends `hello` first on a fresh connection.

On a genuine version **mismatch** (`hello` succeeds, but `result.protocolVersion !== DAEMON_PROTOCOL_VERSION`) or on the "protocol version 0" signal above:

1. The client (`ensureDaemonRunning` in `packages/core/src/daemon/connect.ts`) may attempt to **restart the daemon**, but only when it's safe — see `DAEMON_BUSY` below.
2. The restart happens **at most once per invocation**. If the freshly-restarted daemon's `hello` still doesn't match (e.g. a broken install), the client surfaces `DAEMON_VERSION_MISMATCH` to the caller rather than retrying again — never a restart loop.
3. Safety check before restarting: `list_sessions({state: "recording"})` must come back empty against the *old* daemon. Anything in flight aborts the restart attempt in favor of `DAEMON_BUSY`.
4. A safe restart goes through the same graceful `shutdown({mode: "graceful"})` path documented below, then a fresh spawn through the spawn lockfile.
5. `windower daemon restart --force` (CLI-only, see `contracts/cli.md`) lets a caller override the busy check explicitly — never invoked automatically.

## Error codes

New in Phase 20, added to `DaemonErrorCodeSchema` (`packages/core/src/daemon/methods.ts`) alongside the existing `DAEMON_UNREACHABLE` / `INVALID_ARGS` / `TARGET_ALREADY_RECORDING` / `OUTPUT_DIR_NOT_WRITABLE` codes. Same JSON error shape as the rest of the daemon/sidecar taxonomy — `data.code` from this fixed set, `message` human-readable:

```jsonc
{ "error": { "code": "DAEMON_VERSION_MISMATCH", "message": "..." } }
```

| Code | Meaning |
|---|---|
| `DAEMON_VERSION_MISMATCH` | The connected daemon's `protocolVersion` disagrees with the client's `DAEMON_PROTOCOL_VERSION` (including the "no `hello` method" / pre-handshake signal), and an auto-restart either wasn't attempted or didn't resolve it. Also used for a `windowerHome` disagreement surfaced during `hello` (see above). `message` names both versions (or both paths). |
| `DAEMON_BUSY` | A version-mismatch restart was attempted, but the daemon has in-flight work — at least one session in `recording` state — so the restart was refused rather than orphaning that work. `message` names the specific session id(s) still active, and points at the remediation: `windower stop <id>` to clear the in-flight work, then retry, or `windower daemon restart --force` to override the check outright. |

Both codes flow through the same CLI exit-code mapping as the rest of `DaemonErrorCodeSchema` (`contracts/cli.md`) and the same MCP tool-error shape as every other daemon-backed tool in `contracts/mcp-tools.md`.

## Shared backend infrastructure

Both the CLI and MCP server route every command/tool through one of three backend modes — `local` (transient sidecar call or direct disk read, no daemon involved), `daemon` (spawn-if-needed via `ensureDaemonRunning`, then RPC), and `attach` (connect only if a daemon is already listening; never spawn — used by `stop`/`cancel` so a dead daemon doesn't get silently replaced mid-session). Which command/tool uses which mode is a per-surface concern documented in `contracts/cli.md` (command → mode table) and `contracts/mcp-tools.md` (tool → mode table).

The mechanism underneath that routing decision is shared infra, described here since both consumers depend on it identically:

- **`WindowerBackend`** (`packages/core/src/daemon/backend.ts`) — the interface both the RPC client (talking to a real daemon over the socket) and `LocalWindower` (talking to `@windower/engine` in-process) implement. Callers code against this interface, not against "daemon RPC client" directly, so `local` vs. `daemon` vs. `attach` is an implementation swap, not a branch scattered through CLI/MCP command bodies.
- **Policy table** (`packages/core/src/daemon/policy.ts`) — the single command/tool-id → `local` | `daemon` | `attach` map. One table, consumed by both `packages/cli` and `packages/mcp-server`, so the routing decision lives in exactly one place and a new command can't silently default to the wrong mode (enforced by a test asserting every registered command has an entry).

## Spawn lockfile

`~/.windower/daemon.lock` serializes concurrent spawn attempts so two invocations racing `ensureDaemonRunning` never both spawn a daemon or unlink each other's live socket:

- Acquire the lock before spawning. If another process already holds it, **do not spawn** — poll the socket instead until it's connectable or the lock is released.
- Under the lock, only unlink a stale socket when `daemon.json`'s recorded pid is dead (or the file is absent) **and** the connection attempt failed with `ECONNREFUSED` specifically — never on a transient/other error, which could unlink a socket a live daemon is still binding.
- Spawn, poll for the socket to accept `hello`, release the lock.

Full acquire/steal/release mechanics (`O_EXCL` create, pid-liveness staleness check, unlink release) are the same `FileLock` primitive (`packages/core/src/fs/file-lock.ts`) used for the per-target capture lock in `phase-20-daemon-optional.md`'s "Cross-process safety" section — not re-specified here.

## Graceful shutdown

`shutdown({ mode: "graceful" | "immediate" })` — the daemon RPC method backing `windower daemon stop` (`contracts/cli.md`) and, before Phase 20, the only way to cleanly stop a daemon over the wire (see `contracts/mcp-tools.md`'s `shutdown` entry, which documents the tool-adjacent history; this method is daemon-only and not exposed through MCP).

**Params:** `{ mode?: "graceful" | "immediate" }` — defaults to `"graceful"`.

**Result:** `{ shuttingDown: true }`, sent before the daemon begins tearing down.

- **`graceful`** (default): stop accepting new connections → `stopRecording` every session still in `recording` state, so a finalized video, manifest, and `.events.json` all land on disk → close the socket, unlink the socket file and `daemon.json` → exit. Bounded to roughly 30 seconds; if it doesn't complete in time, the daemon escalates itself to the `immediate` path rather than hanging.
- **`immediate`**: skip the drain/finalize sequence and exit as fast as possible. Sessions still `recording` at that point are left for the next daemon start's crash-recovery pass (`recoverCrashedSessions()`) to mark `failed`.
- `windower daemon stop --discard` (CLI, see `contracts/cli.md`) maps to canceling in-flight sessions rather than finalizing them, then proceeding with the graceful drain otherwise.
- `bin.ts`'s `SIGTERM`/`SIGINT` handlers invoke the graceful path. A best-effort `process.on("exit")` sweep additionally `SIGKILL`s anything left in the in-memory `activeSidecars` map, so a hard process exit (e.g. `SIGKILL` sent to the daemon itself) can't orphan a capture process indefinitely.

See `contracts/mcp-tools.md`'s `shutdown` section and `contracts/cli.md`'s `daemon stop`/`daemon restart` documentation for the CLI-facing command surface built on top of this RPC.
