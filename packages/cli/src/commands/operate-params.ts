import {
  DaemonError,
  type ModelConfig,
  type OperatorGuardrails,
  type RunOperatorParams,
  type SecretRef,
  type WindowerConfig,
  parseModelConfig,
  parseSecretRef,
} from "@windower/core";
import type { Command } from "commander";
import { type SharedRecordingOpts, buildAudio, buildVideo } from "./record-params.js";

/**
 * Flag parsing for `windower operate "<task>"` (contracts/cli.md). Kept in
 * its own module — like `record-params.ts` for `start`/`record` — so every
 * flag is testable as a pure function without spawning a daemon.
 *
 * The recording half of the flag surface is *not* redefined here: `operate`
 * registers `addSharedRecordingFlags` verbatim and reuses that module's
 * `buildVideo`/`buildAudio`.
 */
export interface OperateOpts extends SharedRecordingOpts {
  /** `<provider>:<model>`, e.g. `anthropic:claude-sonnet-5`, `openai-compatible:llama3:8b`. */
  model?: string;
  baseUrl?: string;
  /** Repeatable `--secret <name>=<source>:<ref>`; commander collects into an array. */
  secret?: string[];
  maxSteps?: string;
  /** Wall-clock bound in **seconds** at the CLI boundary. */
  timeout?: string;
  unbounded?: boolean;
  /** commander's `--no-record` sets this to `false`; undefined when not passed. */
  record?: boolean;
}

/** `~/.windower/config.json`'s `operator` block — fallbacks for omitted flags. */
export type OperatorConfigDefaults = NonNullable<WindowerConfig["operator"]>;

/**
 * `operate`-specific flags, layered on top of `addSharedRecordingFlags`.
 * Deliberately no `--api-key`-style flag: per contracts/operator.md the API
 * key is only ever read from an environment variable, never from argv (shell
 * history + process listings).
 */
export function addOperateFlags(command: Command): Command {
  return command
    .option("--model <provider:model>", "operator model, e.g. anthropic:claude-sonnet-5")
    .option("--base-url <url>", "base URL for the model provider (e.g. a local server)")
    .option(
      "--secret <name=source:ref>",
      "secret ref, repeatable — source is env|keychain|literal",
      collectSecret,
      [] as string[],
    )
    .option("--max-steps <n>", "maximum operator steps before the run fails")
    .option("--timeout <s>", "wall-clock timeout in seconds")
    .option("--unbounded", "disable the target-bounds coordinate clamp (use with care)")
    .option("--no-record", "run the operator without recording a video");
}

function collectSecret(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DaemonError(
      "INVALID_ARGS",
      `Invalid ${flag} "${raw}" — expected a positive whole number`,
    );
  }
  return n;
}

function parsePositiveNumber(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DaemonError("INVALID_ARGS", `Invalid ${flag} "${raw}" — expected a positive number`);
  }
  return n;
}

/** Wraps `@windower/core`'s plain-`Error` parse failures in the CLI's error taxonomy. */
function asInvalidArgs<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new DaemonError("INVALID_ARGS", err instanceof Error ? err.message : String(err));
  }
}

export function parseSecretRefs(specs: readonly string[]): SecretRef[] {
  return specs.map((spec) => asInvalidArgs(() => parseSecretRef(spec)));
}

/**
 * `literal:` is allowed (contracts/operator.md: "Discouraged; using `literal`
 * logs a warning ... but is not blocked, for quick local testing") — so this
 * returns warnings rather than throwing.
 */
export function secretWarnings(secrets: readonly SecretRef[]): string[] {
  return secrets
    .filter((s) => s.source === "literal")
    .map(
      (s) =>
        `Warning: --secret ${s.name} uses the "literal" source — the value is exposed in shell history and process listings. Prefer env: or keychain: outside quick local testing.`,
    );
}

function buildModel(opts: OperateOpts, defaults: OperatorConfigDefaults): ModelConfig {
  const baseUrl = opts.baseUrl ?? defaults.baseUrl;
  const extra = {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(defaults.apiKeyEnvVar !== undefined ? { apiKeyEnvVar: defaults.apiKeyEnvVar } : {}),
  };

  if (opts.model !== undefined) {
    return asInvalidArgs(() => parseModelConfig(opts.model as string, extra));
  }
  if (defaults.defaultModel !== undefined) {
    return { ...defaults.defaultModel, ...extra };
  }
  throw new DaemonError(
    "INVALID_ARGS",
    '--model is required — pass <provider>:<model> (e.g. "anthropic:claude-sonnet-5") or set ' +
      "`operator` defaults in ~/.windower/config.json",
  );
}

function buildGuardrails(
  opts: OperateOpts,
  defaults: OperatorConfigDefaults,
): OperatorGuardrails | undefined {
  const fromConfig = defaults.guardrailDefaults ?? {};
  const maxSteps =
    opts.maxSteps !== undefined
      ? parsePositiveInt(opts.maxSteps, "--max-steps")
      : fromConfig.maxSteps;
  // `--timeout` is seconds at the CLI boundary and stays seconds on the RPC
  // boundary (`OperatorGuardrails.timeoutSeconds`); the daemon converts to
  // the runtime's `timeoutMs`.
  const timeoutSeconds =
    opts.timeout !== undefined
      ? parsePositiveNumber(opts.timeout, "--timeout")
      : fromConfig.timeoutSeconds;
  const unbounded = opts.unbounded === true ? true : fromConfig.unbounded;

  const guardrails: OperatorGuardrails = {
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(unbounded !== undefined ? { unbounded } : {}),
  };
  return Object.keys(guardrails).length > 0 ? guardrails : undefined;
}

function buildRecording(opts: OperateOpts): RunOperatorParams["recording"] {
  const disabled = opts.record === false;
  const video = buildVideo(opts);
  const audio = buildAudio(opts);
  const recording = {
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(opts.out !== undefined ? { outputDir: opts.out } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
  return Object.keys(recording).length > 0 ? recording : undefined;
}

/**
 * Builds `run_operator` params from `operate`'s flags, layering
 * `~/.windower/config.json`'s `operator` block underneath them.
 *
 * `run_operator` takes no target (contracts/mcp-tools.md §run_operator — the
 * daemon targets the primary display, and the operator can re-target itself
 * through its own `list_targets`/`resize_window` tools), so the
 * target-selection third of the shared recording flag block is rejected
 * rather than silently dropped: silently ignoring a `--target` the user set
 * would record the wrong thing.
 */
export function buildRunOperatorParams(
  task: string,
  opts: OperateOpts,
  defaults: OperatorConfigDefaults = {},
): RunOperatorParams {
  if (task.trim().length === 0) {
    throw new DaemonError("INVALID_ARGS", "A non-empty <task> is required");
  }
  for (const [flag, value] of [
    ["--target", opts.target],
    ["--kind", opts.kind],
    ["--region", opts.region],
  ] as const) {
    if (value !== undefined) {
      throw new DaemonError(
        "INVALID_ARGS",
        `${flag} is not supported by \`windower operate\` — the operator records the primary display and re-targets itself via its own list_targets/resize_window tools`,
      );
    }
  }

  const secrets = parseSecretRefs(opts.secret ?? []);
  const guardrails = buildGuardrails(opts, defaults);
  const recording = buildRecording(opts);

  return {
    task,
    model: buildModel(opts, defaults),
    ...(recording !== undefined ? { recording } : {}),
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(guardrails !== undefined ? { guardrails } : {}),
  };
}
