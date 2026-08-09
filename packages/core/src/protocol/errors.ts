import type { SidecarErrorCode } from "./jsonrpc.js";

export { SidecarErrorCodeSchema } from "./jsonrpc.js";
export type { SidecarErrorCode } from "./jsonrpc.js";

/**
 * Typed error surfaced by SidecarClient for any JSON-RPC error response.
 * Carries the taxonomy code from contracts/sidecar-protocol.md §Error
 * taxonomy so callers can branch on `err.code` instead of parsing `message`.
 */
export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  readonly rpcErrorCode: number;

  constructor(code: SidecarErrorCode, message: string, rpcErrorCode: number) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.rpcErrorCode = rpcErrorCode;
  }
}

/**
 * Thrown when a message from the sidecar can't be parsed as valid
 * JSON-RPC/protocol shape at all (malformed line, unknown envelope).
 */
export class SidecarProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarProtocolError";
  }
}
