import { z } from "zod";

/**
 * TimelineEvent / EventTimeline — <recording>.events.json. Phase 10 output;
 * cursor/click capture only in MVP. See data-model.md §EventTimeline.
 */
export const CursorMoveEventSchema = z.object({
  t: z.number(),
  type: z.literal("cursor_move"),
  x: z.number(),
  y: z.number(),
});
export type CursorMoveEvent = z.infer<typeof CursorMoveEventSchema>;

export const MouseButtonEventSchema = z.object({
  t: z.number(),
  type: z.enum(["mouse_down", "mouse_up"]),
  x: z.number(),
  y: z.number(),
  button: z.enum(["left", "right", "other"]),
});
export type MouseButtonEvent = z.infer<typeof MouseButtonEventSchema>;

export const KeyEventSchema = z.object({
  t: z.number(),
  type: z.enum(["key_down", "key_up"]),
  key: z.string(),
});
export type KeyEvent = z.infer<typeof KeyEventSchema>;

export const TimelineEventSchema = z.discriminatedUnion("type", [
  CursorMoveEventSchema,
  MouseButtonEventSchema.extend({ type: z.literal("mouse_down") }),
  MouseButtonEventSchema.extend({ type: z.literal("mouse_up") }),
  KeyEventSchema.extend({ type: z.literal("key_down") }),
  KeyEventSchema.extend({ type: z.literal("key_up") }),
]);
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const EventTimelineSchema = z.object({
  sessionId: z.string(),
  events: z.array(TimelineEventSchema),
  capabilities: z.object({ keystrokes: z.boolean() }),
});
export type EventTimeline = z.infer<typeof EventTimelineSchema>;
