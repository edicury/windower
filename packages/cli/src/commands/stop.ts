import { DaemonError, type StopRecordingResult } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";

export interface StopOpts {
  narration?: string;
  narrationOffset?: string;
  json?: boolean;
}

/**
 * Builds the `stop_recording` `narration` param from `--narration <file>
 * --narration-offset <ms>`. Both must be given together or neither — see
 * contracts/cli.md's `stop` section.
 */
export function buildNarrationParam(
  opts: Pick<StopOpts, "narration" | "narrationOffset">,
): { filePath: string; offsetMs: number } | undefined {
  const hasFile = opts.narration !== undefined;
  const hasOffset = opts.narrationOffset !== undefined;

  if (hasFile !== hasOffset) {
    throw new DaemonError(
      "INVALID_ARGS",
      "--narration and --narration-offset must be given together",
    );
  }
  if (!hasFile) return undefined;

  const offsetMs = Number(opts.narrationOffset);
  if (!Number.isFinite(offsetMs)) {
    throw new DaemonError(
      "INVALID_ARGS",
      `Invalid --narration-offset "${opts.narrationOffset}" — expected a number`,
    );
  }

  // biome-ignore lint/style/noNonNullAssertion: hasFile guarantees this is set
  return { filePath: opts.narration!, offsetMs };
}

/** `windower stop <sessionId> [--narration <file> --narration-offset <ms>] [--json]` — contracts/cli.md. */
export function registerStopCommand(program: Command): void {
  program
    .command("stop <sessionId>")
    .description("Finalize a recording session")
    .option("--narration <file>", "narration audio file to mix in")
    .option("--narration-offset <ms>", "narration offset in milliseconds")
    .option("--json", "output JSON")
    .action(async (sessionId: string, opts: StopOpts) => {
      const json = Boolean(opts.json);
      await withDaemon(json, async (client) => {
        const narration = buildNarrationParam(opts);
        const result = await client.stopRecording({
          sessionId,
          ...(narration !== undefined ? { narration } : {}),
        });
        printResult(json, result, renderStopResult);
      });
    });
}

export function renderStopResult(result: StopRecordingResult): string {
  const lines = [`Output: ${result.outputPath}`, `Manifest: ${result.manifestPath}`];
  if (result.eventTimelinePath) {
    lines.push(`Event timeline: ${result.eventTimelinePath}`);
  }
  return lines.join("\n");
}
