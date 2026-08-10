import { describe, expect, it } from "vitest";
import {
  OPERATOR_ACTION_TOOL_NAMES,
  OPERATOR_TOOL_NAMES,
  buildToolSet,
  isActionToolName,
  isOperatorToolName,
} from "./tools.js";

describe("tool surface", () => {
  it("offers exactly the 15 tools in contracts/operator.md, and nothing else", () => {
    expect([...OPERATOR_TOOL_NAMES]).toEqual([
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
      "plan",
      "checkpoint",
      "done",
      "fail",
    ]);
    expect(Object.keys(buildToolSet()).sort()).toEqual([...OPERATOR_TOOL_NAMES].sort());
  });

  it("counts only performInput/resizeWindow tools against the batch budget", () => {
    // contracts/operator-loop-protocol.md §"Batches inside a step": observations
    // and bookkeeping calls are not actions and never consume `maxBatchActions`.
    expect([...OPERATOR_ACTION_TOOL_NAMES]).toEqual([
      "move_mouse",
      "click",
      "double_click",
      "drag",
      "scroll",
      "type_text",
      "press_key",
      "resize_window",
    ]);
    for (const name of [
      "screenshot",
      "list_targets",
      "wait",
      "plan",
      "checkpoint",
      "done",
      "fail",
    ] as const) {
      expect(isActionToolName(name), name).toBe(false);
    }
  });

  it("offers no shell, filesystem, process, or network tool under any name", () => {
    const forbidden = [
      "bash",
      "shell",
      "exec",
      "spawn",
      "run_command",
      "read_file",
      "write_file",
      "fs",
      "fetch",
      "http",
      "request",
      "network",
      "eval",
    ];
    const offered = Object.keys(buildToolSet()).map((n) => n.toLowerCase());
    for (const name of forbidden) {
      expect(offered.some((tool) => tool.includes(name))).toBe(false);
    }
  });

  it("gives every offered tool a description and an input schema", () => {
    const tools = buildToolSet() as Record<string, { description?: string; inputSchema?: unknown }>;
    for (const name of OPERATOR_TOOL_NAMES) {
      expect(tools[name]?.description, name).toBeTruthy();
      expect(tools[name]?.inputSchema, name).toBeDefined();
      expect(isOperatorToolName(name)).toBe(true);
    }
  });

  it("rejects tool names outside the closed surface", () => {
    expect(isOperatorToolName("bash")).toBe(false);
    expect(isOperatorToolName("screenshot ")).toBe(false);
  });
});
