import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_BINARY_PATH_ENV,
  type PermissionReport,
  PermissionReportSchema,
  SIDECAR_BINARY_PATH_ENV,
  type SpawnSidecarOptions,
  WINDOWER_HOME_ENV,
  connectToDaemon,
  createFakeSidecarPair,
  findRepoRoot,
  packageVersion,
  writeConfig,
  writeDaemonState,
} from "@windower/core";
import {
  type SidecarFactory,
  captureLockPath,
  resetCaptureHoldsForTesting,
} from "@windower/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDoctorReport, renderReport } from "./doctor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const SIDECAR_FIXTURE_SRC = join(
  repoRoot,
  "packages/core/src/process/fixtures/fake-sidecar-cli.mjs",
);
const DAEMON_FIXTURE = join(repoRoot, "packages/core/src/daemon/fixtures/fake-daemon-cli.mjs");

const API_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"];

const REPORT: PermissionReport = {
  screenRecording: "granted",
  accessibility: "denied",
  microphone: "not_determined",
  daemonRunning: true,
  sidecarAvailable: true,
  sidecarVersion: "0.1.0",
};

describe("renderReport", () => {
  it("marks granted/true items as checked and others as unchecked", () => {
    const output = renderReport(REPORT);
    const lines = output.split("\n");
    expect(lines[1]).toContain("[x]");
    expect(lines[1]).toContain("Screen Recording: granted");
    expect(lines[2]).toContain("[ ]");
    expect(lines[2]).toContain("Accessibility: denied");
    expect(output).toContain("[x] Daemon running");
    expect(output).toContain("[x] Sidecar available (v0.1.0)");
  });

  it("suggests `windower permission request <kind>` for each ungranted permission", () => {
    const output = renderReport(REPORT);
    expect(output).toContain("windower permission request accessibility");
    expect(output).toContain("windower permission request microphone");
    expect(output).not.toContain("windower permission request screenRecording");
  });

  it("omits the version suffix when sidecarVersion is absent", () => {
    const output = renderReport({ ...REPORT, sidecarVersion: undefined });
    expect(output).toContain("Sidecar available");
    expect(output).not.toContain("(v");
    expect(output).not.toContain("version mismatch");
  });

  it("flags a sidecar version mismatch clearly", () => {
    const output = renderReport({ ...REPORT, sidecarVersion: "0.9.9" });
    expect(output).toContain("version mismatch");
    expect(output).toContain("0.9.9");
  });

  it("renders the daemon-not-running case without a stack of undefined fields", () => {
    const output = renderReport({ ...REPORT, daemonRunning: false, daemon: { running: false } });
    expect(output).toContain("[ ] Daemon running");
  });

  it("renders the api-key presence table without printing values", () => {
    const output = renderReport({
      ...REPORT,
      apiKeyEnvVars: [{ name: "ANTHROPIC_API_KEY", presentInClient: true, presentInDaemon: false }],
    });
    expect(output).toContain("ANTHROPIC_API_KEY: present in CLI: yes / present in daemon: no");
  });
});

