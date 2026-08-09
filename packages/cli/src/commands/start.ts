import type { StartRecordingResult } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";
import {
  type SharedRecordingOpts,
  addSharedRecordingFlags,
  buildStartRecordingParams,
} from "./record-params.js";

/**
 * `windower start --target <id> [--kind window|display|region] [--region
 * x,y,w,h] [video/audio flags] [--json]` — contracts/cli.md.
 *
 * Per CLAUDE.md's "two-call recording pattern": starts a session in the
 * background daemon and returns immediately with `{ sessionId }` — no
 * polling, no waiting for the recording to finish. The agent performs the
 * demoed actions between `start` and `stop`.
 */
export function registerStartCommand(program: Command): void {
  addSharedRecordingFlags(
    program.command("start").description("Start a recording session in the background daemon"),
  ).action(async (opts: SharedRecordingOpts) => {
    const json = Boolean(opts.json);
    await withDaemon(json, async (client) => {
      const params = buildStartRecordingParams(opts);
      const result = await client.startRecording(params);
      printResult(json, result, renderStartResult);
    });
  });
}

export function renderStartResult(result: StartRecordingResult): string {
  return `Started recording session ${result.sessionId}`;
}
