import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AbortOperatorRunResult,
  type DaemonClient,
  DaemonError,
  type GetOperatorRunResult,
  type OperatorRun,
  OperatorRunSchema,
  RunOperatorParamsSchema,
  type RunOperatorResult,
} from "@windower/core";
import { beforeEach, describe, expect, it } from "vitest";
import { registerOperatorTools } from "./operator.js";

const runId = "22222222-2222-2222-2222-222222222222";

const validRun: OperatorRun = {
  id: runId,
  state: "running",
  task: "Open the app, log in as {{user}}, create an incident",
  model: { provider: "anthropic", model: "claude-sonnet-5" },
  sessionId: "11111111-1111-1111-1111-111111111111",
  steps: [
    {
      index: 0,
      observationRef: "frames/0.png",
      toolCalls: [{ name: "type_text", args: { text: "{{password}}" } }],
      tMs: 1200,
    },
  ],
  startedAt: "2026-08-09T00:00:00.000Z",
};

type FakeDaemonClient = Pick<DaemonClient, "runOperator" | "getOperatorRun" | "abortOperatorRun">;

function fakeDaemonClient(overrides: Partial<FakeDaemonClient> = {}): FakeDaemonClient {
  return {
    runOperator: async (): Promise<RunOperatorResult> => ({ runId }),
    getOperatorRun: async (): Promise<GetOperatorRunResult> => validRun,
    abortOperatorRun: async (): Promise<AbortOperatorRunResult> => ({ aborted: true }),
    ...overrides,
  };
}

async function connectServer(fake: FakeDaemonClient) {
  const server = new McpServer({ name: "windower-test", version: "0.0.0" });
  registerOperatorTools(server, async () => fake as unknown as DaemonClient);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("registerOperatorTools (round-trip via an in-memory MCP client)", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connectServer(fakeDaemonClient());
  });

  it("lists exactly the three operator tools from contracts/mcp-tools.md", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["abort_operator_run", "get_operator_run", "run_operator"]);
    // `list_operator_runs` is a daemon RPC behind `windower operate list`, but
    // is deliberately not an MCP tool.
    expect(names).not.toContain("list_operator_runs");
  });

  it("run_operator returns promptly with just a runId (non-blocking, two-call semantic)", async () => {
    const startedAt = Date.now();
    const result = await client.callTool({
      name: "run_operator",
      arguments: {
        task: "Open the app and create an incident",
        model: { provider: "anthropic", model: "claude-sonnet-5" },
      },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ runId });
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("accepts the full CLI-equivalent param shape (recording + secrets + guardrails)", async () => {
    let seen: unknown;
    const c = await connectServer(
      fakeDaemonClient({
        runOperator: async (params) => {
          seen = params;
          return { runId };
        },
      }),
    );

    const args = {
      task: "Open waroom.co, log in as {{user}}/{{password}}, create an incident",
      model: {
        provider: "openai-compatible",
        model: "llama3:8b",
        baseUrl: "http://localhost:11434/v1",
      },
      recording: {
        video: { fps: 30, resolution: { width: 1920, height: 1080 } },
        outputDir: "/tmp/out",
      },
      secrets: [
        { name: "user", source: "env", ref: "DEMO_USER" },
        { name: "password", source: "keychain", ref: "waroom" },
      ],
      guardrails: { maxSteps: 20, timeoutSeconds: 120 },
    };

    const result = await c.callTool({ name: "run_operator", arguments: args });
    expect(result.isError).toBeFalsy();
    // Parity: the same object the CLI's `--json` path builds also validates
    // against the core schema, and reaches the daemon client unchanged.
    expect(RunOperatorParamsSchema.parse(args)).toEqual(args);
    expect(seen).toEqual(args);
  });

  it("rejects params that violate the core schema (bad secret source)", async () => {
    const result = await client.callTool({
      name: "run_operator",
      arguments: {
        task: "t",
        model: { provider: "anthropic", model: "claude-sonnet-5" },
        secrets: [{ name: "p", source: "vault", ref: "x" }],
      },
    });
    expect(result.isError).toBe(true);
  });

  it("round-trips get_operator_run, including the redacted step transcript", async () => {
    const result = await client.callTool({ name: "get_operator_run", arguments: { runId } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(validRun);
    // Schema parity with the CLI's `windower operate status --json` output.
    expect(OperatorRunSchema.parse(result.structuredContent)).toEqual(validRun);
    // Secrets are placeholders, never values.
    expect(JSON.stringify(result.structuredContent)).toContain("{{password}}");
  });

  it("round-trips abort_operator_run", async () => {
    const result = await client.callTool({ name: "abort_operator_run", arguments: { runId } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ aborted: true });
  });

  it("surfaces a guardrail failure in get_operator_run's structured output, not as a thrown error", async () => {
    const failedRun: OperatorRun = {
      ...validRun,
      state: "failed",
      endedAt: "2026-08-09T00:05:00.000Z",
      error: { code: "INPUT_OUT_OF_BOUNDS", message: "click at (5000, 12) outside target bounds" },
    };
    const c = await connectServer(fakeDaemonClient({ getOperatorRun: async () => failedRun }));

    const result = await c.callTool({ name: "get_operator_run", arguments: { runId } });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as OperatorRun).error?.code).toBe("INPUT_OUT_OF_BOUNDS");
  });
});

describe("registerOperatorTools error path", () => {
  it("maps OPERATOR_RUN_NOT_FOUND to an MCP tool error result", async () => {
    const c = await connectServer(
      fakeDaemonClient({
        getOperatorRun: async () => {
          throw new DaemonError("OPERATOR_RUN_NOT_FOUND", "no such run");
        },
      }),
    );

    const result = await c.callTool({
      name: "get_operator_run",
      arguments: { runId: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("OPERATOR_RUN_NOT_FOUND");
  });

  it("maps PERMISSION_DENIED (Accessibility for synthetic input) from run_operator", async () => {
    const c = await connectServer(
      fakeDaemonClient({
        runOperator: async () => {
          throw new DaemonError("PERMISSION_DENIED", "Accessibility permission not granted");
        },
      }),
    );

    const result = await c.callTool({
      name: "run_operator",
      arguments: { task: "t", model: { provider: "anthropic", model: "claude-sonnet-5" } },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("PERMISSION_DENIED");
  });
});

describe("operator tool descriptions steer the calling agent", () => {
  it("run_operator's description names the default flow, secrets, and guardrails", async () => {
    const client = await connectServer(fakeDaemonClient());
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "run_operator")?.description ?? "";

    expect(description).toMatch(/start_recording/);
    expect(description).toMatch(/stop_recording/);
    expect(description).toMatch(/NOT the default|not the default/);
    expect(description).toMatch(/\{\{name\}\}/);
    expect(description).toMatch(/never|no shell/i);
    expect(description).toMatch(/guardrail/i);
    expect(description).toMatch(/immediately/i);
  });
});
