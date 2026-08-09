/**
 * @deprecated Moved to `@windower/engine` in Phase 20's `@windower/engine`
 * extraction (`phase-20-daemon-optional.md`) — `RequestContext` is a plain
 * data shape consumed by `OperatorRunEngine`, a daemon-free module, so it
 * cannot live here (this package depends on `@windower/engine`, not the
 * other way around). Import from `@windower/engine` instead. Kept as a
 * re-export for one minor version so anything still importing from
 * `apps/daemon/src/request-context.js` keeps working.
 */
export type { RequestContext } from "@windower/engine";
export { buildRequestContext } from "@windower/engine";
