import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type WindowerConfig, WindowerConfigSchema } from "../schemas/config.js";
import { configFilePath, defaultOutputDir } from "./paths.js";

/** Default `filenameTemplate` when `config.json` doesn't set one. */
export const DEFAULT_FILENAME_TEMPLATE = "{target}-{timestamp}";

/** Default `daemonIdleTimeoutMs` when `config.json` doesn't set one — mirrors apps/daemon's own default. */
export const DEFAULT_DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** `WindowerConfig` with every field that has a sensible universal default resolved. */
export interface ResolvedWindowerConfig {
  outputDir: string;
  filenameTemplate: string;
  daemonIdleTimeoutMs: number;
  defaultVideo?: WindowerConfig["defaultVideo"];
  defaultAudio?: WindowerConfig["defaultAudio"];
}

/**
 * Reads `~/.windower/config.json` (or `WINDOWER_HOME`-overridden path)
 * verbatim, with no defaults merged in — a missing file reads as `{}`.
 * Callers that want to update one field without clobbering the others
 * already on disk (e.g. `windower config set`) should start from this, not
 * from `readConfig()`'s defaulted view, or an explicitly-set field with a
 * universal default (like `outputDir`) would silently vanish on the next
 * unrelated `set`.
 */
export async function readRawConfig(): Promise<WindowerConfig> {
  try {
    const text = await readFile(configFilePath(), "utf8");
    return WindowerConfigSchema.parse(JSON.parse(text));
  } catch (err) {
    if (!isFileNotFound(err)) throw err;
    return {};
  }
}

/**
 * Reads `~/.windower/config.json` (or `WINDOWER_HOME`-overridden path) and
 * merges it with defaults. A missing file is not an error — it's treated
 * the same as an empty config, since the file is only written on first
 * `windower config set`.
 */
export async function readConfig(): Promise<ResolvedWindowerConfig> {
  const raw = await readRawConfig();
  return {
    outputDir: raw.outputDir ?? defaultOutputDir(),
    filenameTemplate: raw.filenameTemplate ?? DEFAULT_FILENAME_TEMPLATE,
    daemonIdleTimeoutMs: raw.daemonIdleTimeoutMs ?? DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
    defaultVideo: raw.defaultVideo,
    defaultAudio: raw.defaultAudio,
  };
}

/**
 * Writes `config` verbatim (validated, not merged with what's currently on
 * disk — callers that want a partial update should `readConfig`/read the
 * raw file first and merge themselves) to `~/.windower/config.json`,
 * creating the parent directory if needed.
 */
export async function writeConfig(config: WindowerConfig): Promise<void> {
  const validated = WindowerConfigSchema.parse(config);
  const path = configFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

function isFileNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
