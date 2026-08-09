import { z } from "zod";

/**
 * InputAction — the discriminated union (on `kind`) passed as an array to the
 * sidecar's `performInput` method. See data-model.md §InputAction and
 * contracts/sidecar-protocol.md §Methods.
 *
 * Coordinates are **pixels, global top-left-origin Quartz space** — the same
 * space `TimelineEvent` uses, so a coordinate read out of an event timeline or
 * a `captureFrame` result feeds straight back into `performInput` with no
 * conversion. Points-vs-pixels conversion happens only inside the native
 * sidecar (CLAUDE.md §Units).
 */

export const MouseButtonSchema = z.enum(["left", "right", "other"]);
export type MouseButton = z.infer<typeof MouseButtonSchema>;

export const KeyModifierSchema = z.enum(["cmd", "shift", "ctrl", "alt"]);
export type KeyModifier = z.infer<typeof KeyModifierSchema>;

export const MouseMoveActionSchema = z.object({
  kind: z.literal("mouse_move"),
  x: z.number(),
  y: z.number(),
});
export type MouseMoveAction = z.infer<typeof MouseMoveActionSchema>;

export const MouseDownActionSchema = z.object({
  kind: z.literal("mouse_down"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema,
});
export type MouseDownAction = z.infer<typeof MouseDownActionSchema>;

export const MouseUpActionSchema = z.object({
  kind: z.literal("mouse_up"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema,
});
export type MouseUpAction = z.infer<typeof MouseUpActionSchema>;

export const MouseClickActionSchema = z.object({
  kind: z.literal("mouse_click"),
  x: z.number(),
  y: z.number(),
  button: MouseButtonSchema,
  clickCount: z.number().int().positive().optional(),
});
export type MouseClickAction = z.infer<typeof MouseClickActionSchema>;

export const MouseDragActionSchema = z.object({
  kind: z.literal("mouse_drag"),
  fromX: z.number(),
  fromY: z.number(),
  toX: z.number(),
  toY: z.number(),
  button: MouseButtonSchema,
  durationMs: z.number().nonnegative().optional(),
});
export type MouseDragAction = z.infer<typeof MouseDragActionSchema>;

export const ScrollActionSchema = z.object({
  kind: z.literal("scroll"),
  x: z.number(),
  y: z.number(),
  deltaX: z.number(),
  deltaY: z.number(),
});
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const TypeTextActionSchema = z.object({
  kind: z.literal("type_text"),
  text: z.string(),
});
export type TypeTextAction = z.infer<typeof TypeTextActionSchema>;

export const KeyPressActionSchema = z.object({
  kind: z.literal("key_press"),
  key: z.string(),
  modifiers: z.array(KeyModifierSchema).optional(),
});
export type KeyPressAction = z.infer<typeof KeyPressActionSchema>;

export const WaitActionSchema = z.object({
  kind: z.literal("wait"),
  durationMs: z.number().nonnegative(),
});
export type WaitAction = z.infer<typeof WaitActionSchema>;

export const InputActionSchema = z.discriminatedUnion("kind", [
  MouseMoveActionSchema,
  MouseDownActionSchema,
  MouseUpActionSchema,
  MouseClickActionSchema,
  MouseDragActionSchema,
  ScrollActionSchema,
  TypeTextActionSchema,
  KeyPressActionSchema,
  WaitActionSchema,
]);
export type InputAction = z.infer<typeof InputActionSchema>;

export const INPUT_ACTION_KINDS = [
  "mouse_move",
  "mouse_down",
  "mouse_up",
  "mouse_click",
  "mouse_drag",
  "scroll",
  "type_text",
  "key_press",
  "wait",
] as const;
export type InputActionKind = (typeof INPUT_ACTION_KINDS)[number];

/**
 * Every (x, y) pair an action touches, in global pixel space. Used by
 * guardrail/bounds-clamp logic (contracts/operator.md §Guardrails) and by the
 * sidecar's `INPUT_OUT_OF_BOUNDS` check — `type_text`/`key_press`/`wait` carry
 * no coordinates and therefore yield an empty list.
 */
export function inputActionCoordinates(action: InputAction): Array<{ x: number; y: number }> {
  switch (action.kind) {
    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
    case "mouse_click":
    case "scroll":
      return [{ x: action.x, y: action.y }];
    case "mouse_drag":
      return [
        { x: action.fromX, y: action.fromY },
        { x: action.toX, y: action.toY },
      ];
    default:
      return [];
  }
}
