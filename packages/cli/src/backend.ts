import {
  type BackendMode,
  type CommandId,
  type DaemonClient,
  DaemonError,
  type ResolveBackendModeOptions,
  type SessionState,
  type WindowerBackend,
  connectToDaemon,
  ensureDaemonRunning,
  resolveBackendMode,
} from "@windower/core";
import { LocalWindower, SessionStore } from "@windower/engine";
import { printError, printResult } from "./output.js";

/**
 * `withBackend(commandId, json, fn)` replaces `withDaemon` (`src/daemon.ts`)
 * for every command in `contracts/cli.md`'s Daemon policy table that isn't
 * one of the two carved-out cases (`record`, and `operate`'s main blocking
 * run — both construct/hold a `LocalWindower` themselves for reasons the
 * generic per-call helper here can't express: `record` needs one instance
 * alive across `start` → sleep → `stop`, and `operate`'s SIGINT/`--detach`
 * handling is out of this file's scope).
 *
 * Looks the command's mode up via `resolveBackendMode` (`packages/core/src/
 * daemon/policy.ts`), then:
 *   - `local`  -> a fresh in-process `LocalWindower` (`@windower/engine`).
 *   - `daemon` -> `ensureDaemonRunning()` (auto-spawns if needed).
 *   - `attach` -> `connectToDaemon()` (never spawns).
 *
 * `options.forcedMode` is the resolved value of the `--daemon`/`--no-daemon`/
 * `WINDOWER_BACKEND` debugging escape hatches (see `resolveForcedMode`
 * below) and overrides the policy table's decision — EXCEPT for `attach`-mode
 * commands, which `contracts/cli.md` says are "unaffected by these flags,
 * since attaching to (rather than spawning) an existing daemon is inherent
 * to their correctness." `record` never passes `forcedMode` at all, so it's
 * unconditionally `local` regardless of the flags/env var.
 */
export interface WithBackendOptions extends ResolveBackendModeOptions {
  /** Resolved `--daemon`/`--no-daemon`/`WINDOWER_BACKEND` override, or `undefined` if none applies. Ignored when the command's policy mode is `attach`. */
  forcedMode?: "local" | "daemon";
}

export interface AcquiredBackend {
  mode: BackendMode;
  instance: WindowerBackend;
  dispose: () => void;
}

/** Resolves the effective mode for `commandId`, applying `options.forcedMode` unless the policy mode is `attach`. */
export function effectiveMode(commandId: CommandId, options: WithBackendOptions = {}): BackendMode {
  const policyMode = resolveBackendMode(commandId, options);
  if (policyMode === "attach") return policyMode;
  return options.forcedMode ?? policyMode;
}

/**
 * Constructs (and connects, if needed) the backend for `commandId`. Callers
 * own the returned handle and must call `dispose()` when done, success or
 * failure — mirrors `withDaemon`'s `finally { client?.dispose() }`.
 */
export async function acquireBackend(
  commandId: CommandId,
  options: WithBackendOptions = {},
): Promise<AcquiredBackend> {
  const mode = effectiveMode(commandId, options);

  if (mode === "local") {
    return { mode, instance: new LocalWindower(), dispose: () => {} };
  }
  if (mode === "daemon") {
    const client = await ensureDaemonRunning();
    return { mode, instance: client, dispose: () => client.dispose() };
  }
  const client = await connectToDaemon();
  return { mode, instance: client, dispose: () => client.dispose() };
}

/**
 * The one-line-per-command replacement for `withDaemon`: resolves the
 * backend for `commandId` (per `resolveBackendMode`/`options.forcedMode`),
 * runs `fn` against it, and on any thrown error (acquisition or `fn`) prints
 * it via `printError` and sets `process.exitCode` instead of an uncaught
 * stack trace. Always disposes the backend, success or failure.
 */
export async function withBackend(
  commandId: CommandId,
  json: boolean,
  fn: (backend: WindowerBackend) => Promise<void>,
  options: WithBackendOptions = {},
): Promise<void> {
  let acquired: AcquiredBackend | undefined;
  try {
    acquired = await acquireBackend(commandId, options);
    await fn(acquired.instance);
  } catch (err) {
    process.exitCode = printError(json, err);
  } finally {
    acquired?.dispose();
  }
}

