import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SidecarClient,
  SidecarError,
  type SpawnSidecarOptions,
  WINDOWER_HOME_ENV,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlEngine } from "./control-engine.js";
import type { SidecarFactory, SidecarHandle } from "./recording-engine.js";
import {
  CaptureLock,
  captureLockPath,
  resetCaptureHoldsForTesting,
} from "./screen-capture-lock.js";

interface StubControlProcess {
  options: SpawnSidecarOptions;
  handle: SidecarHandle;
  performInputCalls: unknown[];
  terminated: boolean;
  /** Simulates the process dying (`kill -9`) — the factory's `onExit` is what a real `SidecarProcess` fires. */
  die(): void;
  /** When true, `performInput` hangs until `die()` — the genuine mid-call death. */
  hangPerformInput: boolean;
}

/**
 * Stub control-surface factory. Deliberately not the shared fake-sidecar
 * helper: these tests care about process lifetime and death, not protocol
 * behavior, and need to inject transport failures precisely.
 */
function createStubControlFactory(options?: {
  capabilities?: string[];
  failDescribe?: boolean;
}): { spawnControl: SidecarFactory; spawned: StubControlProcess[] } {
  const spawned: StubControlProcess[] = [];
  const spawnControl: SidecarFactory = (spawnOptions) => {
    let dead = false;
    const inFlight: ((err: unknown) => void)[] = [];
    const record: StubControlProcess = {
      options: spawnOptions,
      handle: undefined as unknown as SidecarHandle,
      performInputCalls: [],
      terminated: false,
      hangPerformInput: false,
      die: () => {
        dead = true;
        spawnOptions.onExit?.({ code: null, signal: "SIGKILL" });
        // A real `SidecarProcess` rejects every in-flight request when the
        // transport closes — mirror that here.
        for (const reject of inFlight.splice(0)) {
          reject(new SidecarError("INTERNAL_ERROR", "Sidecar stream closed", -32000));
        }
      },
    };
    const client = {
      describe: async () => {
        if (options?.failDescribe) throw new SidecarError("INTERNAL_ERROR", "no binary", -32000);
        return {
          version: "1.0.0",
          platform: "macos" as const,
          capabilities: options?.capabilities ?? ["input.mouse", "input.keyboard", "resize"],
        };
      },
      performInput: async (params: unknown) => {
        if (dead) throw new SidecarError("INTERNAL_ERROR", "Sidecar stream closed", -32000);
        record.performInputCalls.push(params);
        if (record.hangPerformInput) {
          return new Promise((_resolve, reject) => inFlight.push(reject));
        }
        return { performed: 1 };
      },
      resizeWindow: async () => {
        if (dead) throw new SidecarError("INTERNAL_ERROR", "Sidecar stream closed", -32000);
        return { bounds: { x: 0, y: 0, width: 10, height: 10 } };
      },
    } as unknown as SidecarClient;
    record.handle = {
      client,
      pid: 4242,
      terminate: async () => {
        record.terminated = true;
      },
    };
    spawned.push(record);
    return record.handle;
  };
  return { spawnControl, spawned };
}

