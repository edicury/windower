/**
 * The single command/tool-id -> backend-mode map, transcribed verbatim from
 * `contracts/cli.md`'s "Daemon policy" section (source of truth — do not
 * edit this table without updating that doc first, per `CLAUDE.md`'s
 * "protocol/contract before platform/implementation" rule).
 *
 * - `local`   — runs entirely in the invoking process (or a one-shot
 *               transient sidecar spawn). No daemon started/contacted.
 * - `daemon`  — auto-starts a daemon if none is listening (`ensureDaemonRunning`,
 *               version handshake + spawn lock), then RPCs it.
 * - `attach`  — connects only if a daemon is already listening; never
 *               spawns. Falls back to a local, best-effort resolution
 *               (e.g. marking an orphaned session failed/canceled) when
 *               nothing is listening.
 *
 * Consumed identically by `packages/cli` and `packages/mcp-server` so the
 * routing decision lives in exactly one place — see
 * `contracts/daemon-rpc.md`'s "Shared backend infrastructure" section.
 */
export type BackendMode = "local" | "daemon" | "attach";

/**
 * Command ids as named in `contracts/cli.md`'s Daemon policy table. Where
 * the CLI's Commander subcommand differs from the MCP tool name, both are
 * covered by the same policy entry — the table is keyed on this CLI-facing
 * id, which is what `resolveBackendMode` and `POLICY_TABLE` operate on.
 */
export type CommandId =
  | "record"
  | "targets"
  | "doctor"
  | "permission request"
  | "resize"
  | "status"
  | "list"
  | "config get"
  | "config set"
  | "operate"
  | "operate status"
  | "operate list"
  | "start"
  | "operate abort"
  | "stop"
  | "cancel"
  | "daemon status"
  | "daemon stop"
  | "daemon restart";

/**
 * Flat lookup table, transcribed 1:1 from `contracts/cli.md`.
 *
 * NOTE: `operate`'s entry here is its **default** (blocking) mode, `local`.
 * `--detach` flips it to `daemon` — that nuance isn't expressible in a flat
 * per-command map, so `resolveBackendMode` below is the actual source of
 * truth for `operate`; this table alone is sufficient for every other
 * command, all of which have exactly one mode regardless of flags.
 */
export const POLICY_TABLE: Record<CommandId, BackendMode> = {
  record: "local",
  targets: "local",
  doctor: "local",
  "permission request": "local",
  resize: "local",
  status: "local",
  list: "local",
  "config get": "local",
  "config set": "local",
  operate: "local",
  "operate status": "local",
  "operate list": "local",
  start: "daemon",
  "operate abort": "daemon",
  stop: "attach",
  cancel: "attach",
  "daemon status": "attach",
  "daemon stop": "attach",
  "daemon restart": "attach",
};

/** Options affecting mode resolution for commands whose mode isn't a flat constant. */
export interface ResolveBackendModeOptions {
  /**
   * `windower operate --detach`: opts out of the default blocking/local
   * shape and restores the non-blocking two-call shape, `daemon` mode,
   * returning `{ runId }` immediately (`contracts/cli.md`'s `operate`
   * section). Ignored for every command other than `operate`.
   */
  detach?: boolean;
}

/**
 * Resolves the backend mode for a command, accounting for the one
 * documented flag-driven exception (`operate --detach`). Every other
 * command's mode is a flat constant from `POLICY_TABLE` and ignores
 * `opts`.
 *
 * Deliberately does NOT apply the `--daemon`/`--no-daemon`/`WINDOWER_BACKEND`
 * debugging escape hatches described in `contracts/cli.md` — those override
 * the policy table's decision at the call site (and don't apply to
 * `attach`-mode commands at all), so they belong in the CLI/MCP wiring that
 * consumes this resolver, not in the policy table itself.
 */
export function resolveBackendMode(
  command: CommandId,
  opts: ResolveBackendModeOptions = {},
): BackendMode {
  if (command === "operate" && opts.detach) {
    return "daemon";
  }
  return POLICY_TABLE[command];
}