/**
 * Resolves the `--daemon`/`--no-daemon`/`WINDOWER_BACKEND=local|daemon`
 * debugging escape hatches (`contracts/cli.md` "Daemon policy") into a
 * forced mode, or `undefined` if neither applies. An explicit CLI flag on
 * this invocation wins over the environment variable. Commands should read
 * this from `cmd.optsWithGlobals()` (the `--daemon`/`--no-daemon` pair is
 * registered once, on the root program) so it also resolves correctly for
 * nested subcommands (`daemon restart`, `operate status`, etc.).
 */
export function resolveForcedMode(opts: { daemon?: boolean }): "local" | "daemon" | undefined {
  if (opts.daemon === true) return "daemon";
  if (opts.daemon === false) return "local";
  const fromEnv = process.env.WINDOWER_BACKEND;
  if (fromEnv === "local" || fromEnv === "daemon") return fromEnv;
  return undefined;
}

// ---- stop/cancel's attach-mode dead-owner fallback ----

export interface OrphanFallbackResult {
  sessionId: string;
  /** The session's state after this call. Equal to `requestedTerminalState` unless the session was already terminal, in which case its existing terminal state is left untouched and reported here. */
  state: SessionState;
  /** `true` when the session was already in a terminal state and this call was a no-op. */
  alreadyTerminal: boolean;
}

const NON_TERMINAL_STATES: readonly SessionState[] = ["pending", "recording", "stopping"];

/**
 * `stop`/`cancel`'s `attach`-mode dead-owner fallback
 * (`phase-20-daemon-optional.md` "attach is the mode that makes stop/cancel
 * correct", `contracts/cli.md`'s `stop` section): because `start` always
 * spawns a daemon, a session in `pending`/`recording`/`stopping` state
 * always has a live daemon owner — so if `attach` mode finds nothing
 * listening, that owner is dead. Reads the session directly from disk (no
 * daemon involved) and, if it's non-terminal, marks it `terminalState`
 * locally instead of spawning a fresh daemon that would just answer
 * `SESSION_NOT_FOUND`. Throws `SESSION_NOT_FOUND` if the session doesn't
 * exist on disk at all.
 */
export async function markOrphanedSessionTerminal(
  sessionId: string,
  terminalState: "failed" | "canceled",
): Promise<OrphanFallbackResult> {
  const store = new SessionStore();
  await store.load();
  const session = store.get(sessionId);
  if (!session) {
    throw new DaemonError("SESSION_NOT_FOUND", `Session "${sessionId}" not found`);
  }
  if (!NON_TERMINAL_STATES.includes(session.state)) {
    return { sessionId, state: session.state, alreadyTerminal: true };
  }

  await store.save({
    ...session,
    state: terminalState,
    stoppedAt: new Date().toISOString(),
    error: {
      code: "DAEMON_UNREACHABLE",
      message:
        "No daemon was reachable to finalize this session — its owning daemon appears to have " +
        `died. Marked ${terminalState} locally by \`windower ${terminalState === "failed" ? "stop" : "cancel"}\`.`,
    },
  });
  return { sessionId, state: terminalState, alreadyTerminal: false };
}

export function renderOrphanFallback(result: OrphanFallbackResult): string {
  if (result.alreadyTerminal) {
    return `Session ${result.sessionId} is already ${result.state} — nothing to do.`;
  }
  return `No daemon is running. Session ${result.sessionId} marked ${result.state} locally (its owning daemon appears to have died).`;
}

/**
 * `stop`/`cancel`'s full `attach` flow: try a real daemon RPC through `fn`
 * first; if nothing is listening (`DaemonError` `DAEMON_UNREACHABLE`), fall
 * back to `markOrphanedSessionTerminal` and report that as the command's
 * (successful) result instead of a confusing daemon-unreachable error. Any
 * other error from acquiring the connection or from `fn` prints normally via
 * `printError`, matching `withBackend`'s behavior.
 */
export async function withAttachBackend(
  commandId: CommandId,
  json: boolean,
  sessionId: string,
  terminalState: "failed" | "canceled",
  fn: (client: DaemonClient) => Promise<void>,
): Promise<void> {
  let client: DaemonClient | undefined;
  try {
    client = await connectToDaemon();
    await fn(client);
  } catch (err) {
    if (err instanceof DaemonError && err.code === "DAEMON_UNREACHABLE") {
      try {
        const result = await markOrphanedSessionTerminal(sessionId, terminalState);
        printResult(json, result, renderOrphanFallback);
      } catch (fallbackErr) {
        process.exitCode = printError(json, fallbackErr);
      }
      return;
    }
    process.exitCode = printError(json, err);
  } finally {
    client?.dispose();
  }
}
