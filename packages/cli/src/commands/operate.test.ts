import {
  DaemonError,
  type ListOperatorRunsResult,
  type OperatorRun,
  OperatorRunSchema,
  type RunOperatorResult,
} from "@windower/core";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { EXIT_GENERIC_FAILURE, EXIT_INVALID_ARGS, exitCodeForError } from "../exit-codes.js";
import { type OperateOpts, addOperateFlags, buildRunOperatorParams } from "./operate-params.js";
import {
  jsonFlag,
  renderAbortResult,
  renderOperatorRun,
  renderOperatorRunsTable,
  renderRunOperatorResult,
} from "./operate.js";
import { addSharedRecordingFlags } from "./record-params.js";

function run(overrides: Partial<OperatorRun> = {}): OperatorRun {
  return OperatorRunSchema.parse({
    id: "op-1",
    state: "running",
    task: "Open the app and create an incident",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    steps: [],
    startedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  });
}

/**
 * Parses an `operate` argv through the real commander flag registration
 * (`addSharedRecordingFlags` + `addOperateFlags`) without touching a daemon,
 * so the flag surface itself — repeatability, `--no-*` negation, argument
 * arity — is covered, not just the param builder.
 */
function parseOperateArgv(argv: string[]): {
  task?: string;
  opts: OperateOpts;
  subcommand?: { name: string; runId?: string };
} {
  let captured: { task?: string; opts: OperateOpts } | undefined;
  let subcommand: { name: string; runId?: string } | undefined;
  const program = new Command();
  program.exitOverride();
  // Keep commander's own error text out of the test runner's output; the
  // thrown `CommanderError` is what the assertions look at.
  program.configureOutput({ writeErr: () => {} });
  const operate = program.command("operate").argument("[task]");
  addOperateFlags(addSharedRecordingFlags(operate)).action(
    (task: string | undefined, opts: OperateOpts) => {
      captured = { task, opts };
    },
  );
  // Registered exactly like the real command, so the "does a bare task still
  // reach the parent action once subcommands exist?" question is covered.
  operate.command("status <runId>").action((runId: string) => {
    subcommand = { name: "status", runId };
  });
  operate.command("list").action(() => {
    subcommand = { name: "list" };
  });

  program.parse(["node", "windower", "operate", ...argv]);
  if (subcommand) return { opts: {}, subcommand };
  if (!captured) throw new Error("action was not invoked");
  return captured;
}

describe("`operate` flag surface (commander)", () => {
  it("collects repeated --secret flags into an array", () => {
    const { opts } = parseOperateArgv([
      "t",
      "--model",
      "anthropic:claude-sonnet-5",
      "--secret",
      "user=env:DEMO_USER",
      "--secret",
      "password=keychain:waroom",
    ]);
    expect(opts.secret).toEqual(["user=env:DEMO_USER", "password=keychain:waroom"]);
  });

  it("parses the whole documented operate flag list", () => {
    const { task, opts } = parseOperateArgv([
      "Open the app and create an incident",
      "--model",
      "openai-compatible:llama3:8b",
      "--base-url",
      "http://localhost:11434/v1",
      "--max-steps",
      "12",
      "--timeout",
      "90",
      "--unbounded",
      "--no-record",
      "--fps",
      "60",
      "--resolution",
      "1920x1080",
      "--out",
      "/tmp/out",
      "--json",
    ]);
    expect(task).toBe("Open the app and create an incident");
    expect(opts.model).toBe("openai-compatible:llama3:8b");
    expect(opts.baseUrl).toBe("http://localhost:11434/v1");
    expect(opts.maxSteps).toBe("12");
    expect(opts.timeout).toBe("90");
    expect(opts.unbounded).toBe(true);
    expect(opts.record).toBe(false);
    expect(opts.json).toBe(true);

    const params = buildRunOperatorParams(task as string, opts);
    expect(params.guardrails).toEqual({ maxSteps: 12, timeoutSeconds: 90, unbounded: true });
    expect(params.recording).toEqual({
      video: {
        fps: 60,
        codec: "h264",
        container: "mp4",
        resolution: { width: 1920, height: 1080 },
        quality: "high",
        // commander's `--no-cursor` option defaults to `cursor: true`.
        showCursor: true,
      },
      outputDir: "/tmp/out",
      disabled: true,
    });
  });

  it("routes a bare task to the run action and `status`/`list` to their subcommands", () => {
    expect(parseOperateArgv(["Open the app", "--model", "anthropic:claude-sonnet-5"]).task).toBe(
      "Open the app",
    );
    expect(parseOperateArgv(["status", "op-1"]).subcommand).toEqual({
      name: "status",
      runId: "op-1",
    });
    expect(parseOperateArgv(["list"]).subcommand).toEqual({ name: "list" });
  });

  it("has no --api-key style flag (keys come from the environment only)", () => {
    expect(() => parseOperateArgv(["t", "--api-key", "sk-123"])).toThrow();
  });
});

