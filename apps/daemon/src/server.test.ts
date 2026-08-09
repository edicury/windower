import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AudioSettings,
  type CaptureTarget,
  DaemonClient,
  type FakeSidecarOptions,
  type PermissionReport,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassthroughService } from "./passthrough.js";
import { DaemonServer } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { type SpawnedFakeSidecar, createFakeSidecarFactory } from "./test-helpers/fake-sidecar-factory.js";

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

describe("DaemonServer", () => {
  let dir: string;
  let socketPath: string;
  let server: DaemonServer;
  let manager: SessionManager;
  let fakeSpawns: SpawnedFakeSidecar[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-daemon-server-"));
    socketPath = join(dir, "daemon.sock");
  });

  afterEach(async () => {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function start(
    idleTimeoutMs = 60_000,
    idleCheckIntervalMs = 1_000,
    sidecarOptions: {
      capabilities?: FakeSidecarOptions["capabilities"];
      permissions?: Partial<PermissionReport>;
    } = {},
  ) {
    const store = new SessionStore();
    const { spawnSidecar, spawns } = createFakeSidecarFactory({
      targets: [DISPLAY_TARGET],
      capabilities: sidecarOptions.capabilities,
      permissions: sidecarOptions.permissions,
    });
    fakeSpawns = spawns;
    manager = new SessionManager({ store, spawnSidecar });
    const passthrough = new PassthroughService(spawnSidecar);
    server = new DaemonServer(manager, passthrough, {
      socketPath,
      idleTimeoutMs,
      idleCheckIntervalMs,
      onIdleShutdown: () => {
        void server.stop();
      },
    });
    return server.start();
  }

  it("sets 0600 perms on the socket file", async () => {
    await start();
    const stats = await stat(socketPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("serves the full start -> get -> stop -> list round trip over the real socket", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));

    const { sessionId } = await client.startRecording({ target: DISPLAY_TARGET });
    const session = await client.getSession({ sessionId });
    expect(session.state).toBe("recording");

    const stopped = await client.stopRecording({ sessionId });
    expect(stopped.outputPath).toBeTruthy();

    const { sessions } = await client.listSessions({});
    expect(sessions.map((s) => s.id)).toContain(sessionId);

    client.dispose();
  });

  it("rejects a second start on the same target with TARGET_ALREADY_RECORDING over the wire", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    await client.startRecording({ target: DISPLAY_TARGET });
    await expect(client.startRecording({ target: DISPLAY_TARGET })).rejects.toMatchObject({
      code: "TARGET_ALREADY_RECORDING",
    });
    client.dispose();
  });

  it("list_targets passthrough works without any active session", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    const { targets } = await client.listTargets({});
    expect(targets).toEqual([DISPLAY_TARGET]);
    client.dispose();
  });

  // ---- Error-taxonomy propagation over the real socket ----
  // `PassthroughService` (resize_window) doesn't wrap sidecar errors itself
  // — regression coverage for the `toDaemonError` fix in server.ts, which
  // used to drop `SidecarError`s (other than DaemonError/ZodError) to
  // INTERNAL_ERROR, losing the real taxonomy code before it reached the
  // wire.
  it("propagates RESIZE_UNSUPPORTED from resize_window over the wire", async () => {
    await start(60_000, 1_000, { capabilities: [] });
    const client = new DaemonClient(createConnection(socketPath));
    await expect(
      client.resizeWindow({
        targetId: DISPLAY_TARGET.id,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toMatchObject({ code: "RESIZE_UNSUPPORTED" });
    client.dispose();
  });

  it("propagates PERMISSION_DENIED from resize_window (Accessibility denied) over the wire", async () => {
    await start(60_000, 1_000, { permissions: { accessibility: "denied" } });
    const client = new DaemonClient(createConnection(socketPath));
    await expect(
      client.resizeWindow({
        targetId: DISPLAY_TARGET.id,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    client.dispose();
  });

  it("propagates UNSUPPORTED_CAPABILITY from start_recording over the wire", async () => {
    await start(60_000, 1_000, { capabilities: [] });
    const client = new DaemonClient(createConnection(socketPath));
    await expect(client.startRecording({ target: DISPLAY_TARGET })).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    client.dispose();
  });

  it("propagates PERMISSION_DENIED from start_recording (Screen Recording denied) over the wire", async () => {
    await start(60_000, 1_000, { permissions: { screenRecording: "denied" } });
    const client = new DaemonClient(createConnection(socketPath));
    await expect(client.startRecording({ target: DISPLAY_TARGET })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    client.dispose();
  });

  it("propagates PERMISSION_DENIED from start_recording (microphone denied) over the wire", async () => {
    await start(60_000, 1_000, { permissions: { microphone: "denied" } });
    const client = new DaemonClient(createConnection(socketPath));
    const audio: AudioSettings = {
      tracks: [{ source: "microphone", enabled: true }],
      separateTracks: false,
    };
    await expect(client.startRecording({ target: DISPLAY_TARGET, audio })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    client.dispose();
  });

  it("surfaces CAPTURE_FAILED via get_session after the sidecar exits mid-recording, over the wire", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    const { sessionId } = await client.startRecording({ target: DISPLAY_TARGET });

    const spawn = fakeSpawns.at(-1);
    spawn?.onExit?.({ code: 1, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the exit handler run

    const session = await client.getSession({ sessionId });
    expect(session.state).toBe("failed");
    expect(session.error?.code).toBe("CAPTURE_FAILED");
    client.dispose();
  });

  it("shuts itself down after the idle timeout with zero active sessions", async () => {
    await start(50, 20);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(connect(socketPath)).rejects.toBeDefined();
  });

  it("shutdown RPC responds then closes the socket", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    await expect(client.shutdown()).resolves.toEqual({ shuttingDown: true });
    client.dispose();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(connect(socketPath)).rejects.toBeDefined();
  });

  function connect(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
  }
});
