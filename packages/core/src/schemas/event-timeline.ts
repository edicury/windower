import { z } from "zod";

/**
 * TimelineEvent / EventTimeline — <recording>.events.json. Phase 10 output;
 * cursor/click capture only in MVP. See data-model.md §EventTimeline.
 *
 * `source` carries a runtime default of `"user"` so `.events.json` files
 * written before this field existed still parse unchanged; the exported TS
 * types use `z.input` (i.e. `source?`) for the same back-compat reason —
 * every event that has been through `TimelineEventSchema.parse` is
 * guaranteed to carry a concrete `source`.
 *
 * Phase 24 — Windower no longer synthesizes input itself (the Operator was
 * removed; driving a UI during a demo is always the calling agent's own
 * tool, indistinguishable from a human below the stdio line), so `"user"` is
 * the only value anything ever writes going forward. `"operator"` stays in
 * the accepted enum purely for READ back-compat with `.events.json` files
 * written before this phase — an older file carrying it must still parse,
 * per the same policy `data-model.md`'s breaking-change notes use elsewhere
 * (settled decision in `tasks/phase-24-remove-operator.md`).
 */

export const EventSourceSchema = z.enum(["user", "operator"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

const sourceField = EventSourceSchema.default("user");

export const CursorMoveEventSchema = z.object({
  t: z.number(),
  type: z.literal("cursor_move"),
  x: z.number(),
  y: z.number(),
  source: sourceField,
});
export type CursorMoveEvent = z.input<typeof CursorMoveEventSchema>;

export const MouseButtonEventSchema = z.object({
  t: z.number(),
  type: z.enum(["mouse_down", "mouse_up"]),
  x: z.number(),
  y: z.number(),
  button: z.enum(["left", "right", "other"]),
  source: sourceField,
});
export type MouseButtonEvent = z.input<typeof MouseButtonEventSchema>;

export const KeyEventSchema = z.object({
  t: z.number(),
  type: z.enum(["key_down", "key_up"]),
  key: z.string(),
  source: sourceField,
});
export type KeyEvent = z.input<typeof KeyEventSchema>;

export const TimelineEventSchema = z.discriminatedUnion("type", [
  CursorMoveEventSchema,
  MouseButtonEventSchema.extend({ type: z.literal("mouse_down") }),
  MouseButtonEventSchema.extend({ type: z.literal("mouse_up") }),
  KeyEventSchema.extend({ type: z.literal("key_down") }),
  KeyEventSchema.extend({ type: z.literal("key_up") }),
]);
/** As accepted on the wire / on disk — `source` optional, defaulted on parse. */
export type TimelineEvent = z.input<typeof TimelineEventSchema>;
/** As produced by `TimelineEventSchema.parse` — `source` always present. */
export type ParsedTimelineEvent = z.output<typeof TimelineEventSchema>;

export const EventTimelineSchema = z.object({
  sessionId: z.string(),
  events: z.array(TimelineEventSchema),
  capabilities: z.object({ keystrokes: z.boolean() }),
});
export type EventTimeline = z.input<typeof EventTimelineSchema>;
export type ParsedEventTimeline = z.output<typeof EventTimelineSchema>;
