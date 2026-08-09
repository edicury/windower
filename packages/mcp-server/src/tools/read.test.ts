import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DaemonClient, ListTargetsResult } from "@windower/core";
import { beforeEach, describe, expect, it } from "vitest";
import { registerReadTools } from "./read.js";

/** Minimal fake satisfying only the DaemonClient methods `registerReadTools` calls. */
function fakeDaemonClient(): Pick<DaemonClient, "listTargets"> {
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
