import type { PermissionReport } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";

/** `windower doctor [--json]` — PermissionReport + daemon/sidecar health, read-only, never prompts. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Report permission and daemon/sidecar health (read-only, never triggers a prompt)")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      await withDaemon(json, async (client) => {
        const report = await client.checkPermissions();
        printResult(json, report, renderReport);
      });
    });
}

function checkbox(ok: boolean): string {
  return ok ? "[x]" : "[ ]";
}

export function renderReport(report: PermissionReport): string {
  const lines = [
    "windower doctor",
    `  ${checkbox(report.screenRecording === "granted")} Screen Recording: ${report.screenRecording}`,
    `  ${checkbox(report.accessibility === "granted")} Accessibility: ${report.accessibility}`,
    `  ${checkbox(report.microphone === "granted")} Microphone: ${report.microphone}`,
    `  ${checkbox(report.daemonRunning)} Daemon running`,
    `  ${checkbox(report.sidecarAvailable)} Sidecar available${
      report.sidecarVersion ? ` (v${report.sidecarVersion})` : ""
    }`,
  ];
  return lines.join("\n");
}
