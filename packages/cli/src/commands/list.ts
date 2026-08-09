import type { CaptureTarget, ListSessionsResult, RecordingSession } from "@windower/core";
import { SessionStore } from "@windower/engine";
import type { Command } from "commander";
import { printError, printResult } from "../output.js";

/**
 * `windower list [--state recording|finalized|...] [--json]` — contracts/cli.md.
 * Per `phase-20-daemon-optional.md`: a "plain disk read" — reads
 * `~/.windower/sessions/*.json` directly via `SessionStore` (`@windower/engine`),
 * no daemon started, contacted, or required, so `windower list` keeps
 * working even with no daemon running (or ever having run).
 */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List known sessions from ~/.windower/sessions, most recent first")
    .option("--state <state>", "filter by session state")
    .option("--json", "output JSON")
    .action(async (opts: { state?: string; json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const store = new SessionStore();
        await store.load();
        const state = opts.state as RecordingSession["state"] | undefined;
        const sessions = store.list(state);
        const sorted: ListSessionsResult = { sessions: sortByStartedAtDesc(sessions) };
        printResult(json, sorted, renderSessionsTable);
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });
}

/** "Most recent first" — sorts once so both `--json` and human output reflect the same order. */
function sortByStartedAtDesc(sessions: RecordingSession[]): RecordingSession[] {
  return [...sessions].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
}

function targetSummary(target: CaptureTarget): string {
  switch (target.kind) {
    case "display":
      return `display:${target.name}`;
    case "window":
      return `window:${target.title} (${target.appName})`;
    case "region":
      return `region on ${target.displayId}`;
  }
}

export function renderSessionsTable(result: ListSessionsResult): string {
  if (result.sessions.length === 0) return "No sessions found.";

  const rows = result.sessions.map((s) => [s.id, s.state, targetSummary(s.target), s.startedAt]);
  const header = ["ID", "STATE", "TARGET", "STARTED"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  return [formatRow(header), ...rows.map(formatRow)].join("\n");
}
