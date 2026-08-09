import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * `shutdown` (Phase 20's `mode: "graceful" | "immediate"` addition) is a
 * daemon-only RPC, never an MCP tool — contracts/mcp-tools.md's `shutdown`
 * section is explicit: "intentionally absent from `packages/mcp-server`'s
 * tool list." `DaemonClient.shutdown({ mode })` (packages/core/src/daemon/
 * client.ts) already exists and already forwards `mode` to the daemon; there
 * is nothing for `packages/mcp-server` to add on top of it beyond making
 * sure no tool named `shutdown` is ever registered here.
 */
describe("shutdown is not an MCP tool (Phase 20)", () => {
  it("the real server's tool list never includes shutdown or list_operator_runs", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("shutdown");
    // list_operator_runs is CLI-only (`windower operate list`), per the same
    // contract section — not this file's focus, but cheap to assert here too.
    expect(names).not.toContain("list_operator_runs");
    expect(names.length).toBeGreaterThan(0);
  });
});