describe("ControlEngine", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-control-engine-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    resetCaptureHoldsForTesting();
  });

  afterEach(async () => {
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("spawns one control process on demand and reuses it across calls", async () => {
    const { spawnControl, spawned } = createStubControlFactory();
    const control = new ControlEngine({ spawnControl });

    await control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] });
    await control.resizeWindow({
      targetId: "window-1",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    });

    expect(spawned).toHaveLength(1);
    expect(control.isRunning).toBe(true);
    expect(control.pid).toBe(4242);
  });

  it("does not spawn a second process when two calls race the initial spawn", async () => {
    const { spawnControl, spawned } = createStubControlFactory();
    const control = new ControlEngine({ spawnControl });

    await Promise.all([
      control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] }),
      control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] }),
      control.capabilities(),
    ]);

    expect(spawned).toHaveLength(1);
  });

  it("surfaces a clear error when the process dies mid-call and never silently replays the input", async () => {
    const { spawnControl, spawned } = createStubControlFactory();
    const control = new ControlEngine({ spawnControl, onLog: () => {} });
    await control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] });

    const process0 = spawned[0];
    if (!process0) throw new Error("expected a spawned control process");
    process0.hangPerformInput = true;
    const pending = control
      .performInput({ actions: [{ kind: "mouse_click", x: 1, y: 1, button: "left" }] })
      .catch((e) => e);
    await new Promise((resolve) => setTimeout(resolve, 1));
    process0.die(); // kill -9 mid-call

    const err = await pending;
    // The call that was in flight against the dead process fails clearly...
    expect((err as { code?: string }).code).toBe("INTERNAL_ERROR");
    expect((err as Error).message).toMatch(/control surface process/i);
    // ...and the half-delivered click is NOT replayed against a fresh
    // process: `performInput` is not idempotent, so a clear error beats a
    // silent double-click.
    expect(spawned).toHaveLength(1);
    expect(process0.performInputCalls).toHaveLength(2);
  });

  it("restarts on demand after the process died", async () => {
    const { spawnControl, spawned } = createStubControlFactory();
    const control = new ControlEngine({ spawnControl, onLog: () => {} });
    await control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] });

    spawned[0]?.die();
    expect(control.isRunning).toBe(false);

    await control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.performInputCalls).toHaveLength(1);
    expect(control.isRunning).toBe(true);
  });

  it("gates on describe().capabilities, never on a platform string", async () => {
    const { spawnControl } = createStubControlFactory({ capabilities: ["input.mouse"] });
    const control = new ControlEngine({ spawnControl });

    await expect(control.requireCapability("input.mouse")).resolves.toBeUndefined();
    await expect(control.requireCapability("input.keyboard")).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
  });

  it("reports a spawn that never comes up as INTERNAL_ERROR instead of hanging", async () => {
    const { spawnControl } = createStubControlFactory({ failDescribe: true });
    const control = new ControlEngine({ spawnControl, onLog: () => {} });
    await expect(control.describe()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("NEVER touches the screen capture lock — no lock file, no hold, no capture spawn", async () => {
    const { spawnControl } = createStubControlFactory();
    const captureSpawns: unknown[] = [];
    const captureLock = new CaptureLock({
      spawnSidecar: () => {
        captureSpawns.push(1);
        throw new Error("ControlEngine must never spawn a capture process");
      },
    });
    const control = new ControlEngine({ spawnControl });

    await control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] });
    await control.resizeWindow({
      targetId: "window-1",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    });
    await control.capabilities();
    await control.shutdown();

    await expect(stat(captureLockPath())).rejects.toThrow();
    expect(await captureLock.readHolder()).toBeUndefined();
    expect(captureLock.hold).toBeUndefined();
    expect(captureSpawns).toHaveLength(0);
  });

  it("a control process dying leaves an in-progress capture hold completely untouched", async () => {
    const { spawnControl, spawned } = createStubControlFactory();
    const capture = {
      terminated: false,
    };
    const captureLock = new CaptureLock({
      spawnSidecar: () => ({
        client: { describe: async () => ({}) } as unknown as SidecarClient,
        terminate: async () => {
          capture.terminated = true;
        },
      }),
    });
    const hold = await captureLock.acquireCaptureHold();

    const control = new ControlEngine({ spawnControl, onLog: () => {} });
    await control.performInput({ actions: [{ kind: "wait", durationMs: 1 }] });
    spawned[0]?.die();

    // The recording's hold is still held, its capture child still alive.
    expect(captureLock.hold).toBe(hold);
    expect(capture.terminated).toBe(false);
    expect(await captureLock.readHolder()).toMatchObject({ pid: process.pid });

    await hold.release();
  });
});
