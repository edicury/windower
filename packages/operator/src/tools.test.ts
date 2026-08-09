import { describe, expect, it } from "vitest";
import { OPERATOR_TOOL_NAMES, buildToolSet, isOperatorToolName } from "./tools.js";

describe("tool surface", () => {
  it("offers exactly the 13 tools in contracts/operator.md, and nothing else", () => {
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
      "done",
      "fail",
    ]);
    expect(Object.keys(buildToolSet()).sort()).toEqual([...OPERATOR_TOOL_NAMES].sort());
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
