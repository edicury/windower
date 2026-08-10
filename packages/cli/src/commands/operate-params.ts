import {
  DaemonError,
  type ModelConfig,
  type OperatorGuardrails,
  type OperatorModels,
  type RunOperatorParams,
  type SecretRef,
  type WindowerConfig,
  normalizeOperatorModels,
  parseModelConfig,
  parseSecretRef,
} from "@windower/core";
import { type Command, Option } from "commander";
import { buildTargetSelector } from "./record-params.js";

/**
 * Flag parsing for `windower operate "<task>"` (contracts/cli.md). Kept in
 * its own module — like `record-params.ts` for `start`/`record` — so every
 * flag is testable as a pure function without spawning a daemon.
 *
 * Phase 21: `operate` has **no recording flags**. The operator is a peer
 * capability that records nothing (contracts/operator.md §Recording
 * independence), so the flag surface is task + target + model + guardrails.
 * It does take `start`'s target flags, because the operator's target is its
 * own — it is not "the primary display", and it has nothing to do with what,
 * if anything, is being recorded.
 */
export interface OperateOpts {
  /** `--target`/`--kind`/`--region` — the same selector `windower start` takes. */
  target?: string;
  kind?: string;
  region?: string;
  /**
   * `<provider>:<model>`, e.g. `anthropic:claude-sonnet-5`, `openai-compatible:llama3:8b`.
   * Sets BOTH tiers when `--planner-model`/`--executor-model` are absent
   * (Phase 22) — a caller who only ever passes `--model` sees identical
   * behavior to a pre-Phase-22, single-tier run.
   */
  model?: string;
  /** Phase 22 — overrides the planner tier only; falls back to `--model`, then config. */
  plannerModel?: string;
  /** Phase 22 — overrides the executor tier only; falls back to `--model`, then config. */
  executorModel?: string;
  baseUrl?: string;
  /** Repeatable `--secret <name>=<source>:<ref>`; commander collects into an array. */
  secret?: string[];
  maxSteps?: string;
  /** Wall-clock bound in **seconds** at the CLI boundary. */
  timeout?: string;
  /** `--max-batch <n>` — how many action tool calls one step may execute. */
  maxBatch?: string;
  /** Phase 22 — `"auto"|"ax"|"vision"`; see `contracts/operator.md` §Observation policy. */
  observe?: string;
  /** Phase 22 — `--max-replans <n>`, guardrail bounding planner re-entries. */
  maxReplans?: string;
  unbounded?: boolean;
  /** Opts out of the default blocking/`local` shape — see `operate.ts`. */
  detach?: boolean;
  json?: boolean;
}

/**
 * Flags Phase 21 removed from `operate`. Registered (hidden) rather than left
 * unknown so passing one produces the caller-side recipe instead of
 * commander's bare "unknown option" — the phase brief's "make the error
 * message for a removed flag point at the caller-side recipe rather than just
 * rejecting the flag".
 */
const REMOVED_FLAGS = [
  ["--no-record", "record"],
  ["--session <id>", "session"],
  ["--fps <fps>", "fps"],
  ["--codec <codec>", "codec"],
  ["--container <container>", "container"],
  ["--resolution <WxH>", "resolution"],
  ["--quality <quality>", "quality"],
  ["--audio-system", "audioSystem"],
  ["--audio-mic", "audioMic"],
  ["--mic-device <id>", "micDevice"],
  ["--separate-tracks", "separateTracks"],
  ["--out <dir>", "out"],
] as const;

const REMOVED_FLAG_HELP =
  "`windower operate` no longer records — the operator drives a target and records nothing " +
  "(contracts/operator.md §Recording independence). You orchestrate the two capabilities " +
  "yourself:\n" +
  "  windower start --target <id> [recording flags]   # prints a sessionId\n" +
  '  windower operate "<task>" --target <id>\n' +
  "  windower stop <sessionId>";

/** `~/.windower/config.json`'s `operator` block — fallbacks for omitted flags. */
export type OperatorConfigDefaults = NonNullable<WindowerConfig["operator"]>;

