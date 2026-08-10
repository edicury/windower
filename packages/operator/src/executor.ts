import type { InputAction, OperatorCheckpoint, OperatorDeps, ResolvedSecret } from "@windower/core";
import { inputActionCoordinates } from "@windower/core";
import type { z } from "zod";
import { OPERATOR_ERROR_CODES, OperatorError, toOperatorError } from "./errors.js";
import { type BoundsPolicy, type Deadline, assertWithinBounds, sleep } from "./guardrails.js";
import type { RedactedLogger } from "./redaction.js";
import { substituteSecrets } from "./secrets.js";
import { type OperatorToolName, type ToolInput, ToolInputSchemas } from "./tools.js";

/**
 * The single path between a model tool call and the sidecar. Every tool maps
 * 1:1 onto a `deps` method (contracts/operator.md §Tool surface); `wait`,
 * `plan`, `checkpoint`, `done`, and `fail` are the only ones that make no RPC
 * at all.
 */

export interface ExecutionContext {
  deps: OperatorDeps;
  secrets: readonly ResolvedSecret[];
  boundsPolicy: BoundsPolicy;
  signal: AbortSignal;
  deadline: Deadline;
  logger: RedactedLogger;
  /** Set when the previous tool call requested a differently-sized observation. */
  onScreenshotRequest?: (maxWidth: number | undefined) => void;
  /**
   * Phase 22 — set when `observe_elements` shaped the NEXT observation's
   * `enumerateElements` call. Same delivery mechanism as `onScreenshotRequest`:
   * the tool itself returns no payload, the shaping applies to the step after.
   */
  onObserveElementsRequest?: (params: {
    role?: string;
    labelContains?: string;
    maxElements?: number;
  }) => void;
}

export type ToolOutcome =
  | { kind: "result"; result: unknown }
  /**
   * The model called `plan`. Only the *content* is produced here — the
   * revision/`atStepIndex`/`tMs` identity is assigned by the loop (in-process)
   * or by the daemon (`reportPlan`, contracts/operator-loop-protocol.md), never
   * by the model.
   */
  | { kind: "plan"; steps: string[]; rationale?: string }
  /**
   * The model called `checkpoint`. The verification is stated by the turn that
   * observed the screen and recorded verbatim — the runtime never derives,
   * defaults, or infers an outcome (contracts/operator.md §Execution model).
   */
  | { kind: "checkpoint"; checkpoint: OperatorCheckpoint }
  | { kind: "done"; summary: string }
  | { kind: "fail"; reason: string };

