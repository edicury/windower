import { type ChildProcess, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PermissionReport,
  PermissionReportSchema,
  SIDECAR_BINARY_PATH_ENV,
  WINDOWER_HOME_ENV,
  connectToDaemon,
  findRepoRoot,
  packageVersion,
  writeConfig,
  writeDaemonState,
} from "@windower/core";
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
  let savedApiKeyVars: Record<string, string | undefined>;
  const spawned: ChildProcess[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-doctor-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;

    originalSidecarPath = process.env[SIDECAR_BINARY_PATH_ENV];
    // Point at a definitely-missing binary by default so tests that don't
    // care about the sidecar don't depend on this checkout's dev build.
    process.env[SIDECAR_BINARY_PATH_ENV] = join(home, "no-such-sidecar-binary");

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
