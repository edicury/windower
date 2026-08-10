import {
  type AbortOperatorRunResult,
  DaemonError,
  type ListOperatorRunsResult,
  type OperatorRun,
  type RunOperatorResult,
  buildOperatorHelloEnv,
  formatModelConfig,
  readRawConfig,
} from "@windower/core";
import { OperatorRunStore } from "@windower/engine";
import type { Command } from "commander";
import { resolveForcedMode, withBackend } from "../backend.js";
import { EXIT_GENERIC_FAILURE } from "../exit-codes.js";
import { printError, printResult } from "../output.js";
import { renderOperatorStepLine, runOperatorBlocking } from "./operate-blocking.js";
import {
  type OperateOpts,
  addOperateFlags,
  buildRunOperatorParams,
  parseSecretRefs,
  secretWarnings,
} from "./operate-params.js";

/**
 * `windower operate "<task>" --target <id> [--kind window|display|region]
 * [--region x,y,w,h] [--model p:m] [--planner-model p:m] [--executor-model p:m]
 * [--base-url u] [--secret name=source:ref]... [--max-steps n] [--timeout s]
 * [--max-batch n] [--observe auto|ax|vision] [--max-replans n] [--unbounded]
 * [--detach] [--json]` plus `operate status|abort|list` — contracts/cli.md.
 *
 * **The operator records nothing.** It is a peer capability alongside
 * capture: it drives `--target` and emits its own run record, and behaves
 * identically whether or not something is recording the screen
 * (contracts/operator.md §Recording independence). A caller who wants video
 * around a run sequences three independent commands itself —
 * `windower start` → `windower operate` → `windower stop`.
 *
 * **Blocks by default, `local` mode** (`phase-20-daemon-optional.md` "operate
 * blocking by default"): the operator engine (`@windower/operator`'s
 * `runOperator`, loaded lazily via `operate-blocking.ts`) runs in-process for
 * the run's whole life — no daemon, no socket, no RPC. Step-by-step progress
 * streams to **stderr**
 * (`renderOperatorStepLine`); the terminal `OperatorRun` goes to **stdout**
 * under `--json` (human-readable text otherwise). A terminal state other than
 * `succeeded` exits `1` (`contracts/cli.md`: "reusing the existing 0/1/2/3
 * exit-code scheme ... no new codes are introduced").
 *
 * `--detach` restores the original non-blocking, `daemon`-mode, `{ runId }`
 * shape via `withBackend`/`resolveBackendMode("operate", { detach: true })` —
 * unchanged from Phase 19 (see `renderRunOperatorResult`).
 */
/**
 * Resolves `--json` for an `operate` **subcommand**.
 *
 * `operate` itself declares `--json` (via `addOperateFlags`), and each
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
    .description("Run a guided operator: one natural-language task, driven on one target")
    // Optional (not `<task>`) so `operate status|abort|list` dispatch cleanly;
    // emptiness is validated in `buildRunOperatorParams`.
    .argument("[task]", "the natural-language instruction to carry out");

  addOperateFlags(operate).action(
    async (task: string | undefined, opts: OperateOpts, cmd: Command) => {
      const json = Boolean(opts.json);

      if (task === undefined) {
        process.exitCode = printError(
          json,
          new DaemonError(
            "INVALID_ARGS",
            'A <task> is required, e.g. windower operate "Open the app and create an incident"',
          ),
        );
        return;
      }

      for (const warning of secretWarnings(parseSecretRefs(opts.secret ?? []))) {
        process.stderr.write(`${warning}\n`);
      }

      const config = await readRawConfig();
      const params = buildRunOperatorParams(task, opts, config.operator ?? {});

      if (opts.detach) {
        // `--detach`: original Phase 19 shape, unchanged. `daemon` mode
        // (`resolveBackendMode("operate", { detach: true })`), auto-starts a
        // daemon if needed, returns `{ runId }` immediately.
        //
        // `env` carries THIS shell's API key / `env:`-sourced secrets in
        // `hello` (`contracts/daemon-rpc.md`'s `env` section). Without it a
        // daemon spawned by some earlier, differently-configured shell
        // resolves the run's key from its own frozen `process.env` and the
        // run fails `OPERATOR_MISSING_API_KEY` even though this shell has the
        // key. Same helper the MCP server's `run_operator` uses.
        const forcedMode = resolveForcedMode(cmd.optsWithGlobals());
        const env = buildOperatorHelloEnv({ models: params.models, secrets: params.secrets });
        await withBackend(
          "operate",
          json,
          async (backend) => {
            const result = await backend.runOperator(params);
            printResult(json, result, renderRunOperatorResult);
          },
          { detach: true, forcedMode, env },
        );
        return;
      }

      await runBlocking(params, json);
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
    .description("Abort an in-progress operator run (never touches any recording)")
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

/**
 * The blocking (default) path: wires SIGINT to the operator loop's
 * `AbortSignal` — one Ctrl-C aborts the run and nothing else; a recording the
 * caller started separately keeps recording until the caller stops it — and
 * maps a non-`succeeded` terminal state to exit `1`.
 *
 * Exported for tests, which fire a synthetic `SIGINT` instead of waiting out
 * a real run (mirrors `record.ts`'s `runInterruptibleRecording` test seam).
 */
export async function runBlocking(
  params: Parameters<typeof runOperatorBlocking>[0],
  json: boolean,
): Promise<void> {
  // Registered before any `await` so a SIGINT that arrives while this
  // function's own setup (store load, target resolution) is still in flight is
  // never dropped — an `await` suspends this async function and returns
  // control to the event loop, and `process.on` only starts catching signals
  // once it has actually run.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    const run = await runOperatorBlocking(params, {
      signal: controller.signal,
      onStep: (step) => {
        process.stderr.write(`${renderOperatorStepLine(step)}\n`);
      },
    });

    printResult(json, run, renderOperatorRun);
    if (run.state !== "succeeded") {
      process.exitCode = EXIT_GENERIC_FAILURE;
    }
  } catch (err) {
    process.exitCode = printError(json, err);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
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

/**
 * Renders both model tiers (Phase 22) as a single display string — just the
 * planner when the executor is absent/identical (the single-`--model`
 * parity case), `planner: x, executor: y` when they diverge, so the common
 * case reads exactly like the pre-Phase-22 single-model display.
 */
export function formatOperatorModels(models: OperatorRun["models"]): string {
  const planner = formatModelConfig(models.planner);
  if (models.executor === undefined) return planner;
  const executor = formatModelConfig(models.executor);
  return executor === planner ? planner : `planner: ${planner}, executor: ${executor}`;
}

/** Mirrors `status`'s `renderStatus` layout, for an `OperatorRun` instead of a `RecordingSession`. */
export function renderOperatorRun(run: OperatorRun): string {
  const elapsed = formatElapsed(run.startedAt, run.endedAt ?? new Date().toISOString());
  const lines = [
    `Operator run ${run.id}: ${run.state}`,
    `  Task: ${run.task}`,
    `  Model: ${formatOperatorModels(run.models)}`,
    `  Steps: ${run.steps.length}`,
    `  Elapsed: ${elapsed}`,
  ];
  if (run.summary) lines.push(`  Summary: ${run.summary}`);
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
    formatOperatorModels(r.models),
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
