import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AudioSettings,
  type CaptureTarget,
  DaemonClient,
  type FakeSidecarOptions,
  type OperatorDeps,
  type OperatorRunOptions,
  type OperatorRunResult,
  type PermissionReport,
  type RunOperator,
} from "@windower/core";
import {
  OperatorRunEngine,
  OperatorRunStore,
  PassthroughService,
  RecordingEngine,
  SessionStore,
} from "@windower/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonServer } from "./server.js";
import {
  type SpawnedFakeSidecar,
  createFakeSidecarFactory,
} from "./test-helpers/fake-sidecar-factory.js";

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const MODEL = { provider: "anthropic", model: "claude-sonnet-5" };

describe("DaemonServer", () => {
  let dir: string;
  let socketPath: string;
  let windowerHome: string;
  let server: DaemonServer;
  let manager: RecordingEngine;
  let operatorRunManager: OperatorRunEngine;
  let fakeSpawns: SpawnedFakeSidecar[];
  /** Swappable per-test operator loop stub — defaults to an instant success. */
  let operatorRunnerImpl: RunOperator = async () => ({ state: "succeeded", steps: [] });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-daemon-server-"));
    socketPath = join(dir, "daemon.sock");
    windowerHome = dir;
    operatorRunnerImpl = async () => ({ state: "succeeded", steps: [] });
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
    manager = new RecordingEngine({ store, spawnSidecar });
    const passthrough = new PassthroughService(spawnSidecar);
    operatorRunManager = new OperatorRunEngine({
      store: new OperatorRunStore(),
      sessionManager: manager,
      passthrough,
      spawnSidecar,
      // Never reached by most of these tests, but keeps the dispatch path
      // from lazily importing @windower/operator if one ever does.
      loadRunOperator: async () => operatorRunnerImpl,
    });
    server = new DaemonServer(manager, passthrough, operatorRunManager, {
      socketPath,
      windowerHome,
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

  // checkIdle (phase-20-daemon-optional.md): an `operate --no-record` run has
  // no recording session, so counting only `activeSessionCount` would let
  // idle-shutdown fire out from under an in-flight run.
  it("does not idle-shut-down while an operator run is still active, even with zero recording sessions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    operatorRunnerImpl = async () => {
      await gate;
      return { state: "succeeded", steps: [] };
    };
    await start(50, 20);
    const client = new DaemonClient(createConnection(socketPath));
    await client.runOperator({ task: "do a thing", model: MODEL });

    await new Promise((resolve) => setTimeout(resolve, 200));
    // Idle timeout has long since elapsed, but the run is still in flight —
    // the socket must still be reachable.
    await expect(connect(socketPath)).resolves.toBeUndefined();

    release();
    client.dispose();
  });

  // ---- hello / daemon_info (contracts/daemon-rpc.md) ----

  it("hello returns the daemon's identity and stores the connection's env for later calls", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    const identity = await client.hello({
      clientName: "windower-cli",
      clientVersion: "0.0.0-test",
      protocolVersion: 1,
      windowerHome,
      cwd: dir,
    });
    expect(identity.windowerHome).toBe(windowerHome);
    expect(identity.socketPath).toBe(socketPath);
    expect(typeof identity.pid).toBe("number");
    expect(typeof identity.version).toBe("string");
    expect(identity.protocolVersion).toBe(1);
    client.dispose();
  });

  it("daemon_info returns the same identity shape without requiring hello first", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    const info = await client.daemonInfo();
    expect(info.windowerHome).toBe(windowerHome);
    expect(info.socketPath).toBe(socketPath);
    client.dispose();
  });

  it("rejects hello with DAEMON_VERSION_MISMATCH on a windowerHome disagreement", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    await expect(
      client.hello({
        clientName: "windower-cli",
        clientVersion: "0.0.0-test",
        protocolVersion: 1,
        windowerHome: "/somewhere/else",
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: "DAEMON_VERSION_MISMATCH" });
    client.dispose();
  });

  // ---- Root fix: caller env reaches resolveModel via a snapshot, not the daemon's own process.env ----

  it("passes the hello-scoped env snapshot through to the operator run's options (env-passthrough regression)", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    operatorRunnerImpl = async (options: OperatorRunOptions, _deps: OperatorDeps) => {
      seenEnv = options.env;
      return { state: "succeeded", steps: [] } satisfies OperatorRunResult;
    };
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    await client.hello({
      clientName: "windower-cli",
      clientVersion: "0.0.0-test",
      protocolVersion: 1,
      windowerHome,
      cwd: dir,
      env: { apiKeyEnvVar: "ANTHROPIC_API_KEY", apiKeyValue: "caller-key-not-in-daemon-env" },
    });

    // The daemon process itself must not have this var set — otherwise the
    // test can't distinguish "passed through" from "already there".
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    await client.runOperator({ task: "do a thing", model: MODEL });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the run's loop invoke the stub
    expect(seenEnv?.ANTHROPIC_API_KEY).toBe("caller-key-not-in-daemon-env");
    client.dispose();
  });

  // ---- Graceful shutdown (contracts/daemon-rpc.md "Graceful shutdown") ----

  it("shutdown({mode: graceful}) finalizes an in-flight recording before closing the socket", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    const { sessionId } = await client.startRecording({ target: DISPLAY_TARGET });
    expect((await client.getSession({ sessionId })).state).toBe("recording");

    await expect(client.shutdown({ mode: "graceful" })).resolves.toEqual({ shuttingDown: true });
    client.dispose();

    // The session must be finalized (video/manifest/events written), not
    // left `recording` for crash-recovery to mark `failed` on next start.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const session = manager.getSession({ sessionId });
    expect(session.state).toBe("finalized");
    expect(session.outputPath).toBeTruthy();

    await expect(connect(socketPath)).rejects.toBeDefined();
  });

  it("shutdown({mode: immediate}) skips the drain and closes the socket without finalizing", async () => {
    await start();
    const client = new DaemonClient(createConnection(socketPath));
    const { sessionId } = await client.startRecording({ target: DISPLAY_TARGET });

    await expect(client.shutdown({ mode: "immediate" })).resolves.toEqual({ shuttingDown: true });
    client.dispose();

    await new Promise((resolve) => setTimeout(resolve, 50));
    // Left exactly as it was — `recording` — for the next daemon start's
    // recoverCrashedSessions() to mark failed, per contracts/daemon-rpc.md.
    const session = manager.getSession({ sessionId });
    expect(session.state).toBe("recording");

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
