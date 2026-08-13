import { DaemonError, type DaemonErrorCode } from "@windower/core";

/**
 * Process exit codes for the `windower` CLI. Small deterministic map, not a
 * switch duplicated per command — every command's `catch` funnels through
 * `exitCodeForError` (see `output.ts`'s `printError`).
 *
 *   0 — success
 *   1 — generic/unknown failure (default for any code not called out below,
 *       e.g. TARGET_NOT_FOUND, RESIZE_UNSUPPORTED, CAPTURE_FAILED,
 *       UNSUPPORTED_CAPABILITY, SESSION_NOT_FOUND, INTERNAL_ERROR)
 *   2 — DAEMON_UNREACHABLE (contracts/cli.md: "helps scripts distinguish
 *       daemon down from bad input" — kept as its own code for exactly that)
 *   3 — INVALID_ARGS / validation failure (bad input, as opposed to daemon
 *       down or a capture-side failure)
 *   4 — OUTPUT_DIR_NOT_WRITABLE (bad `outputDir` config, caught at `start`
 *       preflight rather than after a recording completes)
 *   5 — PERMISSION_DENIED (a required OS permission — Screen Recording,
 *       Accessibility, Microphone — isn't granted; kept distinct from the
 *       generic failure code so a script/agent can react by calling
 *       `windower permission request` instead of just failing)
 *   6 — DAEMON_BUSY (Phase 20: a version-mismatch auto-restart was refused
 *       because a session is still active; recoverable by clearing the
 *       in-flight work — `windower stop <id>` — or forcing with `windower
 *       daemon restart --force`, per contracts/daemon-rpc.md)
 *   7 — DAEMON_VERSION_MISMATCH (Phase 20: the connected daemon's protocol
 *       version disagrees with the client's and an auto-restart either
 *       wasn't attempted or didn't resolve it, including a `windowerHome`
 *       disagreement surfaced during `hello`; recoverable by `windower
 *       daemon restart`)
 */
export const EXIT_SUCCESS = 0;
export const EXIT_GENERIC_FAILURE = 1;
export const EXIT_DAEMON_UNREACHABLE = 2;
export const EXIT_INVALID_ARGS = 3;
export const EXIT_OUTPUT_DIR_NOT_WRITABLE = 4;
export const EXIT_PERMISSION_DENIED = 5;
export const EXIT_DAEMON_BUSY = 6;
export const EXIT_DAEMON_VERSION_MISMATCH = 7;

const DAEMON_ERROR_EXIT_CODES: Partial<Record<DaemonErrorCode, number>> = {
  DAEMON_UNREACHABLE: EXIT_DAEMON_UNREACHABLE,
  INVALID_ARGS: EXIT_INVALID_ARGS,
  OUTPUT_DIR_NOT_WRITABLE: EXIT_OUTPUT_DIR_NOT_WRITABLE,
  PERMISSION_DENIED: EXIT_PERMISSION_DENIED,
  DAEMON_BUSY: EXIT_DAEMON_BUSY,
  DAEMON_VERSION_MISMATCH: EXIT_DAEMON_VERSION_MISMATCH,
};

/** Maps any thrown error to a process exit code. Unknown/non-`DaemonError` errors get `EXIT_GENERIC_FAILURE`. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof DaemonError) {
    return DAEMON_ERROR_EXIT_CODES[err.code] ?? EXIT_GENERIC_FAILURE;
  }
  return EXIT_GENERIC_FAILURE;
}
