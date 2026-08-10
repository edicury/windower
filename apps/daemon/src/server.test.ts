import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AudioSettings,
  type CaptureTarget,
  DaemonClient,
  type FakeSidecarOptions,
  type LoopReadyResult,
  type PermissionReport,
  WINDOWER_HOME_ENV,
} from "@windower/core";
import {
  CaptureLock,
  ControlEngine,
  FakeLoopChild,
  type LoopChildFactory,
  OperatorRunEngine,
  OperatorRunStore,
  PassthroughService,
  RecordingEngine,
  SessionStore,
  resetCaptureHoldsForTesting,
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
  let captureLock: CaptureLock;
  let controlEngine: ControlEngine;
  /**
   * Swappable per-test script for the operator **loop child process**
   * (`contracts/operator-loop-protocol.md`) — defaults to an instant success.
   * Since Phase 21 the loop is its own OS process, so a test stubs the wire,
   * not an in-process function.
   */
  type LoopScript = (child: FakeLoopChild, config: LoopReadyResult) => Promise<void>;
  const INSTANT_SUCCESS: LoopScript = async (child) => {
    await child.request("reportResult", { state: "succeeded" });
  };
  let loopScript: LoopScript = INSTANT_SUCCESS;

  /** One fake child per run, handshaking exactly as a real one does. */
  const spawnLoopChild: LoopChildFactory = () => {
    const child = new FakeLoopChild();
    void (async () => {
      const config = await child.handshake();
      await loopScript(child, config);
      child.exit(0);
    })().catch(() => child.exit(1));
    return child;
  };

  let previousWindowerHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-daemon-server-"));
    socketPath = join(dir, "daemon.sock");
    windowerHome = dir;
    // The temp dir has to be the *process's* WINDOWER_HOME, not just the value
    // handed to `DaemonServer`: `~/.windower/capture.lock`, the per-target
    // lock, and the session store all resolve it from the env. Without this,
    // every case in this file shares the developer's real `~/.windower` — and
    // since `CaptureLock`'s row-1 hold registry is keyed by lock path and is
    // per-*process*, a case that leaves a recording running leaks its fake
    // capture sidecar into the next case, which then silently reuses it
    // instead of spawning the fake its own `start()` configured.
    previousWindowerHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = dir;
    resetCaptureHoldsForTesting();
    loopScript = INSTANT_SUCCESS;
  });

  afterEach(async () => {
    await server?.stop();
    // Several cases deliberately leave a recording live; drop this process's
    // hold so the next case starts from row 2 (no hold, spawn under the lock).
    resetCaptureHoldsForTesting();
    if (previousWindowerHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = previousWindowerHome;
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
    // Mirrors `main.ts`: ONE `CaptureLock` and ONE `ControlEngine` shared by
    // every consumer, so this harness exercises the same wiring production
    // does rather than a per-consumer arrangement that can't reproduce it.
    captureLock = new CaptureLock({ spawnSidecar });
    controlEngine = new ControlEngine({
      spawnControl: spawnSidecar,
      spawnOptions: { surface: "control" },
      onLog: () => {},
    });
    manager = new RecordingEngine({ store, spawnSidecar, captureLock });
    const passthrough = new PassthroughService(spawnSidecar, {
      capture: captureLock,
      control: controlEngine,
    });
    operatorRunManager = new OperatorRunEngine({
      store: new OperatorRunStore(),
      passthrough,
      spawnSidecar,
      capture: captureLock,
      control: controlEngine,
      // Never reached by most of these tests, but keeps the dispatch path
      // from spawning a real loop child if one ever does.
      spawnLoopChild,
      loopTimings: { exitGraceMs: 20, abortGraceMs: 50, sigkillGraceMs: 20, pingIntervalMs: 0 },
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

  // ---- Phase 21: one capture sidecar, N control processes ----
  // `contracts/screen-capture-exclusivity.md` §"Enforcement, in two tiers":
  // inside the daemon this is ordinary bookkeeping — one `CaptureLock` shared
  // by every capture-surface consumer, so a second capture process is
  // unreachable by construction rather than by which sidecar happens to get
  // reused.

  /** Spawns whose resolved surface is the capture one (`surface` defaults to `"capture"` when omitted). */
  function captureSpawns(): SpawnedFakeSidecar[] {
    return fakeSpawns.filter((spawn) => (spawn.surface ?? "capture") === "capture");
  }

  function controlSpawns(): SpawnedFakeSidecar[] {
    return fakeSpawns.filter((spawn) => spawn.surface === "control");
  }

  it("starts exactly ONE capture sidecar across concurrent list_targets, check_permissions, a recording, and operator-proxied capture calls", async () => {
    loopScript = async (child) => {
      // The loop child's screen-facing calls are proxied through the daemon and
      // must land on the daemon's one capture sidecar (row 1), never spawn one.
      // They are servable only inside an open step.
      await child.request("beginStep", { index: 0 });
      await child.request("captureFrame", { format: "png" });
      await child.request("enumerateTargets", {});
      await child.request("reportStep", {
        step: { index: 0, observationRef: "memory:1:deadbeef", toolCalls: [], tMs: 1 },
      });
      await child.request("reportResult", { state: "succeeded" });
    };
    await start();
    const client = new DaemonClient(createConnection(socketPath));

    // A live recording holds the capture lock for its whole duration; every
    // other capture caller below has to resolve to that same process.
    await client.startRecording({ target: DISPLAY_TARGET });

    await Promise.all([
      client.listTargets({}),
      client.checkPermissions(),
      client.listTargets({ kinds: ["display"] }),
      client.runOperator({ task: "look at the screen", target: DISPLAY_TARGET, model: MODEL }),
    ]);
    // `run_operator` returns as soon as the run is registered; let the loop finish.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(captureSpawns()).toHaveLength(1);
    client.dispose();
  });

  it("serves control-surface calls from the control binary, concurrently with a live capture process", async () => {
    loopScript = async (child) => {
      await child.request("beginStep", { index: 0 });
      await child.request("performInput", { actions: [{ kind: "mouse_move", x: 5, y: 5 }] });
      await child.request("reportStep", {
        step: { index: 0, observationRef: "memory:1:deadbeef", toolCalls: [], tMs: 1 },
      });
      await child.request("reportResult", { state: "succeeded" });
    };
    await start();
    const client = new DaemonClient(createConnection(socketPath));

    await client.startRecording({ target: DISPLAY_TARGET });
    await client.resizeWindow({
      targetId: DISPLAY_TARGET.id,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    });
    await client.runOperator({ task: "click something", target: DISPLAY_TARGET, model: MODEL });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Still one capture process; the control work went to a separate,
    // concurrently-alive control process that took no capture lock — control
    // touches no ScreenCaptureKit state, so it is never serialized against a
    // recording (`contracts/screen-capture-exclusivity.md` §What never takes
    // this lock).
    expect(captureSpawns()).toHaveLength(1);
    expect(controlSpawns()).toHaveLength(1);
    expect(manager.activeSessionCount).toBe(1);
    client.dispose();
  });

  it("merges the capture and control surfaces' partial permission reports", async () => {
    await start(60_000, 1_000, { permissions: { accessibility: "granted" } });
    const client = new DaemonClient(createConnection(socketPath));

    const report = await client.checkPermissions();

    // Absent kinds are unknown, never denied — a daemon holding one surface
    // must not report a partial view as a denial.
    expect(report.accessibility).not.toBe("denied");
    expect(report.screenRecording).not.toBe("denied");
    expect(controlSpawns()).toHaveLength(1);
    expect(captureSpawns()).toHaveLength(1);
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

  // checkIdle (phase-20-daemon-optional.md): an operator run never has a
  // recording session — it records nothing — so counting only
  // `activeSessionCount` would let idle-shutdown fire out from under an
  // in-flight run.
  it("does not idle-shut-down while an operator run is still active, even with zero recording sessions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loopScript = async (child) => {
      await gate;
      await child.request("reportResult", { state: "succeeded" });
    };
    await start(50, 20);
    const client = new DaemonClient(createConnection(socketPath));
    const { runId } = await client.runOperator({
      task: "do a thing",
      target: DISPLAY_TARGET,
      model: MODEL,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    // Idle timeout has long since elapsed, but the run is still in flight —
    // the socket must still be reachable.
    await expect(connect(socketPath)).resolves.toBeUndefined();

    release();
    // The daemon owns every disk write for a run, so teardown has to wait for
    // the terminal persist rather than race the temp dir out from under it.
    await operatorRunManager.whenSettled(runId);
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
    let seenEnv: Record<string, string> | undefined;
    loopScript = async (child, config) => {
      // It reaches the child in `ready`'s result — never on `argv`, which `ps`
      // would expose (contracts/operator-loop-protocol.md §Transport).
      seenEnv = config.env;
      await child.request("reportResult", { state: "succeeded" });
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

    await client.runOperator({ task: "do a thing", target: DISPLAY_TARGET, model: MODEL });
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the loop child handshake
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
