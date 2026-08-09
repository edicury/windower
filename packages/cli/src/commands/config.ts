import {
  DaemonError,
  type ResolvedWindowerConfig,
  type WindowerConfig,
  WindowerConfigSchema,
  readConfig,
  readRawConfig,
  writeConfig,
} from "@windower/core";
import type { Command } from "commander";
import { printError, printResult } from "../output.js";

/**
 * `windower config get|set <key> <value>` — contracts/cli.md. Reads/writes
 * `~/.windower/config.json` directly via `packages/core`'s `readConfig`/
 * `writeConfig` — no daemon involved (an already-running daemon won't pick
 * up the change until restart, which is fine per the phase brief).
 */
const TOP_LEVEL_KEYS = [
  "outputDir",
  "filenameTemplate",
  "daemonIdleTimeoutMs",
  "defaultVideo",
  "defaultAudio",
  // Phase 19: contracts/operator.md — "Defaults (provider, model, base URL,
  // guardrail values) live in a new `operator` block of WindowerConfig,
  // read/written via the existing `windower config get|set` command".
  // Written as one JSON object (no dotted sub-paths), e.g.
  //   windower config set operator '{"defaultModel":{"provider":"anthropic","model":"claude-sonnet-5"}}'
  "operator",
] as const;
type TopLevelKey = (typeof TOP_LEVEL_KEYS)[number];

function isTopLevelKey(key: string): key is TopLevelKey {
  return (TOP_LEVEL_KEYS as readonly string[]).includes(key);
}

function invalidKeyError(key: string): DaemonError {
  return new DaemonError(
    "INVALID_ARGS",
    `Unknown config key "${key}" — expected one of: ${TOP_LEVEL_KEYS.join(", ")}`,
  );
}

/**
 * `get <key>` result shape: `{ key, value }` in both modes (rather than the
 * bare value) — round-trips cleanest with `set <key> <value>` since the key
 * is always visible next to what it resolved to, and callers scripting
 * `config get` don't need to know which key they asked for out-of-band.
 */
export interface ConfigGetResult {
  key: string;
  value: unknown;
}

/**
 * The view `config get` reads from: `readConfig()`'s defaulted view plus the
 * raw `operator` block, which has no universal default and so isn't part of
 * `ResolvedWindowerConfig`.
 */
export type ConfigGetView = ResolvedWindowerConfig & Pick<WindowerConfig, "operator">;

/** Looks up `key` (must be a known top-level `WindowerConfig` field) in `config`. Throws `INVALID_ARGS` for unknown keys. */
export function getConfigValue(config: ConfigGetView, key: string): ConfigGetResult {
  if (!isTopLevelKey(key)) throw invalidKeyError(key);
  return { key, value: config[key] };
}

export function renderConfigGetResult(result: ConfigGetResult): string {
  const { value } = result;
  if (value === undefined) return `${result.key}: (unset)`;
  return `${result.key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
}

export interface ConfigSetResult {
  key: string;
  value: unknown;
}

export function renderConfigSetResult(result: ConfigSetResult): string {
  return `${result.key} set to ${typeof result.value === "object" ? JSON.stringify(result.value) : String(result.value)}`;
}

/**
 * Parses a raw CLI string into the typed value to merge for `key`, which
 * may be a dotted path (`defaultVideo.fps`) into one of the nested partial
 * settings objects. Top-level scalar keys get an explicit typed parse
 * (`daemonIdleTimeoutMs` -> number, `outputDir`/`filenameTemplate` ->
 * string as-is); dotted-path leaves under `defaultVideo`/`defaultAudio` are
 * parsed as JSON when possible (numbers, booleans, quoted strings, small
 * objects) and fall back to the raw string otherwise, since those nested
 * schemas mix scalar and non-scalar leaf types.
 */
function parseLeafValue(topKey: TopLevelKey, raw: string): unknown {
  if (topKey === "daemonIdleTimeoutMs") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new DaemonError(
        "INVALID_ARGS",
        `Invalid value "${raw}" for ${topKey} — expected a number`,
      );
    }
    return n;
  }
  if (topKey === "outputDir" || topKey === "filenameTemplate") {
    return raw;
  }
  // defaultVideo / defaultAudio (possibly via a dotted sub-path): best-effort JSON parse.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Merges `keyPath` (top-level, or dotted like `defaultVideo.fps`) = parsed
 * `rawValue` into `base`, returning a new plain object suitable for
 * `WindowerConfigSchema.partial().parse`. `base` should be the raw
 * (unresolved) on-disk config — merging onto `ResolvedWindowerConfig` would
 * bake resolved defaults back into the file.
 */
export function mergeConfigSet(
  base: Record<string, unknown>,
  keyPath: string,
  rawValue: string,
): Record<string, unknown> {
  const [topKey, ...rest] = keyPath.split(".");
  if (!topKey || !isTopLevelKey(topKey)) throw invalidKeyError(topKey ?? keyPath);

  const merged: Record<string, unknown> = { ...base };

  if (rest.length === 0) {
    merged[topKey] = parseLeafValue(topKey, rawValue);
  } else if (topKey === "defaultVideo" || topKey === "defaultAudio") {
    const nestedKey = rest.join(".");
    const existingNested =
      typeof merged[topKey] === "object" && merged[topKey] !== null
        ? (merged[topKey] as Record<string, unknown>)
        : {};
    merged[topKey] = { ...existingNested, [nestedKey]: parseLeafValue(topKey, rawValue) };
  } else {
    throw new DaemonError(
      "INVALID_ARGS",
      `Config key "${keyPath}" cannot have a dotted sub-path — "${topKey}" is not a nested object`,
    );
  }

  return merged;
}

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Read/write ~/.windower/config.json");

  config
    .command("get <key>")
    .description("Read a config value")
    .option("--json", "output JSON")
    .action(async (key: string, opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const [resolved, raw] = await Promise.all([readConfig(), readRawConfig()]);
        const result = getConfigValue({ ...resolved, operator: raw.operator }, key);
        printResult(json, result, renderConfigGetResult);
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });

  config
    .command("set <key> <value>")
    .description("Write a config value")
    .option("--json", "output JSON")
    .action(async (key: string, value: string, opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        // Start from the raw on-disk config (not readConfig()'s defaulted
        // view) so a field with a universal default — e.g. outputDir — that
        // was explicitly set earlier doesn't silently vanish just because
        // this call is setting some other unrelated key.
        const base: Record<string, unknown> = await readRawConfig();
        const merged = mergeConfigSet(base, key, value);
        const parsed = WindowerConfigSchema.partial().safeParse(merged);
        if (!parsed.success) {
          throw new DaemonError(
            "INVALID_ARGS",
            `Invalid value "${value}" for "${key}": ${parsed.error.message}`,
          );
        }
        await writeConfig(parsed.data);
        const topKey = key.split(".")[0] as TopLevelKey;
        const result: ConfigSetResult = { key, value: merged[topKey] };
        printResult(json, result, renderConfigSetResult);
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });
}
