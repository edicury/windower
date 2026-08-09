import {
  type AbortOperatorRunResult,
  DaemonError,
  type ListOperatorRunsResult,
  type OperatorRun,
  type RunOperatorResult,
  formatModelConfig,
  readRawConfig,
} from "@windower/core";
import { OperatorRunStore } from "@windower/engine";
import type { Command } from "commander";
import { resolveForcedMode, withBackend } from "../backend.js";
import { withDaemon } from "../daemon.js";
import { printError, printResult } from "../output.js";
import {
  type OperateOpts,
  addOperateFlags,
  buildRunOperatorParams,
  parseSecretRefs,
  secretWarnings,
} from "./operate-params.js";
import { addSharedRecordingFlags } from "./record-params.js";

/**
 * `windower operate "<task>" [recording flags] [--model p:m] [--base-url u]
 * [--secret name=source:ref]... [--max-steps n] [--timeout s] [--unbounded]
 * [--no-record] [--json]` plus `operate status|abort|list` — contracts/cli.md.
 *
 * Non-blocking, exactly like `start`: contracts/cli.md says `operate`
 * "Returns immediately with `{ runId }` — same non-blocking two-call shape as
 * `start`/`stop`", so this command does **not** follow or stream the run.
 * Human-readable output prints the runId plus the `operate status`/`operate
 * abort` follow-ups; `--json` prints the bare `{ runId }` daemon result.
 *
 * The recording flags are `addSharedRecordingFlags` verbatim (per the phase
 * brief — not redefined here); `operate`-only flags come from
 * `addOperateFlags`.
 */
/**
 * Resolves `--json` for an `operate` **subcommand**.
 *
 * `operate` itself declares `--json` (via `addSharedRecordingFlags`), and each
 * subcommand declares its own. When a parent and child declare the same flag,
 * Commander binds the parsed value to the *parent* — so a subcommand's own
 * `opts.json` is always `undefined` and `operate status --json` would silently
 * print human output. Read the child's value first (in case that behavior ever
 * changes) and fall back to the parent's.
 */
export function jsonFlag(opts: { json?: boolean }, cmd: Command): boolean {
  return Boolean(opts.json ?? (cmd.parent?.opts() as { json?: boolean } | undefined)?.json);
}

export function registerOperateCommand(program: Command): void {
  const operate = program
    .command("operate")
    .description("Run a guided operator: one natural-language task, driven and recorded end-to-end")
    // Optional (not `<task>`) so `operate status|abort|list` dispatch cleanly;
    // emptiness is validated in `buildRunOperatorParams`.
    .argument("[task]", "the natural-language instruction to carry out");

  addOperateFlags(addSharedRecordingFlags(operate)).action(
    async (task: string | undefined, opts: OperateOpts) => {
      const json = Boolean(opts.json);
      await withDaemon(json, async (client) => {
        if (task === undefined) {
          throw new DaemonError(
            "INVALID_ARGS",
            'A <task> is required, e.g. windower operate "Open the app and create an incident"',
          );
        }

        for (const warning of secretWarnings(parseSecretRefs(opts.secret ?? []))) {
          process.stderr.write(`${warning}\n`);
        }

        const config = await readRawConfig();
        const params = buildRunOperatorParams(task, opts, config.operator ?? {});
        const result = await client.runOperator(params);
        printResult(json, result, renderRunOperatorResult);
      });
    },
  );

  // `operate status`/`operate list` are `local` mode per contracts/cli.md's
  // Daemon policy — plain disk reads of `~/.windower/operator-runs/*.json`
  // via `OperatorRunStore`, no backend/daemon involved at all (same
  // treatment as `windower status`/`windower list`). `operate abort` stays
  // `daemon` mode (only meaningful against a detached run).
  operate
    .command("status <runId>")
    .description("Report the current state of an operator run")
    .option("--json", "output JSON")
    .action(async (runId: string, opts: { json?: boolean }, cmd: Command) => {
      const json = jsonFlag(opts, cmd);
      try {
        const store = new OperatorRunStore();
        await store.load();
        const run = store.get(runId);
        if (!run) {
          throw new DaemonError("OPERATOR_RUN_NOT_FOUND", `Operator run "${runId}" not found`);
        }
        printResult(json, run, renderOperatorRun);
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });

  operate
    .command("abort <runId>")
    .description("Abort an in-progress operator run (any active recording is finalized, not lost)")
    .option("--json", "output JSON")
    .action(async (runId: string, opts: { json?: boolean }, cmd: Command) => {
      const json = jsonFlag(opts, cmd);
      const forcedMode = resolveForcedMode(cmd.optsWithGlobals());
      await withBackend(
        "operate abort",
        json,
        async (backend) => {
          const result = await backend.abortOperatorRun({ runId });
          printResult(json, result, () => renderAbortResult(runId, result));
        },
        { forcedMode },
      );
    });

  operate
    .command("list")
    .description("List known operator runs, most recent first")
    .option("--state <state>", "filter by run state")
    .option("--json", "output JSON")
    .action(async (opts: { state?: string; json?: boolean }, cmd: Command) => {
      const json = jsonFlag(opts, cmd);
      try {
        const store = new OperatorRunStore();
        await store.load();
        const state = opts.state as OperatorRun["state"] | undefined;
        const runs = store.list(state);
        const sorted: ListOperatorRunsResult = { runs: sortByStartedAtDesc(runs) };
        printResult(json, sorted, renderOperatorRunsTable);
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });
}

export function renderRunOperatorResult(result: RunOperatorResult): string {
  return [
    `Started operator run ${result.runId}`,
    "  The run continues in the background — this command does not wait for it.",
    `  Poll:  windower operate status ${result.runId}`,
    `  Abort: windower operate abort ${result.runId}`,
  ].join("\n");
}

export function renderAbortResult(runId: string, _result: AbortOperatorRunResult): string {
  return `Aborted operator run ${runId}`;
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

/** Mirrors `status`'s `renderStatus` layout, for an `OperatorRun` instead of a `RecordingSession`. */
export function renderOperatorRun(run: OperatorRun): string {
  const elapsed = formatElapsed(run.startedAt, run.endedAt ?? new Date().toISOString());
  const lines = [
    `Operator run ${run.id}: ${run.state}`,
    `  Task: ${run.task}`,
    `  Model: ${formatModelConfig(run.model)}`,
    `  Steps: ${run.steps.length}`,
    `  Elapsed: ${elapsed}`,
  ];
  if (run.sessionId) lines.push(`  Session: ${run.sessionId}`);
  if (run.error) lines.push(`  Error: [${run.error.code}] ${run.error.message}`);
  if (run.transcriptPath) lines.push(`  Transcript: ${run.transcriptPath}`);
  return lines.join("\n");
}

/** "Most recent first" — sorted once so `--json` and human output share an order. */
function sortByStartedAtDesc(runs: OperatorRun[]): OperatorRun[] {
  return [...runs].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
}

/** Same column-padded table style as `windower list`'s `renderSessionsTable`. */
export function renderOperatorRunsTable(result: ListOperatorRunsResult): string {
  if (result.runs.length === 0) return "No operator runs found.";

  const rows = result.runs.map((r) => [
    r.id,
    r.state,
    formatModelConfig(r.model),
    String(r.steps.length),
    truncate(r.task, 40),
    r.startedAt,
  ]);
  const header = ["ID", "STATE", "MODEL", "STEPS", "TASK", "STARTED"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  return [formatRow(header), ...rows.map(formatRow)].join("\n");
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
