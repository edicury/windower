import type { DaemonHelloRequest, ResolvedSecret } from "@windower/core";

/**
 * Per-connection state captured at `hello` (`contracts/daemon-rpc.md`) and
 * threaded into anything that would otherwise read the daemon's own frozen
 * `process.env` — `SecretResolver` and `OperatorRunEngine`, per
 * `phase-20-daemon-optional.md` "Daemon lifecycle hardening". This is the
 * root fix for the bug that started that phase: a daemon spawned by one
 * shell (`spawnDaemonDetached`, `env: process.env`) must not silently answer
 * every later connection's env-dependent lookups (API keys, `env:`-sourced
 * secrets) out of *its own* environment.
 *
 * Deliberately a plain, structurally-copyable object (no live reference back
 * to the socket/connection) — a detached operator run outlives the
 * connection that started it, so callers that need it after `hello` returns
 * must snapshot it (e.g. `{ ...context.env }`) rather than hold onto the
 * connection and read it later.
 *
 * Lives in `@windower/engine` (not `apps/daemon`) because `OperatorRunEngine`
 * depends on the shape and is a daemon-free consumer too (`LocalWindower`
 * builds one directly, with no socket involved). `apps/daemon/src/server.ts`
 * — the one caller that actually parses a wire `DaemonHelloRequest` off a
 * socket — imports `buildRequestContext` from here rather than owning its
 * own copy.
 */
export interface RequestContext {
  /**
   * Scoped env-var snapshot from `hello`'s `env.apiKeyEnvVar`/`apiKeyValue` —
   * at most one entry today, keyed by the model API-key var name. Never the
   * daemon's own `process.env`, and never logged.
   */
  env: NodeJS.ProcessEnv;
  /**
   * `env:`-sourced `SecretRef`s the *client* already resolved against its own
   * environment and forwarded by value (`hello.env.secretRefs`), keyed by
   * `SecretRef.name`. `SecretResolver.resolveAll`'s `forwarded` param matches
   * against this instead of re-resolving from the daemon's own env.
   */
  resolvedSecrets: ResolvedSecret[];
  /** Client's cwd — for resolving relative paths (e.g. `outputDir`) against the caller, not the daemon process. */
  cwd: string;
  /** Client's resolved `WINDOWER_HOME` — already checked against the daemon's own at `hello` time. */
  windowerHome: string;
}

/** Builds a `RequestContext` from a validated `hello` request. */
export function buildRequestContext(request: DaemonHelloRequest): RequestContext {
  const env: NodeJS.ProcessEnv = {};
  if (request.env?.apiKeyEnvVar && request.env.apiKeyValue !== undefined) {
    env[request.env.apiKeyEnvVar] = request.env.apiKeyValue;
  }
  return {
    env,
    resolvedSecrets: request.env?.secretRefs ?? [],
    cwd: request.cwd,
    windowerHome: request.windowerHome,
  };
}
