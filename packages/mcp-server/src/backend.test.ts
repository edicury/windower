import type { DaemonClient } from "@windower/core";
import { LocalWindower } from "@windower/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_LOCAL_TOOLS,
  type McpToolId,
  defaultGetBackend,
  getLocalWindower,
  resetLocalWindowerForTests,
} from "./backend.js";
import { resetDaemonClientForTests } from "./daemon-client.js";

const { ensureDaemonRunningMock } = vi.hoisted(() => ({
  ensureDaemonRunningMock: vi.fn(),
}));

vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return {
    ...actual,
    ensureDaemonRunning: ensureDaemonRunningMock,
  };
});

describe("MCP_LOCAL_TOOLS (Phase 20 routing)", () => {
  it("marks exactly the five tools contracts/mcp-tools.md names local, plus request_permission", () => {
    // contracts/mcp-tools.md's "Backend routing (Phase 20)" section names
    // check_permissions/list_targets/resize_window/get_session/list_sessions
    // explicitly as `local`; `request_permission` is the MCP counterpart of
    // the CLI's `"permission request"` POLICY_TABLE entry, itself `local`.
    const expectedLocal: McpToolId[] = [
      "list_targets",
      "check_permissions",
      "request_permission",
      "resize_window",
      "get_session",
      "list_sessions",
    ];
    for (const toolId of expectedLocal) {
      expect(MCP_LOCAL_TOOLS.has(toolId)).toBe(true);
    }
  });

  it("does not mark the daemon-backed tools local", () => {
    const expectedDaemon: McpToolId[] = [
      "start_recording",
      "stop_recording",
      "cancel_recording",
      "run_operator",
      "get_operator_run",
      "abort_operator_run",
    ];
    for (const toolId of expectedDaemon) {
      expect(MCP_LOCAL_TOOLS.has(toolId)).toBe(false);
    }
  });
});

describe("getLocalWindower", () => {
  beforeEach(() => {
    resetLocalWindowerForTests();
  });

  it("memoizes one LocalWindower instance for the process", () => {
    const first = getLocalWindower();
    const second = getLocalWindower();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(LocalWindower);
  });
});

describe("defaultGetBackend", () => {
  beforeEach(() => {
    resetLocalWindowerForTests();
    resetDaemonClientForTests();
    ensureDaemonRunningMock.mockReset();
  });

  it("routes every MCP_LOCAL_TOOLS member to the shared LocalWindower without contacting a daemon", async () => {
    const getBackend = defaultGetBackend();
    for (const toolId of MCP_LOCAL_TOOLS) {
      const backend = await getBackend(toolId);
      expect(backend).toBe(getLocalWindower());
    }
    expect(ensureDaemonRunningMock).not.toHaveBeenCalled();
  });

  it("routes daemon-mode tools to ensureDaemonRunning's client, not LocalWindower", async () => {
    const fakeClient = { isDisposed: false } as unknown as DaemonClient;
    ensureDaemonRunningMock.mockResolvedValue(fakeClient);

    const getBackend = defaultGetBackend();
    const backend = await getBackend("start_recording");

    expect(backend).toBe(fakeClient);
    expect(ensureDaemonRunningMock).toHaveBeenCalledTimes(1);
  });
});
