import { DaemonError, type DaemonErrorCode } from "@windower/core";

/**
 * Process exit codes for the `windower` CLI. Small deterministic map, not a
 * switch duplicated per command — every command's `catch` funnels through
 * `exitCodeForError` (see `output.ts`'s `printError`).
 *
 *   0 — success
 *   1 — generic/unknown failure (default for any code not called out below)
 *   2 — DAEMON_UNREACHABLE (contracts/cli.md: "helps scripts distinguish
 *       daemon down from bad input" — kept as its own code for exactly that)
 *   3 — INVALID_ARGS / validation failure (bad input, as opposed to daemon
 *       down or a capture-side failure)
 */
export const EXIT_SUCCESS = 0;
export const EXIT_GENERIC_FAILURE = 1;
export const EXIT_DAEMON_UNREACHABLE = 2;
export const EXIT_INVALID_ARGS = 3;

const DAEMON_ERROR_EXIT_CODES: Partial<Record<DaemonErrorCode, number>> = {
  DAEMON_UNREACHABLE: EXIT_DAEMON_UNREACHABLE,
  INVALID_ARGS: EXIT_INVALID_ARGS,
};

/** Maps any thrown error to a process exit code. Unknown/non-`DaemonError` errors get `EXIT_GENERIC_FAILURE`. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof DaemonError) {
    return DAEMON_ERROR_EXIT_CODES[err.code] ?? EXIT_GENERIC_FAILURE;
  }
  return EXIT_GENERIC_FAILURE;
}
