import { describe, expect, it } from "vitest";
import {
  OPERATOR_ACTION_TOOL_NAMES,
  OPERATOR_TOOL_NAMES,
  buildToolSet,
  isActionToolName,
  isOperatorToolName,
} from "./tools.js";

describe("tool surface", () => {
  it("offers exactly the 20 tools in contracts/operator.md, and nothing else", () => {
    expect([...OPERATOR_TOOL_NAMES]).toEqual([
      "observe_elements",
      "click_element",
      "double_click_element",
      "type_into_element",
      "scroll_element",
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

  it("the executor's tool set is the planner's minus `plan`", () => {
    // contracts/operator.md §Model tiers: only the planner may create/revise a
    // plan — removing the tool is what makes that structural.
    const planner = Object.keys(buildToolSet("planner")).sort();
    const executor = Object.keys(buildToolSet("executor")).sort();
    expect(planner).toContain("plan");
    expect(executor).not.toContain("plan");
    expect(executor).toEqual(planner.filter((n) => n !== "plan"));
  });

  it("excludes the 5 element tools from both tiers when elementsAvailable is false", () => {
    // Bug fix: a run-level sticky "AX unavailable" state removes the element
    // tools entirely rather than leaving them present-but-unusable.
    const elementToolNames = [
      "observe_elements",
      "click_element",
      "double_click_element",
      "type_into_element",
      "scroll_element",
    ];
    for (const tier of ["planner", "executor"] as const) {
      const withElements = Object.keys(buildToolSet(tier, true));
      const withoutElements = Object.keys(buildToolSet(tier, false));
      for (const name of elementToolNames) {
        expect(withElements, `${tier} with elements`).toContain(name);
        expect(withoutElements, `${tier} without elements`).not.toContain(name);
      }
      // Nothing else changes.
      expect(withoutElements.sort()).toEqual(
        withElements.filter((n) => !elementToolNames.includes(n)).sort(),
      );
    }
  });

  it("counts only performInput/resizeWindow/element tools against the batch budget", () => {
    // contracts/operator-loop-protocol.md §"Batches inside a step": observations
    // and bookkeeping calls are not actions and never consume `maxBatchActions`.
    expect([...OPERATOR_ACTION_TOOL_NAMES]).toEqual([
      "click_element",
      "double_click_element",
      "type_into_element",
      "scroll_element",
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
      "observe_elements",
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
