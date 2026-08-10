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

export async function executeToolCall(
  name: OperatorToolName,
  rawInput: unknown,
  ctx: ExecutionContext,
): Promise<ToolOutcome> {
  switch (name) {
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
