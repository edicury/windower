import { DaemonError, type DaemonRequestPermissionResult } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printError, printResult } from "../output.js";

const PERMISSION_KINDS = ["screenRecording", "accessibility", "microphone"] as const;
type PermissionKind = (typeof PERMISSION_KINDS)[number];

function isPermissionKind(value: string): value is PermissionKind {
  return (PERMISSION_KINDS as readonly string[]).includes(value);
}

/**
 * `windower permission request <screenRecording|accessibility|microphone> [--json]`
 * — contracts/cli.md. Explicitly triggers the OS permission prompt for one
 * capability, separate from `doctor` so agents don't accidentally spam
 * prompts while just checking status.
 */
export function registerPermissionCommand(program: Command): void {
  const permission = program.command("permission").description("Permission management");

  permission
    .command("request <kind>")
    .description("Explicitly trigger the OS permission prompt for one capability")
    .option("--json", "output JSON")
    .action(async (kind: string, opts: { json?: boolean }) => {
      const json = Boolean(opts.json);

      if (!isPermissionKind(kind)) {
        const err = new DaemonError(
          "INVALID_ARGS",
          `Invalid permission kind "${kind}" — expected one of: ${PERMISSION_KINDS.join(", ")}`,
        );
        process.exitCode = printError(json, err);
        return;
      }

      await withDaemon(json, async (client) => {
        const result = await client.requestPermission({ kind });
        printResult(json, result, (data) => renderPermissionResult(kind, data));
      });
    });
}

export function renderPermissionResult(
  kind: PermissionKind,
  result: DaemonRequestPermissionResult,
): string {
  return `Permission "${kind}" status: ${result.status}`;
}
