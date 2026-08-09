import { z } from "zod";
import { JsonRpcIdSchema } from "../protocol/jsonrpc.js";
import { DaemonErrorCodeSchema } from "./methods.js";

/**
 * JSON-RPC 2.0 line schema for the daemon protocol — structurally identical
 * to `protocol/jsonrpc.ts`'s sidecar version, but `error.data.code` is drawn
 * from `DaemonErrorCodeSchema` (sidecar codes plus daemon-only ones like
 * `DAEMON_UNREACHABLE`). Kept as a separate schema rather than reused so a
 * daemon-only error code doesn't fail validation against the sidecar's
 * narrower enum.
 */
export const DaemonJsonRpcErrorObjectSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({ code: DaemonErrorCodeSchema }).optional(),
});
export type DaemonJsonRpcErrorObject = z.infer<typeof DaemonJsonRpcErrorObjectSchema>;

export const DaemonJsonRpcLineSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: DaemonJsonRpcErrorObjectSchema.optional(),
});
export type DaemonJsonRpcLine = z.infer<typeof DaemonJsonRpcLineSchema>;

export type DaemonJsonRpcLineKind = "request" | "notification" | "response" | "unknown";

/** Same classification rule as `classifyJsonRpcLine` — see that function's doc. */
export function classifyDaemonJsonRpcLine(line: DaemonJsonRpcLine): DaemonJsonRpcLineKind {
  const hasId = line.id !== undefined;
  const hasMethod = typeof line.method === "string";
  if (hasMethod && hasId) return "request";
  if (hasMethod && !hasId) return "notification";
  if (hasId && (line.result !== undefined || line.error !== undefined)) return "response";
  return "unknown";
}