describe("renderRunOperatorResult", () => {
  it("reports the runId and the follow-up commands, with no waiting language", () => {
    const result: RunOperatorResult = { runId: "op-9c31" };
    const output = renderRunOperatorResult(result);
    expect(output).toContain("Started operator run op-9c31");
    expect(output).toContain("windower operate status op-9c31");
    expect(output).toContain("windower operate abort op-9c31");
    expect(output).toMatch(/does not wait/);
  });
});

describe("renderOperatorRun", () => {
  it("renders state, task, model, step count and elapsed time", () => {
    const output = renderOperatorRun(
      run({
        steps: [{ index: 0, observationRef: "frame-0.png", toolCalls: [], tMs: 10 }],
        endedAt: "2026-08-09T10:01:05.000Z",
        state: "succeeded",
      }),
    );
    expect(output).toContain("Operator run op-1: succeeded");
    expect(output).toContain("Model: anthropic:claude-sonnet-5");
    expect(output).toContain("Steps: 1");
    expect(output).toContain("Elapsed: 01:05");
  });

  it("surfaces a guardrail failure's structured error", () => {
    const output = renderOperatorRun(
      run({
        state: "failed",
        endedAt: "2026-08-09T10:00:30.000Z",
        error: { code: "INPUT_OUT_OF_BOUNDS", message: "click at (5000, 12) outside target" },
      }),
    );
    expect(output).toContain("Operator run op-1: failed");
    expect(output).toContain("[INPUT_OUT_OF_BOUNDS]");
  });

  it("shows the recording session and transcript when present", () => {
    const output = renderOperatorRun(
      run({ sessionId: "sess-7", transcriptPath: "/tmp/demo.operator.json" }),
    );
    expect(output).toContain("Session: sess-7");
    expect(output).toContain("Transcript: /tmp/demo.operator.json");
  });
});

describe("renderOperatorRunsTable", () => {
  it("reports no runs found for an empty list", () => {
    expect(renderOperatorRunsTable({ runs: [] })).toBe("No operator runs found.");
  });

  it("renders a header and one row per run", () => {
    const result: ListOperatorRunsResult = {
      runs: [run({ id: "op-a", state: "aborted" })],
    };
    const lines = renderOperatorRunsTable(result).split("\n");
    expect(lines[0]).toMatch(/ID/);
    expect(lines[0]).toMatch(/STATE/);
    expect(lines[0]).toMatch(/MODEL/);
    expect(lines[1]).toContain("op-a");
    expect(lines[1]).toContain("aborted");
    expect(lines[1]).toContain("anthropic:claude-sonnet-5");
  });
});

describe("renderAbortResult", () => {
  it("names the aborted run", () => {
    expect(renderAbortResult("op-2", { aborted: true })).toBe("Aborted operator run op-2");
  });
});

describe("operator exit-code mapping", () => {
  it("maps OPERATOR_RUN_NOT_FOUND to the generic failure code, like SESSION_NOT_FOUND", () => {
    expect(exitCodeForError(new DaemonError("OPERATOR_RUN_NOT_FOUND", "no such run"))).toBe(
      EXIT_GENERIC_FAILURE,
    );
    expect(exitCodeForError(new DaemonError("SESSION_NOT_FOUND", "no such session"))).toBe(
      EXIT_GENERIC_FAILURE,
    );
  });

  it("maps a bad operate flag to the INVALID_ARGS code", () => {
    expect(exitCodeForError(new DaemonError("INVALID_ARGS", 'bad --model "x"'))).toBe(
      EXIT_INVALID_ARGS,
    );
  });
});

/**
 * Regression: `operate status|abort|list --json` printed human output.
 *
 * `operate` declares `--json` (via `addSharedRecordingFlags`) and each
 * subcommand declares its own; commander binds the parsed value to the
 * *parent*, leaving the subcommand's `opts.json` undefined. Asserting on the
 * param builder alone never caught this — it only shows up once the parent and
 * child flag registrations coexist in one parse, which is what these do.
 */
describe("jsonFlag (operate subcommands)", () => {
  function resolveJson(argv: string[]): boolean {
    let resolved: boolean | undefined;
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {} });
    const operate = program.command("operate").argument("[task]");
    addOperateFlags(addSharedRecordingFlags(operate)).action(() => {});
    operate
      .command("status <runId>")
      .option("--json", "output JSON")
      .action((_runId: string, opts: { json?: boolean }, cmd: Command) => {
        resolved = jsonFlag(opts, cmd);
      });
    program.parse(argv, { from: "user" });
    if (resolved === undefined) throw new Error("subcommand action did not run");
    return resolved;
  }

  it("honors --json on a subcommand even though commander binds it to the parent", () => {
    expect(resolveJson(["operate", "status", "op-1", "--json"])).toBe(true);
  });

  it("stays false when --json is absent", () => {
    expect(resolveJson(["operate", "status", "op-1"])).toBe(false);
  });
});