/**
 * `operate`-specific flags, layered on top of `addSharedRecordingFlags`.
 * Deliberately no `--api-key`-style flag: per contracts/operator.md the API
 * key is only ever read from an environment variable, never from argv (shell
 * history + process listings).
 */
export function addOperateFlags(command: Command): Command {
  for (const [flags] of REMOVED_FLAGS) {
    command.addOption(new Option(flags).hideHelp());
  }
  return command
    .option("--target <id>", "target id from `windower targets` — the target the operator drives")
    .option("--kind <kind>", "window|display|region")
    .option("--region <x,y,w,h>", "region bounds, only with --kind region")
    .option(
      "--model <provider:model>",
      "operator model for both tiers, e.g. anthropic:claude-sonnet-5 " +
        "(overridden per-tier by --planner-model/--executor-model)",
    )
    .option(
      "--planner-model <provider:model>",
      "planner-tier model override — writes the plan; falls back to --model, then config",
    )
    .option(
      "--executor-model <provider:model>",
      "executor-tier model override — executes each step; falls back to --model, then config " +
        "(worth setting to a cheap model)",
    )
    .option("--base-url <url>", "base URL for the model provider (e.g. a local server)")
    .option(
      "--secret <name=source:ref>",
      "secret ref, repeatable — source is env|keychain|literal",
      collectSecret,
      [] as string[],
    )
    .option("--max-steps <n>", "maximum operator steps before the run fails")
    .option("--timeout <s>", "wall-clock timeout in seconds")
    .option("--max-batch <n>", "maximum action tool calls executed in one step")
    .option(
      "--observe <auto|ax|vision>",
      "observation policy — auto (default: accessibility elements, screenshot fallback) | " +
        "ax (elements only, never captures a frame) | vision (screenshots only, pre-Phase-22 behavior)",
    )
    .option("--max-replans <n>", "maximum planner re-entries before the run fails (default 3)")
    .option("--unbounded", "disable the target-bounds coordinate clamp (use with care)")
    .option("--json", "output JSON")
    .option(
      "--detach",
      "don't block — start the run in a daemon and return { runId } immediately (original non-blocking shape)",
    );
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

/**
 * Resolves one tier's `ModelConfig` from an explicit `--planner-model`/
 * `--executor-model` flag, else a `configDefault`, else `undefined` (never
 * throws for a missing value — the caller decides whether that tier is
 * required).
 */
function resolveTierModel(
  flagValue: string | undefined,
  configDefault: ModelConfig | undefined,
  extra: Omit<Partial<ModelConfig>, "provider" | "model">,
): ModelConfig | undefined {
  if (flagValue !== undefined) {
    return asInvalidArgs(() => parseModelConfig(flagValue, extra));
  }
  if (configDefault !== undefined) {
    return { ...configDefault, ...extra };
  }
  return undefined;
}

/**
 * Phase 22 — resolves both model tiers and normalizes into `OperatorModels`
 * via `@windower/core`'s `normalizeOperatorModels`. Precedence per tier,
 * highest first: `--planner-model`/`--executor-model` → `--model` (planner
 * only — this is what makes a bare `--model` set both tiers, since an
 * `undefined` executor resolves to the planner downstream, in
 * `packages/operator`) → `operator.defaultPlannerModel`/
 * `defaultExecutorModel` in config → `operator.defaultModel` in config →
 * (planner) error / (executor) stays `undefined` and falls back to the
 * planner. Mirrors `OperatorRunEngine.resolveModels` daemon-side, so
 * `windower operate` and a caller relying on config defaults agree.
 */
function buildModels(opts: OperateOpts, defaults: OperatorConfigDefaults): OperatorModels {
  const baseUrl = opts.baseUrl ?? defaults.baseUrl;
  const extra = {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(defaults.apiKeyEnvVar !== undefined ? { apiKeyEnvVar: defaults.apiKeyEnvVar } : {}),
  };

  const planner = resolveTierModel(
    opts.plannerModel ?? opts.model,
    defaults.defaultPlannerModel ?? defaults.defaultModel,
    extra,
  );
  if (planner === undefined) {
    throw new DaemonError(
      "INVALID_ARGS",
      "--model or --planner-model is required — pass <provider>:<model> (e.g. " +
        '"anthropic:claude-sonnet-5") or set `operator` defaults in ~/.windower/config.json',
    );
  }

  // Deliberately NOT `?? opts.model`: a bare `--model` already set the
  // planner above, and leaving `executor` undefined here is what makes
  // `normalizeOperatorModels`/packages/operator's tier resolution fall the
  // executor back to the planner — the exact "one --model behaves like
  // today" parity requirement.
  const executor = resolveTierModel(opts.executorModel, defaults.defaultExecutorModel, extra);

  return normalizeOperatorModels(executor !== undefined ? { planner, executor } : planner);
}

const OBSERVE_VALUES = ["auto", "ax", "vision"] as const;
type ObserveMode = (typeof OBSERVE_VALUES)[number];

function parseObserve(raw: string): ObserveMode {
  if ((OBSERVE_VALUES as readonly string[]).includes(raw)) {
    return raw as ObserveMode;
  }
  throw new DaemonError(
    "INVALID_ARGS",
    `Invalid --observe "${raw}" — expected one of ${OBSERVE_VALUES.join("|")}`,
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
  const maxBatchActions =
    opts.maxBatch !== undefined
      ? parsePositiveInt(opts.maxBatch, "--max-batch")
      : fromConfig.maxBatchActions;
  // Phase 22 — bounds planner escalations per run; DEFAULT_OPERATOR_MAX_REPLANS
  // (3) applies daemon/loop-side when omitted here, same treatment as every
  // other guardrail default.
  const maxReplans =
    opts.maxReplans !== undefined
      ? parsePositiveInt(opts.maxReplans, "--max-replans")
      : fromConfig.maxReplans;
  const unbounded = opts.unbounded === true ? true : fromConfig.unbounded;

  const guardrails: OperatorGuardrails = {
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(maxBatchActions !== undefined ? { maxBatchActions } : {}),
    ...(maxReplans !== undefined ? { maxReplans } : {}),
    ...(unbounded !== undefined ? { unbounded } : {}),
  };
  return Object.keys(guardrails).length > 0 ? guardrails : undefined;
}

/**
 * Builds `run_operator` params from `operate`'s flags, layering
 * `~/.windower/config.json`'s `operator` block underneath them.
 *
 * An operator run is fully specified by `{ task, target, models, secrets?,
 * guardrails?, observe? }` and nothing else (contracts/operator.md §Inputs).
 * `target` is the same selector `windower start` takes and is resolved by
 * the daemon exactly the same way; a caller that wants video around the run
 * issues `windower start` and `windower stop` itself.
 */
export function buildRunOperatorParams(
  task: string,
  opts: OperateOpts,
  defaults: OperatorConfigDefaults = {},
): RunOperatorParams {
  if (task.trim().length === 0) {
    throw new DaemonError("INVALID_ARGS", "A non-empty <task> is required");
  }
  rejectRemovedFlags(opts);

  const secrets = parseSecretRefs(opts.secret ?? []);
  const guardrails = buildGuardrails(opts, defaults);
  const observe = opts.observe !== undefined ? parseObserve(opts.observe) : undefined;

  return {
    task,
    target: buildTargetSelector(opts),
    models: buildModels(opts, defaults),
    ...(secrets.length > 0 ? { secrets } : {}),
    ...(guardrails !== undefined ? { guardrails } : {}),
    ...(observe !== undefined ? { observe } : {}),
  };
}

/** Removed-flag rejection — points at the three-call recipe, not just "unknown option". */
function rejectRemovedFlags(opts: OperateOpts): void {
  const bag = opts as unknown as Record<string, unknown>;
  for (const [flags, key] of REMOVED_FLAGS) {
    const value = bag[key];
    // `--no-record` binds `record: false`; every other removed flag is
    // undefined unless it was passed.
    if (value === undefined || (key === "record" && value !== false)) continue;
    const name = flags.split(" ")[0];
    throw new DaemonError(
      "INVALID_ARGS",
      `${name} is no longer a \`windower operate\` flag.\n${REMOVED_FLAG_HELP}`,
    );
  }
}
