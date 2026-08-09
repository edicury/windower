/**
 * @windower/daemon — long-running session manager, unix socket JSON-RPC server.
 * Owns sidecar process lifecycle (one per active session) and persists session
 * state to ~/.windower/sessions/<id>.json on every transition.
 *
 * See specs/001-windower-mvp/plan.md and tasks/phase-6-daemon-session-lifecycle.md.
 */
export const DAEMON_PACKAGE_NAME = "@windower/daemon";

export * from "./config.js";
export * from "./session-store.js";
export * from "./session-manager.js";
export * from "./passthrough.js";
export * from "./secret-resolver.js";
export * from "./operator-run-store.js";
export * from "./operator-run-manager.js";
export * from "./server.js";
export * from "./main.js";
