import { z } from "zod";
import { AudioSettingsSchema } from "./audio-settings.js";
import { ModelConfigSchema, OperatorGuardrailsSchema } from "./operator.js";
import { VideoSettingsSchema } from "./video-settings.js";

/**
 * WindowerConfig — the shape of `~/.windower/config.json`
 * (contracts/cli.md `windower config get|set`: output folder, filename
 * template, daemon idle-timeout, default video/audio settings).
 *
 * Every field is optional: the file may not exist yet, and a partial or
 * empty config.json is valid — callers (see `daemon/config-file.ts`)
 * synthesize defaults for missing fields rather than erroring. This module
 * stays dependency-free like the rest of `schemas/` (no import of
 * `daemon/paths.js`), so defaults are documented in comments only:
 *   - outputDir: `defaultOutputDir()` (`daemon/paths.ts`, `~/Movies/Windower`)
 *   - filenameTemplate: see `daemon/config-file.ts`'s `DEFAULT_FILENAME_TEMPLATE`
 *   - daemonIdleTimeoutMs: see `daemon/config-file.ts`'s `DEFAULT_DAEMON_IDLE_TIMEOUT_MS`
 *     (mirrors apps/daemon's own `DEFAULT_IDLE_TIMEOUT_MS`, 30 minutes)
 */
export const WindowerConfigSchema = z.object({
  outputDir: z.string().optional(),
  filenameTemplate: z.string().optional(),
  daemonIdleTimeoutMs: z.number().positive().optional(),
  defaultVideo: VideoSettingsSchema.partial().optional(),
  defaultAudio: AudioSettingsSchema.partial().optional(),
  /** Phase 19 — operator defaults, see data-model.md §WindowerConfig. */
  operator: z
    .object({
      defaultModel: ModelConfigSchema.optional(),
      /**
       * Phase 22 — per-tier config defaults (data-model.md §WindowerConfig).
       * Resolution order per tier, highest precedence first: the explicit
       * flag (`--planner-model`/`--executor-model`) → the tier's own config
       * default here → `--model`/`defaultModel` → error. The executor
       * additionally falls back to the resolved planner, which is what makes
       * a single `--model`/`defaultModel` run identical to a pre-Phase-22 run.
       */
      defaultPlannerModel: ModelConfigSchema.optional(),
      defaultExecutorModel: ModelConfigSchema.optional(),
      apiKeyEnvVar: z.string().optional(),
      baseUrl: z.string().optional(),
      guardrailDefaults: OperatorGuardrailsSchema.optional(),
    })
    .optional(),
});
export type WindowerConfig = z.infer<typeof WindowerConfigSchema>;
