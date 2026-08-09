/**
 * @windower/engine — recording orchestration and the daemon-free half of the
 * `local` / `daemon` / `attach` backend routing decision. Extracted out of
 * `apps/daemon` in Phase 20 (`phase-20-daemon-optional.md`, "Extract
 * `@windower/engine`") so both a long-lived daemon process and a short-lived
 * CLI process (e.g. `record --duration`) can each hold their own
 * `RecordingEngine` instance. `apps/daemon` keeps only socket + lifecycle
 * (`server.ts`/`main.ts`/`bin.ts`) on top of this package.
 *
 * `narration-mux.ts` (and its `ffmpeg-static` dependency, ~70MB) lives here,
 * not in `@windower/core` — `@windower/mcp-server` depends on `@windower/core`
 * without dragging that binary in.
 */
export const ENGINE_PACKAGE_NAME = "@windower/engine";

export * from "./session-store.js";
export * from "./recording-engine.js";
export * from "./target-lock.js";
export * from "./manifest.js";
export * from "./passthrough.js";
export * from "./secret-resolver.js";
export * from "./request-context.js";
export * from "./operator-run-store.js";
export * from "./operator-run-engine.js";
export * from "./local-windower.js";
export * from "./output-resolver.js";
export * from "./event-timeline-writer.js";
export * from "./narration-mux.js";