describe("buildDoctorReport", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalSidecarPath: string | undefined;
  let originalControlPath: string | undefined;
  let savedApiKeyVars: Record<string, string | undefined>;
  const spawned: ChildProcess[] = [];

  beforeEach(async () => {
    resetCaptureHoldsForTesting();
    home = await mkdtemp(join(tmpdir(), "windower-doctor-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;

    originalSidecarPath = process.env[SIDECAR_BINARY_PATH_ENV];
    // Point at a definitely-missing binary by default so tests that don't
    // care about the sidecar don't depend on this checkout's dev build.
    process.env[SIDECAR_BINARY_PATH_ENV] = join(home, "no-such-sidecar-binary");

    // Same for the control surface — without this, resolution falls through to
    // this checkout's `native/macos/.build/debug/windower-control-macos` dev
    // build and `doctor` would probe the developer's REAL Accessibility grant.
    originalControlPath = process.env[CONTROL_BINARY_PATH_ENV];
    process.env[CONTROL_BINARY_PATH_ENV] = join(home, "no-such-control-binary");

    savedApiKeyVars = {};
    for (const name of API_KEY_VARS) {
      savedApiKeyVars[name] = process.env[name];
      delete process.env[name];
    }

    // Always give the report a real, tmp-scoped outputDir — readConfig()'s
    // default falls back to a real `~/Movies/Windower` under the actual
    // user's home, which tests must never touch.
    await writeConfig({ outputDir: join(home, "output") });
  });

  afterEach(async () => {
    for (const child of spawned) child.kill("SIGKILL");
    spawned.length = 0;

    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;

    if (originalSidecarPath === undefined) delete process.env[SIDECAR_BINARY_PATH_ENV];
    else process.env[SIDECAR_BINARY_PATH_ENV] = originalSidecarPath;

    if (originalControlPath === undefined) delete process.env[CONTROL_BINARY_PATH_ENV];
    else process.env[CONTROL_BINARY_PATH_ENV] = originalControlPath;

    resetCaptureHoldsForTesting();

    for (const name of API_KEY_VARS) {
      if (savedApiKeyVars[name] === undefined) delete process.env[name];
      else process.env[name] = savedApiKeyVars[name];
    }

    await rm(home, { recursive: true, force: true });
  });

  async function installFakeSidecar(env: Record<string, string> = {}): Promise<string> {
    const dest = join(home, "fake-sidecar.mjs");
    await copyFile(SIDECAR_FIXTURE_SRC, dest);
    await chmod(dest, 0o755);
    process.env[SIDECAR_BINARY_PATH_ENV] = dest;
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }
    return dest;
  }

  async function writeFakeSession(id: string, state: string): Promise<void> {
    const dir = join(home, "sessions");
    await mkdir(dir, { recursive: true });
    const session = {
      id,
      state,
      target: {
        kind: "display",
        id: "display:0",
        name: "Fake Display",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        isPrimary: true,
        scaleFactor: 1,
      },
      video: { fps: 30, codec: "h264", container: "mp4", quality: "high", showCursor: true },
      audio: { tracks: [], separateTracks: false },
      startedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  async function writeFakeRun(id: string, state: string): Promise<void> {
    const dir = join(home, "operator-runs");
    await mkdir(dir, { recursive: true });
    const run = {
      id,
      state,
      task: "fake task",
      target: {
        kind: "display",
        id: "d1",
        name: "Built-in",
        isPrimary: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 2,
      },
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      steps: [],
      startedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, `${id}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  }

  it("produces a report that validates against PermissionReportSchema", async () => {
    const report = await buildDoctorReport();
    expect(() => PermissionReportSchema.parse(report)).not.toThrow();
  });

  it("reports no daemon running when daemon.json is absent", async () => {
    const report = await buildDoctorReport();
    expect(report.daemonRunning).toBe(false);
    expect(report.daemon).toEqual({ running: false });
  });

  it("does not report a stale daemon.json (dead pid) as running", async () => {
    await writeDaemonState({
      pid: 999_999,
      version: "0.1.0",
      protocolVersion: 1,
      startedAt: new Date().toISOString(),
      socketPath: join(home, "daemon.sock"),
      windowerHome: home,
      execPath: process.execPath,
      entryPath: "fake",
    });

    const report = await buildDoctorReport();
    expect(report.daemonRunning).toBe(false);
    expect(report.daemon?.running).toBe(false);
  });

  it("falls back to state-file data when the pid is alive but the socket doesn't answer", async () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    await writeDaemonState({
      pid: process.pid, // this test process itself — always alive
      version: "9.9.9-stale-fallback",
      protocolVersion: 1,
      startedAt,
      socketPath: join(home, "daemon.sock"), // nothing is actually listening here
      windowerHome: home,
      execPath: process.execPath,
      entryPath: "fake",
    });

    const report = await buildDoctorReport();
    expect(report.daemonRunning).toBe(true);
    expect(report.daemon?.running).toBe(true);
    expect(report.daemon?.pid).toBe(process.pid);
    expect(report.daemon?.version).toBe("9.9.9-stale-fallback");
    expect(report.daemon?.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("probes a live daemon via daemon_info without spawning one", async () => {
    const child = spawn(process.execPath, [DAEMON_FIXTURE], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WINDOWER_HOME: home, FAKE_DAEMON_PROTOCOL_VERSION: "1" },
    });
    child.unref();
    spawned.push(child);

    // Wait for the fixture's real socket to come up.
    const socketPath = join(home, "daemon.sock");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const c = await connectToDaemon(socketPath);
        c.dispose();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const report = await buildDoctorReport();
    expect(report.daemonRunning).toBe(true);
    expect(report.daemon?.running).toBe(true);
    expect(report.daemon?.version).toBe("0.0.0-fake");
    expect(report.daemon?.protocolVersion).toBe(1);
    // The live CLI's own package version is never "0.0.0-fake".
    expect(report.daemon?.versionMatchesClient).toBe(false);
    expect(report.client?.version).toBe(packageVersion(import.meta.url, "0.0.0"));
  });

  it("reports sidecar unavailable when the binary can't be spawned", async () => {
    const report = await buildDoctorReport();
    expect(report.sidecarAvailable).toBe(false);
    expect(report.sidecar?.available).toBe(false);
  });

  it("reports sidecar availability/version/source from a real spawned fixture", async () => {
    await installFakeSidecar({ FAKE_SIDECAR_VERSION: "1.2.3-fixture" });

    const report = await buildDoctorReport();
    expect(report.sidecarAvailable).toBe(true);
    expect(report.sidecarVersion).toBe("1.2.3-fixture");
    expect(report.sidecar?.source).toBe("env-override");
    expect(report.sidecar?.resolvedPath).toContain("fake-sidecar.mjs");
    expect(report.sidecar?.expectedVersion).toBeDefined();
  });

  it("reports windowerHome with fromEnvOverride true when WINDOWER_HOME is set", async () => {
    const report = await buildDoctorReport();
    expect(report.windowerHome?.path).toBe(home);
    expect(report.windowerHome?.fromEnvOverride).toBe(true);
  });

  it("reports outputDir as writable when it can be created", async () => {
    const report = await buildDoctorReport();
    expect(report.outputDir?.path).toBe(join(home, "output"));
    expect(report.outputDir?.writable).toBe(true);
  });

  it("reports outputDir as not writable when it can't be created", async () => {
    // Create a plain file where the parent of outputDir needs to be a
    // directory — mkdir -p then fails with ENOTDIR.
    const blocked = join(home, "blocked-file");
    await writeFile(blocked, "not a directory");
    await writeConfig({ outputDir: join(blocked, "output") });

    const report = await buildDoctorReport();
    expect(report.outputDir?.writable).toBe(false);
  });

  it("counts active sessions and operator runs from disk, ignoring terminal ones", async () => {
    await writeFakeSession("sess-active", "recording");
    await writeFakeSession("sess-done", "finalized");
    await writeFakeRun("run-active", "running");
    await writeFakeRun("run-done", "succeeded");

    const report = await buildDoctorReport();
    expect(report.activeSessions).toBe(1);
    expect(report.activeRuns).toBe(1);
  });

  it("reports API key env var presence in the client without ever exposing values", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-super-secret-value";

    const report = await buildDoctorReport();
    const entry = report.apiKeyEnvVars?.find((e) => e.name === "ANTHROPIC_API_KEY");
    expect(entry?.presentInClient).toBe(true);
    // presentInDaemon is a documented gap — never fabricated as true.
    expect(entry?.presentInDaemon).toBe(false);

    expect(JSON.stringify(report)).not.toContain("sk-super-secret-value");
  });

  it("includes the configured operator.apiKeyEnvVar, deduplicated against the defaults", async () => {
    await writeConfig({
      outputDir: join(home, "output"),
      operator: { apiKeyEnvVar: "OPENAI_API_KEY" },
    });

    const report = await buildDoctorReport();
    const names = report.apiKeyEnvVars?.map((e) => e.name) ?? [];
    expect(names.filter((n) => n === "OPENAI_API_KEY")).toHaveLength(1);

    await writeConfig({
      outputDir: join(home, "output"),
      operator: { apiKeyEnvVar: "CUSTOM_KEY" },
    });
    const report2 = await buildDoctorReport();
    expect(report2.apiKeyEnvVars?.map((e) => e.name)).toContain("CUSTOM_KEY");
  });
});

/**
 * Phase 21 (`contracts/screen-capture-exclusivity.md`): `doctor` is
 * daemon-free, so its capture-surface probe is exactly the "daemon-free
 * capture call" the phase's exit criterion talks about — it must take
 * `~/.windower/capture.lock`, must never become a second ScreenCaptureKit
 * process, and must never be routed to the holder. Its control-surface probe
 * must take no lock at all (§What never takes this lock).
 *
 * The factory below follows `packages/engine/src/test-helpers/fake-sidecar-factory.ts`:
 * it records the `surface` each spawn asked for (plus whether a lock file
 * existed at that moment), which is what proves both halves.
 */
interface RecordedSpawn {
  surface?: SpawnSidecarOptions["surface"];
  binaryPath?: string;
  lockExistedAtSpawn: boolean;
}

function createSurfaceRecordingFactory(options: {
  capturePermissions?: Partial<PermissionReport>;
  controlPermissions?: Partial<PermissionReport>;
  failControlSpawn?: boolean;
}): { spawnSidecar: SidecarFactory; spawns: RecordedSpawn[] } {
  const spawns: RecordedSpawn[] = [];
  const spawnSidecar: SidecarFactory = (spawnOptions) => {
    const record: RecordedSpawn = {
      surface: spawnOptions.surface,
      binaryPath: spawnOptions.binaryPath,
      lockExistedAtSpawn: existsSync(captureLockPath()),
    };
    spawns.push(record);
    if (spawnOptions.surface === "control" && options.failControlSpawn) {
      throw new Error("control binary is not runnable");
    }
    const { client, dispose } = createFakeSidecarPair({
      permissions:
        spawnOptions.surface === "control"
          ? options.controlPermissions
          : options.capturePermissions,
    });
    return { client, terminate: async () => dispose() };
  };
  return { spawnSidecar, spawns };
}

describe("buildDoctorReport — capture lock and surface routing", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalSidecarPath: string | undefined;
  let originalControlPath: string | undefined;

  const captureBinary = () => join(home, "fake-capture-binary");
  const controlBinary = () => join(home, "fake-control-binary");

  beforeEach(async () => {
    resetCaptureHoldsForTesting();
    home = await mkdtemp(join(tmpdir(), "windower-doctor-lock-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;

    originalSidecarPath = process.env[SIDECAR_BINARY_PATH_ENV];
    originalControlPath = process.env[CONTROL_BINARY_PATH_ENV];
    // Env-override resolution doesn't stat the path, so these only need to be
    // distinguishable — the injected factory is what actually "spawns".
    process.env[SIDECAR_BINARY_PATH_ENV] = captureBinary();
    process.env[CONTROL_BINARY_PATH_ENV] = controlBinary();

    await writeConfig({ outputDir: join(home, "output") });
  });

  afterEach(async () => {
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    if (originalSidecarPath === undefined) delete process.env[SIDECAR_BINARY_PATH_ENV];
    else process.env[SIDECAR_BINARY_PATH_ENV] = originalSidecarPath;
    if (originalControlPath === undefined) delete process.env[CONTROL_BINARY_PATH_ENV];
    else process.env[CONTROL_BINARY_PATH_ENV] = originalControlPath;
    await rm(home, { recursive: true, force: true });
  });

  async function writeCaptureLock(payload: {
    pid: number;
    acquiredAt: string;
    windowerHome: string;
  }): Promise<void> {
    await mkdir(home, { recursive: true });
    await writeFile(captureLockPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  const captureSpawns = (spawns: RecordedSpawn[]) => spawns.filter((s) => s.surface !== "control");

  it("holds the capture lock while probing, then releases it", async () => {
    const { spawnSidecar, spawns } = createSurfaceRecordingFactory({});

    const report = await buildDoctorReport({ spawnSidecar });

    const capture = captureSpawns(spawns);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.surface).toBe("capture");
    expect(capture[0]?.binaryPath).toBe(captureBinary());
    // The lock file existed at the moment the capture process was spawned —
    // i.e. it was acquired first, not after the fact.
    expect(capture[0]?.lockExistedAtSpawn).toBe(true);
    expect(report.captureLock?.busy).toBe(false);
    // …and it is not left behind for the next caller.
    expect(existsSync(captureLockPath())).toBe(false);
  });

  it("never spawns a second capture process while a live holder owns the lock", async () => {
    const acquiredAt = new Date(Date.now() - 1000).toISOString();
    await writeCaptureLock({ pid: process.pid, acquiredAt, windowerHome: home });
    const { spawnSidecar, spawns } = createSurfaceRecordingFactory({});

    const report = await buildDoctorReport({ spawnSidecar, captureWaitMs: 20 });

    expect(captureSpawns(spawns)).toHaveLength(0);
    expect(report.captureLock).toMatchObject({
      held: true,
      busy: true,
      pid: process.pid,
      acquiredAt,
    });
    // `captureLock` is on `PermissionReportSchema` itself, not a CLI-local
    // sibling type — so it SURVIVES a round trip through the schema. Zod
    // strips unknown keys, so a merely-tolerated field would be silently
    // dropped from `doctor --json` while `.parse()` still "passed".
    const parsed = PermissionReportSchema.parse(report);
    expect(parsed.captureLock).toEqual(report.captureLock);
    expect(parsed.captureLock?.busy).toBe(true);

    // Never stolen from a live holder.
    const holder = JSON.parse(await readFile(captureLockPath(), "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(holder.acquiredAt).toBe(acquiredAt);
  });

  it("reports a busy lock as a diagnostic and keeps the rest of the report intact", async () => {
    const acquiredAt = new Date(Date.now() - 1000).toISOString();
    await writeCaptureLock({ pid: process.pid, acquiredAt, windowerHome: home });
    const { spawnSidecar } = createSurfaceRecordingFactory({});

    const report = await buildDoctorReport({ spawnSidecar, captureWaitMs: 20 });

    // Unknown, never denied.
    expect(report.screenRecording).toBe("not_determined");
    expect(report.microphone).toBe("not_determined");
    // Everything that doesn't need the capture surface still reported.
    expect(report.windowerHome?.path).toBe(home);
    expect(report.outputDir?.path).toBe(join(home, "output"));
    expect(report.daemonRunning).toBe(false);
    expect(report.apiKeyEnvVars?.length).toBeGreaterThan(0);
    expect(report.client?.name).toBe("windower-cli");

    const rendered = renderReport(report);
    expect(rendered).toContain("Screen capture busy");
    expect(rendered).toContain(`pid ${process.pid}`);
    expect(rendered).toContain(acquiredAt);
    // Still a report, not a stack trace.
    expect(rendered).toContain("Daemon running");
    expect(rendered).toContain("WINDOWER_HOME");
  });

  it("fails immediately (and names both homes) for a live holder from a different WINDOWER_HOME", async () => {
    const foreignHome = join(home, "other-install");
    const acquiredAt = new Date().toISOString();
    await writeCaptureLock({ pid: process.pid, acquiredAt, windowerHome: foreignHome });
    const { spawnSidecar, spawns } = createSurfaceRecordingFactory({});

    const startedAt = Date.now();
    const report = await buildDoctorReport({ spawnSidecar, captureWaitMs: 5000 });

    // Row 4: never wait, never steal, never spawn.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(captureSpawns(spawns)).toHaveLength(0);
    expect(report.captureLock?.busy).toBe(true);
    expect(report.captureLock?.windowerHome).toBe(foreignHome);
    expect(report.captureLock?.message).toContain(foreignHome);
    expect(renderReport(report)).toContain(foreignHome);
  });

  it('spawns the control surface with surface: "control" and takes no capture lock for it', async () => {
    const acquiredAt = new Date().toISOString();
    // A foreign holder means the capture probe never spawns or locks, so the
    // only spawn left is the control one — anything it did to the lock file
    // would be visible.
    await writeCaptureLock({
      pid: process.pid,
      acquiredAt,
      windowerHome: join(home, "other-install"),
    });
    const { spawnSidecar, spawns } = createSurfaceRecordingFactory({
      controlPermissions: { accessibility: "granted" },
    });

    const report = await buildDoctorReport({ spawnSidecar, captureWaitMs: 20 });

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.surface).toBe("control");
    expect(spawns[0]?.binaryPath).toBe(controlBinary());
    // The control spawn neither created nor touched the capture lock.
    const holder = JSON.parse(await readFile(captureLockPath(), "utf8"));
    expect(holder.acquiredAt).toBe(acquiredAt);
    // …and it still answered, so Accessibility is real, not a capture-only guess.
    expect(report.accessibility).toBe("granted");
  });

  it("merges the capture and control permission reports", async () => {
    const { spawnSidecar } = createSurfaceRecordingFactory({
      capturePermissions: { screenRecording: "granted", microphone: "denied" },
      controlPermissions: { accessibility: "granted" },
    });

    const report = await buildDoctorReport({ spawnSidecar });

    expect(report.screenRecording).toBe("granted");
    expect(report.microphone).toBe("denied");
    expect(report.accessibility).toBe("granted");
    expect(report.sidecarAvailable).toBe(true);
    expect(() => PermissionReportSchema.parse(report)).not.toThrow();
  });

  it("renders a kind absent from both surfaces as unknown, never denied", async () => {
    const { spawnSidecar, spawns } = createSurfaceRecordingFactory({
      capturePermissions: { screenRecording: "granted" },
      failControlSpawn: true,
    });

    const report = await buildDoctorReport({ spawnSidecar });

    expect(spawns.some((s) => s.surface === "control")).toBe(true);
    expect(report.screenRecording).toBe("granted");
    expect(report.accessibility).toBe("not_determined");
    expect(report.microphone).toBe("not_determined");
    expect(renderReport(report)).not.toContain("denied");
  });
});
