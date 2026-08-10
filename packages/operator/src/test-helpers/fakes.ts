import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { CaptureTarget, InputAction, OperatorDeps, Rect } from "@windower/core";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Test doubles for the operator loop. No network, no sidecar, no daemon:
 * `OperatorDeps` is a plain object and the model is the AI SDK's own mock, so
 * every test in this package runs offline and deterministically.
 */

export interface FakeDepsCalls {
  captureFrame: Array<{ format: string; maxWidth?: number }>;
  performInput: InputAction[][];
  listTargets: Array<Array<"display" | "window" | "app"> | undefined>;
  resizeWindow: Array<{ targetId: string; bounds: Rect }>;
}

export interface FakeDeps extends OperatorDeps {
  calls: FakeDepsCalls;
}

/** A 1x1 transparent PNG, base64. Small enough to keep test fixtures readable. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function createFakeDeps(
  overrides: Partial<OperatorDeps> & { onPerformInput?: (actions: InputAction[]) => void } = {},
): FakeDeps {
  const calls: FakeDepsCalls = {
    captureFrame: [],
    performInput: [],
    listTargets: [],
    resizeWindow: [],
  };

  const targets: CaptureTarget[] = [
    {
      kind: "window",
      id: "window:1",
      title: "Demo",
      appName: "Demo",
      appBundleId: "co.windower.demo",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isFocused: true,
      resizable: true,
    },
  ];

  const deps: FakeDeps = {
    calls,
    async captureFrame(params) {
      calls.captureFrame.push(params);
      if (overrides.captureFrame) return overrides.captureFrame(params);
      return { imageBase64: TINY_PNG_BASE64, width: 1920, height: 1080, scale: 2 };
    },
    async performInput(actions) {
      calls.performInput.push(actions);
      overrides.onPerformInput?.(actions);
      if (overrides.performInput) return overrides.performInput(actions);
      return { performed: actions.length };
    },
    async listTargets(kinds) {
      calls.listTargets.push(kinds);
      if (overrides.listTargets) return overrides.listTargets(kinds);
      return targets;
    },
    async resizeWindow(targetId, bounds) {
      calls.resizeWindow.push({ targetId, bounds });
      if (overrides.resizeWindow) return overrides.resizeWindow(targetId, bounds);
      return { actualBounds: bounds, result: "success" };
    },
  };

  return deps;
}

export interface ScriptedTurn {
  /** Assistant text for this turn (also used as the step's `reasoning`). */
  text?: string;
  toolCalls?: Array<{ name: string; args: unknown; toolCallId?: string }>;
}

/**
 * A `MockLanguageModelV4` that replays a fixed script of turns. When the script
 * runs out the last turn repeats, which is what lets the maxSteps/timeout tests
 * loop forever without a bespoke model.
 */
export function createScriptedModel(
  turns: ScriptedTurn[],
  options: { provider?: string; modelId?: string; onCall?: () => void } = {},
): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    provider: options.provider ?? "mock",
    modelId: options.modelId ?? "mock-model",
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
      options.onCall?.();
      const turn = turns[Math.min(index, turns.length - 1)] ?? {};
      index += 1;
      const toolCalls = turn.toolCalls ?? [];
      return {
        content: [
          ...(turn.text === undefined ? [] : [{ type: "text" as const, text: turn.text }]),
          ...toolCalls.map((call, i) => ({
            type: "tool-call" as const,
            toolCallId: call.toolCallId ?? `call-${index}-${i}`,
            toolName: call.name,
            input: JSON.stringify(call.args),
          })),
        ],
        finishReason: {
          unified: toolCalls.length > 0 ? "tool-calls" : "stop",
          raw: toolCalls.length > 0 ? "tool_use" : "end_turn",
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}
