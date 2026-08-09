/**
 * @windower/engine-narration — the ffmpeg-backed narration-muxing step,
 * split out of `@windower/engine` (Phase 20 follow-up, see `STATUS.md`'s
 * Phase 20 section and `packages/engine/src/index.ts`'s top-of-file
 * comment). This is the ONLY package in the workspace that depends on
 * `ffmpeg-static` (~70MB) — `RecordingEngine`
 * (`packages/engine/src/recording-engine.ts`) takes `muxNarration`/
 * `validateNarrationFile` as injected constructor options instead of
 * importing this package directly, so only hosts that actually need
 * narration muxing (`apps/daemon`) declare a dependency on it.
 * `@windower/mcp-server` depends on `@windower/engine` for `LocalWindower`
 * but never on this package, so its resolved dependency tree has zero
 * references to `ffmpeg-static`.
 */
export const ENGINE_NARRATION_PACKAGE_NAME = "@windower/engine-narration";

export * from "./narration-mux.js";
