/**
 * @windower/daemon — unix socket JSON-RPC server: socket framing and process
 * lifecycle only (`server.ts`/`main.ts`/`bin.ts`). Recording orchestration
 * (`RecordingEngine`, `SessionStore`, `PassthroughService`,
 * `SecretResolver`, and friends) moved to `@windower/engine` in Phase 20's
 * `@windower/engine` extraction (`phase-20-daemon-optional.md`, "Extract
 * `@windower/engine`") so both this long-lived daemon and a short-lived
 * `record --duration` CLI process can each hold their own instance.
 *
 * The modules below (`session-store.js`, `session-manager.js`,
 * `passthrough.js`) are `@deprecated` re-export shims kept for one minor
 * version so anything still importing from these paths keeps working;
 * import from `@windower/engine` directly going forward.
 *
 * See specs/001-windower-mvp/plan.md and tasks/phase-6-daemon-session-lifecycle.md.
 */
export const DAEMON_PACKAGE_NAME = "@windower/daemon";

export * from "./config.js";
export * from "./server.js";
export * from "./main.js";

/** @deprecated See `session-store.ts`. */
export * from "./session-store.js";
/** @deprecated See `session-manager.ts` — `SessionManager` was renamed `RecordingEngine`. */
export * from "./session-manager.js";
/** @deprecated See `passthrough.ts`. */
export * from "./passthrough.js";
