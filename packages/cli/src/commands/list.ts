import type { CaptureTarget, ListSessionsResult, RecordingSession } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";

/**
 * `windower list [--state recording|finalized|...] [--json]` — contracts/cli.md.
 * Goes through the daemon's `list_sessions` RPC (`DaemonClient.listSessions`)
 * rather than reading `~/.windower/sessions/*.json` directly — per
 * CLAUDE.md's "session state is disk-persisted" note, `apps/daemon`'s
 * `SessionStore` already owns that directory and re-reads from disk when
 * not cached, so the daemon stays the single source of truth even for a
 * CLI command that's "really" about files on disk.
 */
export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List known sessions from ~/.windower/sessions, most recent first")
    .option("--state <state>", "filter by session state")
    .option("--json", "output JSON")
    .action(async (opts: { state?: string; json?: boolean }) => {
      const json = Boolean(opts.json);
      await withDaemon(json, async (client) => {
        const state = opts.state as RecordingSession["state"] | undefined;
        const result = await client.listSessions(state ? { state } : {});
        const sorted: ListSessionsResult = { sessions: sortByStartedAtDesc(result.sessions) };
        printResult(json, sorted, renderSessionsTable);
      });
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
