import { type DaemonClient, DaemonError } from "@windower/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ZodError, z } from "zod";
import {
  MCP_CLIENT_NAME,
  connectForOperatorRun,
  getDaemonClient,
  resetDaemonClientForTests,
  toMcpError,
} from "./daemon-client.js";

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

/** Minimal fake standing in for `DaemonClient` — only `isDisposed` matters here. */
function makeFakeClient(): { isDisposed: boolean } {
  return { isDisposed: false };
}

describe("toMcpError", () => {
  it("maps a DaemonError to an isError result carrying its code", () => {
    const result = toMcpError(new DaemonError("DAEMON_UNREACHABLE", "no daemon"));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("DAEMON_UNREACHABLE");
    expect(result.content[0]?.text).toContain("no daemon");
  });

  it("maps a ZodError to an INVALID_ARGS-tagged isError result", () => {
    const schema = z.object({ targetId: z.string() });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    const zodError = (parsed as { success: false; error: ZodError }).error;

    const result = toMcpError(zodError);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INVALID_ARGS");
  });

  it("maps a generic Error to an INTERNAL_ERROR-tagged isError result", () => {
    const result = toMcpError(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INTERNAL_ERROR");
    expect(result.content[0]?.text).toContain("boom");
  });

  it("maps a non-Error throw to an INTERNAL_ERROR-tagged isError result", () => {
    const result = toMcpError("just a string");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INTERNAL_ERROR");
    expect(result.content[0]?.text).toContain("just a string");
  });
});

describe("getDaemonClient", () => {
  beforeEach(() => {
    resetDaemonClientForTests();
    ensureDaemonRunningMock.mockReset();
  });

  it("memoizes the client across calls while it stays connected", async () => {
    const client = makeFakeClient();
    ensureDaemonRunningMock.mockResolvedValue(client);

    const first = await getDaemonClient();
    const second = await getDaemonClient();

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(ensureDaemonRunningMock).toHaveBeenCalledTimes(1);
  });

  it("self-heals: reconnects once the memoized client dies mid-session instead of replaying DAEMON_UNREACHABLE forever", async () => {
    const deadClient = makeFakeClient();
    const freshClient = makeFakeClient();
    ensureDaemonRunningMock
      .mockResolvedValueOnce(deadClient as unknown as DaemonClient)
      .mockResolvedValueOnce(freshClient as unknown as DaemonClient);

    const first = await getDaemonClient();
    expect(first).toBe(deadClient);
    expect(ensureDaemonRunningMock).toHaveBeenCalledTimes(1);

    // Simulate the underlying daemon dying mid-session (crash, `windower
    // daemon stop`, a restart for a new build, ...): the socket closes and
    // the memoized DaemonClient flips to disposed.
    deadClient.isDisposed = true;

    const second = await getDaemonClient();
    expect(second).toBe(freshClient);
    expect(ensureDaemonRunningMock).toHaveBeenCalledTimes(2);

    // And it stays memoized/healthy afterwards rather than reconnecting on
    // every call.
    const third = await getDaemonClient();
    expect(third).toBe(freshClient);
    expect(ensureDaemonRunningMock).toHaveBeenCalledTimes(2);
  });

  it("passes this process's identity (clientName/clientVersion) to ensureDaemonRunning", async () => {
    const client = makeFakeClient();
    ensureDaemonRunningMock.mockResolvedValue(client);

    await getDaemonClient();

    expect(ensureDaemonRunningMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: MCP_CLIENT_NAME }),
    );
  });
});

describe("connectForOperatorRun (Phase 20 env-scoped operator connection)", () => {
  beforeEach(() => {
    ensureDaemonRunningMock.mockReset();
  });

  it("establishes a fresh connection per call — never memoized — passing `env` straight through", async () => {
    const clientA = makeFakeClient();
    const clientB = makeFakeClient();
    ensureDaemonRunningMock.mockResolvedValueOnce(clientA).mockResolvedValueOnce(clientB);

    const env = { apiKeyEnvVar: "ANTHROPIC_API_KEY", apiKeyValue: "sk-test" };
    const first = await connectForOperatorRun(env);
    const second = await connectForOperatorRun(env);

    expect(first).toBe(clientA);
    expect(second).toBe(clientB);
    expect(ensureDaemonRunningMock).toHaveBeenCalledTimes(2);
    expect(ensureDaemonRunningMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ clientName: MCP_CLIENT_NAME, env }),
    );
    expect(ensureDaemonRunningMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ clientName: MCP_CLIENT_NAME, env }),
    );
  });

  it("passes env: undefined through unchanged when no scoped env applies", async () => {
    const client = makeFakeClient();
    ensureDaemonRunningMock.mockResolvedValue(client);

    await connectForOperatorRun(undefined);

    expect(ensureDaemonRunningMock).toHaveBeenCalledWith(
      expect.objectContaining({ env: undefined }),
    );
  });
});
