import { EXPECTED_SIDECAR_VERSION, type PermissionReport } from "@windower/core";
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

const PERMISSION_HINTS: Array<{
  key: "screenRecording" | "accessibility" | "microphone";
  label: string;
}> = [
  { key: "screenRecording", label: "Screen Recording" },
  { key: "accessibility", label: "Accessibility" },
  { key: "microphone", label: "Microphone" },
];

export function renderReport(report: PermissionReport): string {
  const lines = ["windower doctor"];
  for (const { key, label } of PERMISSION_HINTS) {
    const status = report[key];
    lines.push(`  ${checkbox(status === "granted")} ${label}: ${status}`);
    if (status !== "granted" && status !== "not_applicable") {
      lines.push(`      → run \`windower permission request ${key}\` to grant it`);
    }
  }
  lines.push(`  ${checkbox(report.daemonRunning)} Daemon running`);
  const versionMismatch =
    report.sidecarVersion !== undefined && report.sidecarVersion !== EXPECTED_SIDECAR_VERSION;
  lines.push(
    `  ${checkbox(report.sidecarAvailable)} Sidecar available${
      report.sidecarVersion ? ` (v${report.sidecarVersion})` : ""
    }`,
  );
  if (versionMismatch) {
    lines.push(
      `      ⚠ version mismatch: this CLI expects v${EXPECTED_SIDECAR_VERSION} — ` +
        "reinstall/rebuild the sidecar to match, or you may see confusing protocol errors",
    );
  }
  return lines.join("\n");
}
