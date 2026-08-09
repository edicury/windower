import {
  type CancelRecordingResult,
  DaemonError,
  type StopRecordingResult,
  type WindowerBackend,
} from "@windower/core";
import type { Command } from "commander";
import { withBackend } from "../backend.js";
import { printResult } from "../output.js";
import { renderCancelResult } from "./cancel.js";
import {
  type SharedRecordingOpts,
  addSharedRecordingFlags,
  buildStartRecordingParams,
} from "./record-params.js";
import { renderStopResult } from "./stop.js";

interface RecordOpts extends SharedRecordingOpts {
  duration: string;
  discard?: boolean;
}

/**
 * `windower record [shared flags] --duration <seconds> [--discard] [--json]`
 * — contracts/cli.md. Convenience wrapper: `start` + sleep `duration`
 * seconds + `stop`, blocking. Per CLAUDE.md, this is sugar — `start`/`stop`
 * (no duration, non-blocking) is the primary agent-facing flow, used when
 * the agent needs to act mid-recording.
 *
 * Per `phase-20-daemon-optional.md`/`contracts/cli.md`: runs entirely
 * `local` — no daemon is started or contacted, and NOT overridable via
 * `--daemon`/`WINDOWER_BACKEND` (unlike every other command routed through
 * `withBackend`, this call never passes `forcedMode`). The CLI process
 * itself holds a single `LocalWindower` for the recording's whole life
 * (`withBackend`'s `fn` spans `start` through Ctrl-C/duration-elapsed
 * through `stop`/`cancel`).
 *
 * Ctrl-C semantics: the first Ctrl-C finalizes the in-flight recording
 * (video/manifest/event timeline all land, same as a normal `stop`); a
 * second Ctrl-C sent before the first has finished finalizing cancels/
 * discards it instead (same as `cancel` — no output file). `--discard`
 * makes the first Ctrl-C cancel outright, for scripted callers that would
 * rather discard than keep a partial recording.
 */
export function registerRecordCommand(program: Command): void {
  addSharedRecordingFlags(
    program
      .command("record")
      .description("Convenience wrapper: start + sleep <duration> + stop, blocking")
      .requiredOption("--duration <seconds>", "recording duration in seconds")
      .option("--discard", "cancel (discard) instead of finalize on the first Ctrl-C"),
  ).action(async (opts: RecordOpts) => {
    const json = Boolean(opts.json);
    // Deliberately no `forcedMode` — `record` is `local` unconditionally,
    // per contracts/cli.md's Daemon policy ("record | local", not
    // overridable). `--daemon`/`WINDOWER_BACKEND` are simply ignored here.
    await withBackend("record", json, async (backend) => {
      const durationSeconds = Number(opts.duration);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new DaemonError(
          "INVALID_ARGS",
          `Invalid --duration "${opts.duration}" — expected a positive number of seconds`,
        );
      }

      const startParams = buildStartRecordingParams(opts);
      const { sessionId } = await backend.startRecording(startParams);

      const outcome = await runInterruptibleRecording(
        backend,
        sessionId,
        durationSeconds * 1000,
        Boolean(opts.discard),
      );

      if (outcome.error !== undefined) throw outcome.error;

      if (outcome.canceled) {
        printResult(json, outcome.result as CancelRecordingResult, () =>
          [
            renderCancelResult(sessionId, outcome.result as CancelRecordingResult),
            "  (discarded via --discard or a second Ctrl-C before finalizing completed)",
          ].join("\n"),
        );
        return;
      }
      printResult(json, outcome.result as StopRecordingResult, renderRecordResult);
    });
  });
}

interface RecordRunOutcome {
  canceled: boolean;
  result?: StopRecordingResult | CancelRecordingResult;
  error?: unknown;
}

/**
 * Runs `backend.stopRecording`/`cancelRecording` for `sessionId` after
 * either `durationMs` elapses or SIGINT is received, implementing `record`'s
 * Ctrl-C semantics documented on `registerRecordCommand`. Exported for
 * tests, which fire synthetic `SIGINT` events instead of waiting out a real
 * duration.
 */
export function runInterruptibleRecording(
  backend: WindowerBackend,
  sessionId: string,
  durationMs: number,
  discardOnFirstSignal: boolean,
): Promise<RecordRunOutcome> {
  return new Promise<RecordRunOutcome>((resolve) => {
    let phase: "waiting" | "finalizing" | "settled" = "waiting";
    let settled = false;

    const settle = (outcome: RecordRunOutcome) => {
      if (settled) return;
      settled = true;
      phase = "settled";
      process.removeListener("SIGINT", onSigint);
      resolve(outcome);
    };

    const finalize = () => {
      phase = "finalizing";
      backend
        .stopRecording({ sessionId })
        .then((result) => settle({ canceled: false, result }))
        .catch((error) => settle({ canceled: false, error }));
    };

    const discard = () => {
      backend
        .cancelRecording({ sessionId })
        .then((result) => settle({ canceled: true, result }))
        .catch((error) => settle({ canceled: true, error }));
    };

    const onSigint = () => {
      if (phase === "waiting") {
        clearTimeout(timer);
        if (discardOnFirstSignal) {
          discard();
        } else {
          finalize();
        }
        return;
      }
      if (phase === "finalizing") {
        // Second Ctrl-C, sent before the first (finalize) has settled —
        // discard instead. `settle` only resolves once, so if `finalize`'s
        // in-flight `stopRecording` call happens to win the race anyway,
        // this `discard` call's result is simply dropped.
        discard();
      }
    };

    process.on("SIGINT", onSigint);
    const timer = setTimeout(finalize, durationMs);
  });
}

export function renderRecordResult(result: StopRecordingResult): string {
  return renderStopResult(result);
}
