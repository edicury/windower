import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type CancelRecordingResult,
  type DaemonClient,
  DaemonError,
  type GetSessionResult,
  type RecordingSession,
  type StartRecordingResult,
  type StopRecordingResult,
} from "@windower/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { GetBackend } from "../backend.js";
import { registerSessionTools } from "./session.js";

const validDisplayTarget = {
  kind: "display" as const,
  id: "1",
  name: "Built-in Display",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const validVideoSettings = {
  fps: 30 as const,
  codec: "h264" as const,
  container: "mp4" as const,
  quality: "high" as const,
  showCursor: true,
};

const validAudioSettings = {
  tracks: [],
  separateTracks: false,
};

const sessionId = "11111111-1111-1111-1111-111111111111";

const validSession: RecordingSession = {
  id: sessionId,
  state: "recording",
  target: validDisplayTarget,
  video: validVideoSettings,
  audio: validAudioSettings,
  startedAt: "2026-08-09T00:00:00.000Z",
};

const validManifest = {
  windowerVersion: "0.0.0",
  sessionId,
  target: validDisplayTarget,
  video: {
    ...validVideoSettings,
    actualResolution: { width: 1920, height: 1080 },
    durationMs: 5000,
  },
  audio: { tracks: [] },
  createdAt: "2026-08-09T00:00:00.000Z",
  file: {
    path: "/tmp/out.mp4",
    sizeBytes: 12345,
    codec: "h264",
    container: "mp4",
  },
};

type FakeDaemonClient = Pick<
  DaemonClient,
  "startRecording" | "getSession" | "stopRecording" | "cancelRecording" | "listSessions"
>;

function fakeDaemonClient(overrides: Partial<FakeDaemonClient> = {}): FakeDaemonClient {
  return {
    startRecording: async (): Promise<StartRecordingResult> => ({ sessionId }),
    getSession: async (): Promise<GetSessionResult> => validSession,
    stopRecording: async (): Promise<StopRecordingResult> => ({
      outputPath: "/tmp/out.mp4",
      manifestPath: "/tmp/manifest.json",
      manifest: validManifest,
    }),
    cancelRecording: async (): Promise<CancelRecordingResult> => ({ canceled: true }),
    listSessions: async () => ({ sessions: [validSession] }),
    ...overrides,
  };
}

async function connectServer(fake: FakeDaemonClient) {
  const server = new McpServer({ name: "windower-test", version: "0.0.0" });
  registerSessionTools(server, (async () => fake) as unknown as GetBackend);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("registerSessionTools (round-trip via an in-memory MCP client)", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connectServer(fakeDaemonClient());
  });

  it("lists all five session tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "start_recording",
        "get_session",
        "stop_recording",
        "cancel_recording",
        "list_sessions",
      ]),
    );
  });

  it("start_recording returns promptly with just a sessionId (two-call, non-blocking semantic)", async () => {
    const startedAt = Date.now();
    const result = await client.callTool({
      name: "start_recording",
      arguments: { target: { targetId: "1" } },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sessionId });
    // Sanity check that this call doesn't block waiting on a recording to
    // finish — the fake resolves instantly, so a huge elapsed time would
    // indicate the tool is doing something other than a direct passthrough.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("round-trips stop_recording through the fake DaemonClient", async () => {
    const result = await client.callTool({
      name: "stop_recording",
      arguments: { sessionId },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      outputPath: "/tmp/out.mp4",
      manifestPath: "/tmp/manifest.json",
      manifest: validManifest,
    });
  });

  it("round-trips get_session through the fake DaemonClient", async () => {
    const result = await client.callTool({
      name: "get_session",
      arguments: { sessionId },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(validSession);
  });

  it("round-trips list_sessions through the fake DaemonClient", async () => {
    const result = await client.callTool({ name: "list_sessions", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sessions: [validSession] });
  });

  it("round-trips cancel_recording through the fake DaemonClient", async () => {
    const result = await client.callTool({
      name: "cancel_recording",
      arguments: { sessionId },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ canceled: true });
  });
});

describe("registerSessionTools error path", () => {
  it("maps a DaemonError thrown by cancel_recording to an MCP tool error result", async () => {
    const fake = fakeDaemonClient({
      cancelRecording: async () => {
        throw new DaemonError("SESSION_NOT_FOUND", "no such session");
      },
    });
    const client = await connectServer(fake);

    const result = await client.callTool({
      name: "cancel_recording",
      arguments: { sessionId: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("SESSION_NOT_FOUND");
  });

  it("maps PERMISSION_DENIED (Screen Recording not granted) from start_recording to an MCP tool error result", async () => {
    const fake = fakeDaemonClient({
      startRecording: async () => {
        throw new DaemonError("PERMISSION_DENIED", "Screen Recording permission not granted");
      },
    });
    const client = await connectServer(fake);

    const result = await client.callTool({
      name: "start_recording",
      arguments: { target: { targetId: "1" } },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("PERMISSION_DENIED");
  });

  it("maps PERMISSION_DENIED (microphone not granted) from start_recording to an MCP tool error result", async () => {
    const fake = fakeDaemonClient({
      startRecording: async () => {
        throw new DaemonError("PERMISSION_DENIED", "Microphone permission not granted");
      },
    });
    const client = await connectServer(fake);

    const result = await client.callTool({
      name: "start_recording",
      arguments: {
        target: { targetId: "1" },
        audio: { tracks: [{ source: "microphone", enabled: true }], separateTracks: false },
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("PERMISSION_DENIED");
  });

  it("surfaces CAPTURE_FAILED in get_session's structured output (session data, not a thrown error)", async () => {
    const failedSession: RecordingSession = {
      ...validSession,
      state: "failed",
      stoppedAt: "2026-08-09T00:00:05.000Z",
      error: { code: "CAPTURE_FAILED", message: "Sidecar-initiated stop: target-closed" },
    };
    const fake = fakeDaemonClient({
      getSession: async () => failedSession,
    });
    const client = await connectServer(fake);

    const result = await client.callTool({ name: "get_session", arguments: { sessionId } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(failedSession);
    expect((result.structuredContent as RecordingSession).error?.code).toBe("CAPTURE_FAILED");
  });
});
