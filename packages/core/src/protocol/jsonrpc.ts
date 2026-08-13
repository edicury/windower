import { z } from "zod";

/**
 * JSON-RPC 2.0 envelope types for the sidecar protocol. See
 * contracts/sidecar-protocol.md §Transport — newline-delimited JSON, one
 * object per line, over stdio.
 */

export const JsonRpcIdSchema = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

/** A JSON value, recursively — used where params/result shape is generic. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** Request: daemon → sidecar. Always carries an id (expects a response). */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest<TParams = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
};

/** Notification: sidecar → daemon (or daemon → sidecar), no id, no response. */
export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcNotification<TParams = unknown> = {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
};

/** Structured error data — see contracts/sidecar-protocol.md §Error taxonomy. */
export const SidecarErrorCodeSchema = z.enum([
  "PERMISSION_DENIED",
  "TARGET_NOT_FOUND",
  "RESIZE_UNSUPPORTED",
  "CAPTURE_FAILED",
  "UNSUPPORTED_CAPABILITY",
  "SESSION_NOT_FOUND",
  "INTERNAL_ERROR",
  "INPUT_UNSUPPORTED",
  "INPUT_OUT_OF_BOUNDS",
  /**
   * A supplied element `ref` no longer resolves to a live element, generally
   * because its generation was superseded or the window moved. Non-terminal:
   * a caller re-enumerates and continues (contracts/sidecar-protocol.md
   * §Error taxonomy).
   */
  "AX_ELEMENT_STALE",
]);
export type SidecarErrorCode = z.infer<typeof SidecarErrorCodeSchema>;

export const JsonRpcErrorDataSchema = z.object({
  code: SidecarErrorCodeSchema,
});
export type JsonRpcErrorData = z.infer<typeof JsonRpcErrorDataSchema>;

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: JsonRpcErrorDataSchema.optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

/** Success response: sidecar → daemon. */
export const JsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.unknown(),
});
export type JsonRpcSuccessResponse<TResult = unknown> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: TResult;
};

/** Error response: sidecar → daemon. */
export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.nullable(),
  error: JsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

/**
 * Any single line of the protocol, as received by either side. This is
 * intentionally permissive (all fields optional) — it exists only to
 * classify an incoming parsed JSON object by field presence before routing
 * it to the request/notification/response handler, which then validates
 * the concrete shape with the schema for that specific case. A
 * discriminated union across the four envelope shapes doesn't work here:
 * a request and a notification only differ by the *absence* of a field,
 * which `z.union` can't use to disambiguate reliably against messages that
 * carry extra unknown keys.
 */
export const JsonRpcLineSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: JsonRpcErrorObjectSchema.optional(),
});
export type JsonRpcLine = z.infer<typeof JsonRpcLineSchema>;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type JsonRpcLineKind = "request" | "notification" | "response" | "unknown";

/** Classifies a parsed+schema-validated line by which envelope fields it carries. */
export function classifyJsonRpcLine(line: JsonRpcLine): JsonRpcLineKind {
  const hasId = line.id !== undefined;
  const hasMethod = typeof line.method === "string";
  if (hasMethod && hasId) return "request";
  if (hasMethod && !hasId) return "notification";
  if (hasId && (line.result !== undefined || line.error !== undefined)) return "response";
  return "unknown";
}
