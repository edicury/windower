import type { DaemonMethodMap } from "./methods.js";

/**
 * The command-facing contract shared by every host that can run a Windower
 * command: the RPC client talking to a real daemon over the unix socket
 * (`DaemonClient`), and the in-process `LocalWindower` (packages/engine,
 * introduced in Phase 20) that runs `@windower/engine` directly with no
 * daemon involved. `packages/cli` and `packages/mcp-server` code against
 * this interface — never against "daemon RPC client" directly — so which
 * concrete backend answers a given command (`local` / `daemon` / `attach`,
 * see `src/daemon/policy.ts` and `contracts/cli.md`'s Daemon policy section)
 * is an implementation swap, not a branch scattered through command bodies.
 *
 * One method per entry in `DaemonMethodMap` (`./methods.ts`), same params/
 * result shape 1:1 — this file intentionally carries no logic, only the
 * shared shape. `DaemonClient` already exposes exactly these methods (in
 * camelCase) with matching signatures; see `backend.test.ts` for the
 * type-level proof.
 */
export interface WindowerBackend {
  hello(params: DaemonMethodMap["hello"]["params"]): Promise<DaemonMethodMap["hello"]["result"]>;

  daemonInfo(): Promise<DaemonMethodMap["daemon_info"]["result"]>;

  listTargets(
    params?: DaemonMethodMap["list_targets"]["params"],
  ): Promise<DaemonMethodMap["list_targets"]["result"]>;

  checkPermissions(): Promise<DaemonMethodMap["check_permissions"]["result"]>;

  requestPermission(
    params: DaemonMethodMap["request_permission"]["params"],
  ): Promise<DaemonMethodMap["request_permission"]["result"]>;

  resizeWindow(
    params: DaemonMethodMap["resize_window"]["params"],
  ): Promise<DaemonMethodMap["resize_window"]["result"]>;

  startRecording(
    params: DaemonMethodMap["start_recording"]["params"],
  ): Promise<DaemonMethodMap["start_recording"]["result"]>;

  getSession(
    params: DaemonMethodMap["get_session"]["params"],
  ): Promise<DaemonMethodMap["get_session"]["result"]>;

  stopRecording(
    params: DaemonMethodMap["stop_recording"]["params"],
  ): Promise<DaemonMethodMap["stop_recording"]["result"]>;

  cancelRecording(
    params: DaemonMethodMap["cancel_recording"]["params"],
  ): Promise<DaemonMethodMap["cancel_recording"]["result"]>;

  listSessions(
    params?: DaemonMethodMap["list_sessions"]["params"],
  ): Promise<DaemonMethodMap["list_sessions"]["result"]>;

  runOperator(
    params: DaemonMethodMap["run_operator"]["params"],
  ): Promise<DaemonMethodMap["run_operator"]["result"]>;

  getOperatorRun(
    params: DaemonMethodMap["get_operator_run"]["params"],
  ): Promise<DaemonMethodMap["get_operator_run"]["result"]>;

  abortOperatorRun(
    params: DaemonMethodMap["abort_operator_run"]["params"],
  ): Promise<DaemonMethodMap["abort_operator_run"]["result"]>;

  listOperatorRuns(
    params?: DaemonMethodMap["list_operator_runs"]["params"],
  ): Promise<DaemonMethodMap["list_operator_runs"]["result"]>;

  shutdown(): Promise<DaemonMethodMap["shutdown"]["result"]>;
}
