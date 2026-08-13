import { z } from "zod";

/**
 * Daemon protocol version — bumped only on a wire-incompatible change to the
 * daemon RPC surface (new required param, changed result shape, removed
 * method). Additive/backward-compatible changes do NOT bump this.
 *
 * Distinct from the sidecar protocol version (`contracts/sidecar-protocol.md`
 * `describe.version`) and from the package `version` (semver, from
 * `packageVersion()`), which changes on every release regardless of wire
 * compatibility. See `contracts/daemon-rpc.md` "DAEMON_PROTOCOL_VERSION".
 *
 * This is the first versioned release, so it starts at 1.
 */
export const DAEMON_PROTOCOL_VERSION = 1;

/**
 * Daemon identity — returned by both `hello` and `daemon_info`, and the
 * exact on-disk shape of `~/.windower/daemon.json` (`state-file.ts`'s
 * `DaemonStateFile`). Kept as one schema on purpose: `contracts/daemon-rpc.md`
 * says "hello's response and the state file are kept identical on purpose:
 * whatever doctor reads off disk without connecting is the same shape a live
 * handshake would return, so the two code paths can't drift." See
 * `data-model.md`'s "Daemon state file" section for the field-level source
 * of truth.
 */
export const DaemonIdentitySchema = z.object({
  pid: z.number().int(),
  /** From `packageVersion()`, not a hardcoded constant. */
  version: z.string(),
  /** `DAEMON_PROTOCOL_VERSION` at listen time. */
  protocolVersion: z.number().int(),
  /** ISO 8601. */
  startedAt: z.string(),
  socketPath: z.string(),
  /** Resolved `WINDOWER_HOME` the daemon is operating against. */
  windowerHome: z.string(),
  /** `process.execPath` — for diagnosing which node ran the daemon. */
  execPath: z.string(),
  /** Resolved path of the daemon's entry module. */
  entryPath: z.string(),
});
export type DaemonIdentity = z.infer<typeof DaemonIdentitySchema>;

/**
 * Scoped env snapshot carried by `hello` — never `process.env` wholesale.
 * Shape per `data-model.md`'s `DaemonHelloRequest.env`: a model's
 * configured API-key var (name + value) plus any `env:`-sourced `SecretRef`s
 * explicitly named in the request that triggered this connection. Nothing
 * else is read or sent, and the daemon never logs this field in full or in
 * part.
 */
export const DaemonHelloEnvSchema = z.object({
  /** Name of the planner model's API-key env var, e.g. `"ANTHROPIC_API_KEY"`. */
  apiKeyEnvVar: z.string().optional(),
  /** The value itself — only ever sent when a caller opts a request into `env` scoping. */
  apiKeyValue: z.string().optional(),
  /** A second model tier's API-key env var, only when it differs from the primary's. */
  executorApiKeyEnvVar: z.string().optional(),
  /** A second model tier's API-key value, only when `executorApiKeyEnvVar` is present. */
  executorApiKeyValue: z.string().optional(),
  /** Resolved env-sourced secret references named in this request only. */
  secretRefs: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});
export type DaemonHelloEnv = z.infer<typeof DaemonHelloEnvSchema>;

/**
 * Client -> daemon, first call on every new connection
 * (`ensureDaemonRunning` in `connect.ts`), before any other RPC on that
 * connection.
 *
 * Field-name note: `data-model.md`'s `DaemonHelloRequest` names this field
 * `protocolVersion`; `contracts/daemon-rpc.md`'s wire example names it
 * `clientProtocolVersion`. `data-model.md` is this repo's stated source of
 * truth for Zod shapes ("Zod shapes are the source of truth in data-model.md
 * even when the RPC method semantics ... live in contracts/*.md"), so this
 * schema follows it: `protocolVersion`. `cwd` is included per
 * `contracts/daemon-rpc.md` (threaded into the per-connection
 * `RequestContext` for relative-path resolution) even though it is not
 * listed in `data-model.md`'s current `DaemonHelloRequest` — both documents
 * agree it must exist, they just disagree on whether it's shown.
 */
export const DaemonHelloRequestSchema = z.object({
  /** e.g. `"windower-cli"` | `"windower-mcp-server"`. */
  clientName: z.string(),
  clientVersion: z.string(),
  /** Client's compiled-in `DAEMON_PROTOCOL_VERSION`. */
  protocolVersion: z.number().int(),
  /** Client's resolved `WINDOWER_HOME` — compared against the daemon's; mismatch is an error. */
  windowerHome: z.string(),
  /** Client's cwd — used to resolve relative paths (e.g. `outputDir`) against the caller, not the daemon process. */
  cwd: z.string(),
  env: DaemonHelloEnvSchema.optional(),
});
export type DaemonHelloRequest = z.infer<typeof DaemonHelloRequestSchema>;

/**
 * Daemon -> client, response to `hello`. Same shape as `DaemonIdentity`
 * (== `daemon_info`'s result == `~/.windower/daemon.json`) — see
 * `DaemonIdentitySchema`'s doc for why these are kept identical.
 */
export const DaemonHelloResultSchema = DaemonIdentitySchema;
export type DaemonHelloResult = DaemonIdentity;

/**
 * `daemon_info` — read-only introspection, no handshake, no env snapshot,
 * no side effects. Used by `windower doctor` to probe whether a daemon is
 * listening without spawning one or exchanging secret material.
 */
export const DaemonInfoParamsSchema = z.object({});
export type DaemonInfoParams = z.infer<typeof DaemonInfoParamsSchema>;

/** Identical shape to `hello`'s result. */
export const DaemonInfoResultSchema = DaemonIdentitySchema;
export type DaemonInfoResult = DaemonIdentity;
