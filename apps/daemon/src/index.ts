/**
 * @windower/daemon — long-running session manager, unix socket JSON-RPC server.
 * Owns sidecar process lifecycle (one per active session) and persists session
 * state to ~/.windower/sessions/<id>.json on every transition.
 *
 * Phase 0: placeholder export only, no functional capability yet.
 * See specs/001-windower-mvp/plan.md.
 */
export const DAEMON_PACKAGE_NAME = "@windower/daemon";
