import type { StartRecordingResult } from "@windower/core";
import type { Command } from "commander";
import { resolveForcedMode, withBackend } from "../backend.js";
import { printResult } from "../output.js";
import {
  type SharedRecordingOpts,
  addSharedRecordingFlags,
  buildStartRecordingParams,
} from "./record-params.js";

/**
 * `windower start --target <id> [--kind window|display|region] [--region
 * x,y,w,h] [video/audio flags] [--json]` — contracts/cli.md. `daemon` mode
 * (auto-spawns if needed).
 *
 * Per CLAUDE.md's "two-call recording pattern": starts a session in the
 * background daemon and returns immediately with `{ sessionId }` — no
 * polling, no waiting for the recording to finish. The agent performs the
 * demoed actions between `start` and `stop`.
 */
export function registerStartCommand(program: Command): void {
  addSharedRecordingFlags(
    program.command("start").description("Start a recording session in the background daemon"),
  ).action(async (opts: SharedRecordingOpts, cmd: Command) => {
    const json = Boolean(opts.json);
    const forcedMode = resolveForcedMode(cmd.optsWithGlobals());
    await withBackend(
      "start",
      json,
      async (backend) => {
        const params = buildStartRecordingParams(opts);
        const result = await backend.startRecording(params);
        printResult(json, result, renderStartResult);
      },
      { forcedMode },
    );
  });
}

export function renderStartResult(result: StartRecordingResult): string {
  return `Started recording session ${result.sessionId}`;
}
