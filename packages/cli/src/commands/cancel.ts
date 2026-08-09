import type { CancelRecordingResult } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";

/** `windower cancel <sessionId> [--json]` — contracts/cli.md. Discards an in-progress recording, no output file produced. */
export function registerCancelCommand(program: Command): void {
  program
    .command("cancel <sessionId>")
    .description("Discard an in-progress recording — no output file produced")
    .option("--json", "output JSON")
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      await withDaemon(json, async (client) => {
        const result = await client.cancelRecording({ sessionId });
        printResult(json, result, (data) => renderCancelResult(sessionId, data));
      });
    });
}

export function renderCancelResult(sessionId: string, result: CancelRecordingResult): string {
  return result.canceled
    ? `Canceled recording session ${sessionId}`
    : `Failed to cancel recording session ${sessionId}`;
}
