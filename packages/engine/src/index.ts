/**
 * @windower/engine — recording orchestration and the daemon-free half of the
 * `local` / `daemon` / `attach` backend routing decision. Extracted out of
 * `apps/daemon` in Phase 20 (`phase-20-daemon-optional.md`, "Extract
 * `@windower/engine`") so both a long-lived daemon process and a short-lived
 * CLI process (e.g. `record --duration`) can each hold their own
 * `RecordingEngine` instance. `apps/daemon` keeps only socket + lifecycle
 * (`server.ts`/`main.ts`/`bin.ts`) on top of this package.
 *
 * `narration-mux.ts` (and its `ffmpeg-static` dependency, ~70MB) does NOT
 * live in this package — it was split out into `@windower/engine-narration`
 * (Phase 20 follow-up; see `STATUS.md`'s Phase 20 section) precisely
 * because `@windower/mcp-server` depends on this package (for
 * `LocalWindower`) without ever needing narration muxing, and a declared
 * `ffmpeg-static` dependency drags the binary into `mcp-server`'s resolved
 * tree regardless of whether any code path actually imports it. Instead,
 * `RecordingEngine` (`recording-engine.ts`) takes `muxNarration`/
 * `validateNarrationFile` as injected constructor options with NO default —
 * `apps/daemon` (the only host that runs narration-muxed recordings; see
 * `apps/daemon/src/main.ts`) imports `@windower/engine-narration` itself
 * and passes the real implementations in. `LocalWindower` and
 * `packages/cli/src/commands/operate.ts`'s direct `RecordingEngine`
 * construction never pass narration params, so they never need the
 * injection.
 */
export const ENGINE_PACKAGE_NAME = "@windower/engine";

export * from "./session-store.js";
export * from "./recording-engine.js";
export * from "./target-lock.js";
export * from "./screen-capture-lock.js";
export * from "./control-engine.js";
export * from "./manifest.js";
export * from "./passthrough.js";
export * from "./local-windower.js";
export * from "./output-resolver.js";
export * from "./event-timeline-writer.js";