function parseInput<N extends OperatorToolName>(name: N, rawInput: unknown): ToolInput<N> {
  const schema = ToolInputSchemas[name] as unknown as z.ZodType<ToolInput<N>>;
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new OperatorError(
      OPERATOR_ERROR_CODES.INVALID_TOOL_INPUT,
      `${name}: invalid arguments — ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** Abort/timeout are checked immediately before every RPC, so abort is prompt. */
function checkAlive(ctx: ExecutionContext): void {
  if (ctx.signal.aborted) {
    throw new OperatorError(OPERATOR_ERROR_CODES.ABORTED, "Operator run aborted.");
  }
  if (ctx.deadline.expired()) {
    throw new OperatorError(
      OPERATOR_ERROR_CODES.TIMEOUT,
      `Operator run exceeded its ${ctx.deadline.timeoutMs}ms wall-clock budget.`,
    );
  }
}

async function performInput(
  ctx: ExecutionContext,
  toolName: string,
  actions: InputAction[],
): Promise<{ performed: number }> {
  for (const action of actions) {
    assertWithinBounds(ctx.boundsPolicy, inputActionCoordinates(action), toolName);
  }
  checkAlive(ctx);
  try {
    return await ctx.deps.performInput(actions);
  } catch (err) {
    throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
  }
}

/**
 * The shape `ElementQuery.swift` actually mints: `ref: "\(generation):\(index)"`,
 * where `generation` is a UUID-ish token with no whitespace or colon and
 * `index` parses as `Int`. Used only to tell "well-formed but expired" apart
 * from "obviously fabricated" when a ref fails to resolve — not to validate a
 * real generation, which only the sidecar can do.
 */
const REF_SHAPE = /^[^\s:]+:\d+$/;

/** Bug fix: a model that invents a ref (e.g. `"Login_btn_ref"`) gets told exactly why, instead of the generic staleness message meant for a ref that really did expire. */
function malformedRefMessage(ref: string): string {
  return `ref '${ref}' is not a valid element ref (expected format like "3:17" from the most recent elements observation) — do not invent refs.`;
}

/**
 * The element-tool re-resolve step (contracts/operator.md: "Element tools
 * resolve, they do not trust"). Re-reads exactly this `ref`'s current
 * attributes/bounds via `enumerateElements({ refs: [ref] })` — the freshness
 * path — and returns its rect's center. Does **not** consume
 * `maxBatchActions`; the action that follows it does.
 *
 * A ref that no longer resolves surfaces as `AX_ELEMENT_STALE`, which is
 * listed in `NON_TERMINAL_OPERATOR_ERROR_CODES` — the caller's generic
 * catch-and-record handling in `run.ts` is what makes this non-terminal, not
 * anything here. A well-formed-but-expired ref keeps the existing staleness
 * wording; a ref that never matched the `<generation>:<index>` shape gets
 * `malformedRefMessage` instead, since the model needs a different
 * correction ("stop inventing refs") than it does for a genuinely stale one
 * ("re-observe and use the fresh ref").
 */
async function resolveElementCenter(
  ctx: ExecutionContext,
  ref: string,
): Promise<{ x: number; y: number }> {
  checkAlive(ctx);
  let resolved: Awaited<ReturnType<OperatorDeps["enumerateElements"]>>;
  try {
    resolved = await ctx.deps.enumerateElements({ refs: [ref] });
  } catch (err) {
    const opErr = toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
    if (opErr.code === OPERATOR_ERROR_CODES.AX_ELEMENT_STALE && !REF_SHAPE.test(ref)) {
      throw new OperatorError(OPERATOR_ERROR_CODES.AX_ELEMENT_STALE, malformedRefMessage(ref));
    }
    throw opErr;
  }
  const element = resolved.elements.find((e) => e.ref === ref);
  if (element === undefined) {
    // Defensive: a well-behaved backend throws `AX_ELEMENT_STALE` itself
    // (fake-sidecar.ts, ElementQuery.swift) rather than returning an empty
    // list, but an empty result is treated the same way either way.
    throw new OperatorError(
      OPERATOR_ERROR_CODES.AX_ELEMENT_STALE,
      REF_SHAPE.test(ref)
        ? `Element ref "${ref}" no longer resolves to a live element.`
        : malformedRefMessage(ref),
    );
  }
  const { bounds } = element;
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

export async function executeToolCall(
  name: OperatorToolName,
  rawInput: unknown,
  ctx: ExecutionContext,
): Promise<ToolOutcome> {
  switch (name) {
    case "observe_elements": {
      const input = parseInput("observe_elements", rawInput);
      ctx.onObserveElementsRequest?.({
        role: input.role,
        labelContains: input.labelContains,
        maxElements: input.maxElements,
      });
      // Same shape as `screenshot`: the filtered list arrives as the next
      // observation, never as an inline payload here.
      return {
        kind: "result",
        result: { ok: true, note: "Filtered element list attached to next observation" },
      };
    }

    case "click_element": {
      const input = parseInput("click_element", rawInput);
      const center = await resolveElementCenter(ctx, input.ref);
      const result = await performInput(ctx, name, [
        {
          kind: "mouse_click",
          x: center.x,
          y: center.y,
          button: input.button ?? "left",
          clickCount: 1,
        },
      ]);
      return { kind: "result", result };
    }

    case "double_click_element": {
      const input = parseInput("double_click_element", rawInput);
      const center = await resolveElementCenter(ctx, input.ref);
      // Two discrete clicks, same reasoning as `double_click`: some AX
      // targets ignore a single `clickCount: 2` click.
      const result = await performInput(ctx, name, [
        { kind: "mouse_click", x: center.x, y: center.y, button: "left", clickCount: 1 },
        { kind: "mouse_click", x: center.x, y: center.y, button: "left", clickCount: 2 },
      ]);
      return { kind: "result", result };
    }

    case "type_into_element": {
      const input = parseInput("type_into_element", rawInput);
      const center = await resolveElementCenter(ctx, input.ref);
      // Same secret-substitution boundary as `type_text` — the only other
      // place a resolved secret value exists (contracts/operator.md §Secret
      // refs point 2). `input.text` (placeholder form) is what gets recorded.
      const text = substituteSecrets(input.text, ctx.secrets);
      const result = await performInput(ctx, name, [
        { kind: "mouse_click", x: center.x, y: center.y, button: "left", clickCount: 1 },
        { kind: "type_text", text },
      ]);
      return { kind: "result", result };
    }

    case "scroll_element": {
      const input = parseInput("scroll_element", rawInput);
      const center = await resolveElementCenter(ctx, input.ref);
      const result = await performInput(ctx, name, [
        { kind: "scroll", x: center.x, y: center.y, deltaX: input.deltaX, deltaY: input.deltaY },
      ]);
      return { kind: "result", result };
    }

    case "screenshot": {
      const input = parseInput("screenshot", rawInput);
      ctx.onScreenshotRequest?.(input.maxWidth);
      // The frame itself arrives as the next observation, so the tool result is
      // only an acknowledgement — never a second copy of the image.
      return {
        kind: "result",
        result: { ok: true, note: "New frame attached to next observation" },
      };
    }

    case "move_mouse": {
      const input = parseInput("move_mouse", rawInput);
      const result = await performInput(ctx, name, [
        { kind: "mouse_move", x: input.x, y: input.y },
      ]);
      return { kind: "result", result };
    }

    case "click": {
      const input = parseInput("click", rawInput);
      const result = await performInput(ctx, name, [
        {
          kind: "mouse_click",
          x: input.x,
          y: input.y,
          button: input.button ?? "left",
          clickCount: 1,
        },
      ]);
      return { kind: "result", result };
    }

    case "double_click": {
      const input = parseInput("double_click", rawInput);
      // Two discrete clicks, per contracts/operator.md's mapping — not one
      // click with clickCount: 2, which some AX targets ignore.
      const result = await performInput(ctx, name, [
        { kind: "mouse_click", x: input.x, y: input.y, button: "left", clickCount: 1 },
        { kind: "mouse_click", x: input.x, y: input.y, button: "left", clickCount: 2 },
      ]);
      return { kind: "result", result };
    }

    case "drag": {
      const input = parseInput("drag", rawInput);
      const result = await performInput(ctx, name, [
        {
          kind: "mouse_drag",
          fromX: input.fromX,
          fromY: input.fromY,
          toX: input.toX,
          toY: input.toY,
          button: "left",
        },
      ]);
      return { kind: "result", result };
    }

    case "scroll": {
      const input = parseInput("scroll", rawInput);
      const result = await performInput(ctx, name, [
        { kind: "scroll", x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY },
      ]);
      return { kind: "result", result };
    }

    case "type_text": {
      const input = parseInput("type_text", rawInput);
      // ── Secret substitution boundary ────────────────────────────────────
      // This is the ONLY place a resolved secret value exists. `input.text`
      // (placeholder form) is what the model sent and what gets recorded;
      // `text` (resolved) is constructed here, handed straight to the RPC,
      // and never returned, logged, or persisted.
      const text = substituteSecrets(input.text, ctx.secrets);
      const result = await performInput(ctx, name, [{ kind: "type_text", text }]);
      return { kind: "result", result };
    }

    case "press_key": {
      const input = parseInput("press_key", rawInput);
      const result = await performInput(ctx, name, [
        { kind: "key_press", key: input.key, modifiers: input.modifiers },
      ]);
      return { kind: "result", result };
    }

    case "wait": {
      const input = parseInput("wait", rawInput);
      checkAlive(ctx);
      const ms = Math.min(input.ms, ctx.deadline.remainingMs());
      await sleep(ms, ctx.signal);
      return { kind: "result", result: { waitedMs: ms } };
    }

    case "list_targets": {
      const input = parseInput("list_targets", rawInput);
      checkAlive(ctx);
      try {
        return { kind: "result", result: await ctx.deps.listTargets(input.kinds) };
      } catch (err) {
        throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
      }
    }

    case "resize_window": {
      const input = parseInput("resize_window", rawInput);
      checkAlive(ctx);
      try {
        return {
          kind: "result",
          result: await ctx.deps.resizeWindow(input.targetId, input.bounds),
        };
      } catch (err) {
        throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
      }
    }

    case "plan": {
      const input = parseInput("plan", rawInput);
      // No RPC, no guardrail budget: planning is a bookkeeping call.
      return { kind: "plan", steps: [...input.steps], rationale: input.rationale };
    }

    case "checkpoint": {
      const input = parseInput("checkpoint", rawInput);
      // No RPC, no native capability, no guardrail budget — verification is a
      // bookkeeping call, exactly like `plan`.
      return {
        kind: "checkpoint",
        checkpoint: {
          expectation: input.expectation,
          outcome: input.outcome,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
          ...(input.visual === undefined ? {} : { visual: input.visual }),
        },
      };
    }

    case "done": {
      const input = parseInput("done", rawInput);
      return { kind: "done", summary: input.summary };
    }

    case "fail": {
      const input = parseInput("fail", rawInput);
      return { kind: "fail", reason: input.reason };
    }
  }
}
