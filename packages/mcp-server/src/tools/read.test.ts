import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type DaemonClient, DaemonError, type ListTargetsResult } from "@windower/core";
import { beforeEach, describe, expect, it } from "vitest";
import { registerReadTools } from "./read.js";

/** Minimal fake satisfying only the DaemonClient methods `registerReadTools` calls. */
function fakeDaemonClient(
  overrides: Partial<Pick<DaemonClient, "listTargets" | "resizeWindow">> = {},
): Pick<DaemonClient, "listTargets" | "resizeWindow"> {
  return {
    listTargets: async (): Promise<ListTargetsResult> => ({
      targets: [
        {
          kind: "display",
          id: "display-1",
          name: "Built-in Display",
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          isPrimary: true,
          scaleFactor: 2,
        },
      ],
    }),
    resizeWindow: async () => ({
      actualBounds: { x: 0, y: 0, width: 800, height: 600 },
      result: "success",
    }),
    ...overrides,
  };
}

describe("registerReadTools (round-trip via an in-memory MCP client)", () => {
  let client: Client;

  beforeEach(async () => {
    const server = new McpServer({ name: "windower-test", version: "0.0.0" });
    const fake = fakeDaemonClient();
    registerReadTools(server, async () => fake as unknown as DaemonClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it("lists list_targets among the registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_targets",
        "check_permissions",
        "request_permission",
        "resize_window",
      ]),
    );
  });

  it("round-trips list_targets through the fake DaemonClient", async () => {
    const result = await client.callTool({ name: "list_targets", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      targets: [
        {
          kind: "display",
          id: "display-1",
          name: "Built-in Display",
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          isPrimary: true,
          scaleFactor: 2,
        },
      ],
    });
  });
});

describe("registerReadTools error path (resize_window)", () => {
  async function connectServerWithResizeError(err: DaemonError) {
    const server = new McpServer({ name: "windower-test", version: "0.0.0" });
    const fake = fakeDaemonClient({
      resizeWindow: async () => {
        throw err;
      },
    });
    registerReadTools(server, async () => fake as unknown as DaemonClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("maps RESIZE_UNSUPPORTED to an MCP tool error result", async () => {
    const client = await connectServerWithResizeError(
      new DaemonError("RESIZE_UNSUPPORTED", "Backend does not support window-control"),
    );
    const result = await client.callTool({
      name: "resize_window",
      arguments: { targetId: "42", bounds: { x: 0, y: 0, width: 100, height: 100 } },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("RESIZE_UNSUPPORTED");
  });

  it("maps UNSUPPORTED_CAPABILITY to an MCP tool error result", async () => {
    const client = await connectServerWithResizeError(
      new DaemonError("UNSUPPORTED_CAPABILITY", "Sidecar does not advertise resizeWindow"),
    );
    const result = await client.callTool({
      name: "resize_window",
      arguments: { targetId: "42", bounds: { x: 0, y: 0, width: 100, height: 100 } },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("UNSUPPORTED_CAPABILITY");
  });

  it("maps PERMISSION_DENIED (Accessibility not granted) to an MCP tool error result", async () => {
    const client = await connectServerWithResizeError(
      new DaemonError("PERMISSION_DENIED", "Accessibility permission not granted"),
    );
    const result = await client.callTool({
      name: "resize_window",
      arguments: { targetId: "42", bounds: { x: 0, y: 0, width: 100, height: 100 } },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("PERMISSION_DENIED");
  });
});
