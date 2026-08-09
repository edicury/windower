import { readFile } from "node:fs/promises";
import { configFilePath } from "@windower/core";
import { z } from "zod";

/** Default idle-shutdown timeout: 30 minutes (phase-6 task file). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The daemon-relevant subset of `~/.windower/config.json` (contracts/cli.md
 * `config get|set`). Output folder / filename template / default
 * video-audio settings are read by Phase 7's CLI directly from the same
 * file; the daemon only needs the idle timeout.
 */
const DaemonConfigFileSchema = z.object({
  daemonIdleTimeoutMs: z.number().positive().optional(),
});

export interface DaemonConfig {
  daemonIdleTimeoutMs: number;
}

export async function loadDaemonConfig(): Promise<DaemonConfig> {
  try {
    const raw = await readFile(configFilePath(), "utf8");
    const parsed = DaemonConfigFileSchema.parse(JSON.parse(raw));
    return { daemonIdleTimeoutMs: parsed.daemonIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS };
  } catch {
    return { daemonIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS };
  }
}
