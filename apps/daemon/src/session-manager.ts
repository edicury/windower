/**
 * @deprecated `SessionManager` was renamed to `RecordingEngine` and moved to
 * `@windower/engine` in Phase 20's `@windower/engine` extraction
 * (`phase-20-daemon-optional.md`) — it now also owns the `TargetLock` seam
 * that replaced its old process-local `activeTargetKeys` guard. Re-exported
 * here (under its new name) for one minor version for backward compat;
 * import `RecordingEngine` from `@windower/engine` directly going forward.
 */
export {
  RecordingEngine,
  InMemoryTargetLock,
  TargetLockConflictError,
  targetKey,
  type RecordingEngineOptions,
  type SidecarFactory,
  type SidecarHandle,
  type TargetLock,
  type TargetLockOwner,
} from "@windower/engine";
