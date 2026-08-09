import type { ToolSet } from "ai";
import { z } from "zod";

/**
 * The closed tool surface (contracts/operator.md §Tool surface exposed to the
 * model). This is the *complete* set of things an operator run can do — there
 * is deliberately no shell, filesystem, process-spawn, or network tool, in any
 * configuration. `OPERATOR_TOOL_NAMES` is asserted against in tests so the
 * surface can't grow by accident.
 */

export const OPERATOR_TOOL_NAMES = [
  "screenshot",
  "move_mouse",
  "click",
  "double_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "wait",
  "list_targets",
  "resize_window",
  "done",
  "fail",
] as const;

export type OperatorToolName = (typeof OPERATOR_TOOL_NAMES)[number];

const RectInputSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const ToolInputSchemas = {
  screenshot: z.object({
    maxWidth: z.number().int().positive().optional(),
  }),
  move_mouse: z.object({ x: z.number(), y: z.number() }),
  click: z.object({
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "other"]).optional(),
  }),
  double_click: z.object({ x: z.number(), y: z.number() }),
  drag: z.object({
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
  }),
  scroll: z.object({
    x: z.number(),
    y: z.number(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  type_text: z.object({ text: z.string() }),
  press_key: z.object({
    key: z.string().min(1),
    modifiers: z.array(z.enum(["cmd", "shift", "ctrl", "alt"])).optional(),
  }),
  wait: z.object({ ms: z.number().nonnegative() }),
  list_targets: z.object({
    kinds: z.array(z.enum(["display", "window", "app"])).optional(),
  }),
  resize_window: z.object({ targetId: z.string().min(1), bounds: RectInputSchema }),
  done: z.object({ summary: z.string() }),
  fail: z.object({ reason: z.string() }),
} as const satisfies Record<OperatorToolName, z.ZodType>;

export type ToolInput<N extends OperatorToolName> = z.infer<(typeof ToolInputSchemas)[N]>;

const DESCRIPTIONS: Record<OperatorToolName, string> = {
  screenshot:
    "Capture a fresh frame of the target. The image is delivered as the next observation, " +
    "so call this after an action whose effect you need to see.",
  move_mouse: "Move the mouse pointer to an absolute screen coordinate, in pixels.",
  click: "Click at an absolute screen coordinate, in pixels. Defaults to the left button.",
  double_click: "Double-click at an absolute screen coordinate, in pixels.",
  drag: "Press at (fromX, fromY), drag to (toX, toY), and release. Coordinates are pixels.",
  scroll: "Scroll by (deltaX, deltaY) with the pointer at (x, y). Coordinates are pixels.",
  type_text:
    "Type literal text at the current focus. To type a secret, use its placeholder token " +
    "exactly as given in the task (e.g. {{password}}) — the real value is substituted " +
    "outside the model and is never available to you.",
  press_key:
    'Press a single key, optionally with modifiers, e.g. { key: "Return" } or ' +
    '{ key: "a", modifiers: ["cmd"] }.',
  wait: "Wait locally for a bounded number of milliseconds before observing again.",
  list_targets: "List the capturable displays, windows, and apps, with their bounds.",
  resize_window: "Resize/move a window target to the given bounds, in pixels.",
  done: "End the run successfully. Provide a short summary of what was accomplished.",
  fail: "End the run unsuccessfully. Explain why the task cannot be completed.",
};

/**
 * The tool set handed to the AI SDK. Deliberately built **without** `execute`
 * functions: `generateText` returns the tool calls and this package executes
 * them itself, which is what lets guardrails, secret substitution, and step
 * recording sit on the single path between the model and the sidecar.
 */
export function buildToolSet(): ToolSet {
  const tools: Record<string, { description: string; inputSchema: z.ZodType }> = {};
  for (const name of OPERATOR_TOOL_NAMES) {
    tools[name] = {
      description: DESCRIPTIONS[name],
      inputSchema: ToolInputSchemas[name],
    };
  }
  return tools as ToolSet;
}

export function isOperatorToolName(name: string): name is OperatorToolName {
  return (OPERATOR_TOOL_NAMES as readonly string[]).includes(name);
}
