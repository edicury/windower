import { DaemonError, type StopRecordingResult } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";
import {
  type SharedRecordingOpts,
  addSharedRecordingFlags,
  buildStartRecordingParams,
} from "./record-params.js";
import { renderStopResult } from "./stop.js";

interface RecordOpts extends SharedRecordingOpts {
  duration: string;
}

/**
 * `windower record [shared flags] --duration <seconds> [--json]` —
 * contracts/cli.md. Blocking convenience wrapper: `start` + sleep
 * `duration` seconds + `stop`. Per CLAUDE.md, this is sugar — `start`/`stop`
 * (no duration, non-blocking) is the primary agent-facing flow, used when
 * the agent needs to act mid-recording.
 */
export function registerRecordCommand(program: Command): void {
  addSharedRecordingFlags(
    program
      .command("record")
      .description("Convenience wrapper: start + sleep <duration> + stop, blocking")
      .requiredOption("--duration <seconds>", "recording duration in seconds"),
  ).action(async (opts: RecordOpts) => {
    const json = Boolean(opts.json);
    await withDaemon(json, async (client) => {
      const durationSeconds = Number(opts.duration);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new DaemonError(
          "INVALID_ARGS",
          `Invalid --duration "${opts.duration}" — expected a positive number of seconds`,
        );
      }

      const startParams = buildStartRecordingParams(opts);
      const { sessionId } = await client.startRecording(startParams);

      await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));

      const result = await client.stopRecording({ sessionId });
      printResult(json, result, renderRecordResult);
    });
  });
}

export function renderRecordResult(result: StopRecordingResult): string {
  return renderStopResult(result);
}
