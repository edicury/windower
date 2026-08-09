import { DaemonError, type DaemonErrorCode } from "@windower/core";

/**
 * Process exit codes for the `windower` CLI. Small deterministic map, not a
 * switch duplicated per command — every command's `catch` funnels through
 * `exitCodeForError` (see `output.ts`'s `printError`).
 *
 *   0 — success
 *   1 — generic/unknown failure (default for any code not called out below,
 *       e.g. TARGET_NOT_FOUND, RESIZE_UNSUPPORTED, CAPTURE_FAILED,
 *       UNSUPPORTED_CAPABILITY, SESSION_NOT_FOUND, OPERATOR_RUN_NOT_FOUND,
 *       INTERNAL_ERROR)
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
 *
 * Phase 19 (`windower operate`) deliberately adds **no** new codes —
 * contracts/cli.md: "No new exit codes are introduced for `operate`". The
 * operator failure modes map onto the existing scheme:
 *   - OPERATOR_RUN_NOT_FOUND → 1, exactly like SESSION_NOT_FOUND (an unknown
 *     id is a lookup miss, not bad syntax; `operate list` recovers from it).
 *   - guardrail-exceeded / failed run → 0 from `operate status`, because the
 *     command *succeeded* in reporting the run; the failure lives in the
 *     returned `OperatorRun.state` + `error` (same convention as `status` for
 *     a failed RecordingSession). A run that can't even be started surfaces
 *     its DaemonError and maps normally (e.g. INVALID_ARGS → 3).
 *   - permission denied (Screen Recording / Accessibility for synthetic
 *     input) → 5, the existing PERMISSION_DENIED code.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_GENERIC_FAILURE = 1;
export const EXIT_DAEMON_UNREACHABLE = 2;
export const EXIT_INVALID_ARGS = 3;
export const EXIT_OUTPUT_DIR_NOT_WRITABLE = 4;
export const EXIT_PERMISSION_DENIED = 5;

const DAEMON_ERROR_EXIT_CODES: Partial<Record<DaemonErrorCode, number>> = {
  DAEMON_UNREACHABLE: EXIT_DAEMON_UNREACHABLE,
  INVALID_ARGS: EXIT_INVALID_ARGS,
  OUTPUT_DIR_NOT_WRITABLE: EXIT_OUTPUT_DIR_NOT_WRITABLE,
  PERMISSION_DENIED: EXIT_PERMISSION_DENIED,
};

/** Maps any thrown error to a process exit code. Unknown/non-`DaemonError` errors get `EXIT_GENERIC_FAILURE`. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof DaemonError) {
    return DAEMON_ERROR_EXIT_CODES[err.code] ?? EXIT_GENERIC_FAILURE;
  }
  return EXIT_GENERIC_FAILURE;
}
