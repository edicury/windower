import type { DaemonErrorCode } from "./methods.js";

/**
 * Typed error surfaced by `DaemonClient` for any JSON-RPC error response
 * from the daemon, and thrown internally by the daemon (`apps/daemon`) for
 * client code there to catch and map to the same taxonomy.
 */
export class DaemonError extends Error {
  readonly code: DaemonErrorCode;

  constructor(code: DaemonErrorCode, message: string) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
  }
}
