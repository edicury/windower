import { DaemonError, type RecordingSession } from "@windower/core";
import { SessionStore } from "@windower/engine";
import type { Command } from "commander";
import { printError, printResult } from "../output.js";

/**
 * `windower status <sessionId> [--json]` — contracts/cli.md. Returns the
 * current `RecordingSession`. Per `phase-20-daemon-optional.md`: a "plain
 * disk read" — `~/.windower/sessions/<id>.json` is the durable record, so
 * this reads `SessionStore` directly rather than going through any backend
 * (no daemon started, contacted, or required).
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status <sessionId>")
    .description("Report the current state of a recording session")
    .option("--json", "output JSON")
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const store = new SessionStore();
        await store.load();
        const session = store.get(sessionId);
        if (!session) {
          throw new DaemonError("SESSION_NOT_FOUND", `Session "${sessionId}" not found`);
        }
        printResult(json, session, renderStatus);
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });
}

function formatElapsed(startedAt: string, endedAt: string): string {
  const ms = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts.map((p) => String(p).padStart(2, "0")).join(":");
}

function targetSummary(session: RecordingSession): string {
  const { target } = session;
  switch (target.kind) {
    case "display":
      return `display ${target.id} (${target.name})`;
    case "window":
      return `window ${target.id} (${target.title} — ${target.appName})`;
    case "region":
      return `region on display ${target.displayId}`;
  }
}

export function renderStatus(session: RecordingSession): string {
  const elapsed = formatElapsed(session.startedAt, session.stoppedAt ?? new Date().toISOString());
  const lines = [
    `Session ${session.id}: ${session.state}`,
    `  Target: ${targetSummary(session)}`,
    `  Elapsed: ${elapsed}`,
  ];
  if (session.error) {
    lines.push(`  Error: [${session.error.code}] ${session.error.message}`);
  }
  if (session.outputPath) {
    lines.push(`  Output: ${session.outputPath}`);
  }
  return lines.join("\n");
}
