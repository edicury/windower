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
  | "start"
  | "stop"
  | "cancel"
  | "daemon status"
  | "daemon stop"
  | "daemon restart"
  | "daemon kill";

/**
 * Flat lookup table, transcribed 1:1 from `contracts/cli.md`. Every command
 * here has exactly one mode regardless of flags.
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
  start: "daemon",
  stop: "attach",
  cancel: "attach",
  "daemon status": "attach",
  "daemon stop": "attach",
  "daemon restart": "attach",
  // `daemon kill` is the one command in this table that doesn't actually fit
  // any of the three modes' definitions above: it never opens the socket at
  // all (that's the whole point — it's the fallback for when the socket is
  // unreachable/hung), reading `daemon.json`/`sidecar-pids.json` directly
  // and force-killing by OS pid instead. `local` is the closest fit ("runs
  // entirely in the invoking process, no daemon RPC") and keeps it covered
  // by the completeness tests (`policy.test.ts`, `cli/src/policy.test.ts`);
  // `registerDaemonCommand` does not route it through `withBackend`/
  // `acquireBackend` at all, so this entry is documentation/coverage only.
  "daemon kill": "local",
};

/** Options affecting mode resolution for commands whose mode isn't a flat constant. */
export interface ResolveBackendModeOptions {}

/**
 * Resolves the backend mode for a command. Every command's mode is a flat
 * constant from `POLICY_TABLE` and ignores `opts` — kept as a parameter for
 * call-site stability even though nothing currently varies mode by flag.
 *
 * Deliberately does NOT apply the `--daemon`/`--no-daemon`/`WINDOWER_BACKEND`
 * debugging escape hatches described in `contracts/cli.md` — those override
 * the policy table's decision at the call site (and don't apply to
 * `attach`-mode commands at all), so they belong in the CLI/MCP wiring that
 * consumes this resolver, not in the policy table itself.
 */
export function resolveBackendMode(
  command: CommandId,
  _opts: ResolveBackendModeOptions = {},
): BackendMode {
  return POLICY_TABLE[command];
}
