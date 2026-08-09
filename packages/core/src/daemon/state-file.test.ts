import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WINDOWER_HOME_ENV } from "./paths.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";
import {
  type DaemonStateFile,
  clearDaemonState,
  daemonStateFilePath,
  readDaemonState,
  writeDaemonState,
} from "./state-file.js";

describe("writeDaemonState / readDaemonState / clearDaemonState", () => {
  let home: string;
  let originalHome: string | undefined;

  const sample: DaemonStateFile = {
    pid: 4821,
    version: "0.3.0",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    startedAt: "2026-08-09T14:02:11.000Z",
    socketPath: "/Users/x/.windower/daemon.sock",
    windowerHome: "/Users/x/.windower",
    execPath: "/usr/local/bin/node",
    entryPath: "/usr/local/lib/node_modules/windower/apps/daemon/dist/main.js",
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-daemon-state-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("returns null when the file is absent", async () => {
    expect(await readDaemonState()).toBeNull();
  });

  it("writes then reads back the identical state", async () => {
    await writeDaemonState(sample);
    const read = await readDaemonState();
    expect(read).toEqual(sample);
  });

  it("resolves the path under WINDOWER_HOME", async () => {
    expect(daemonStateFilePath()).toBe(join(home, "daemon.json"));
  });

  it("creates the parent directory if it doesn't exist yet", async () => {
    await rm(home, { recursive: true, force: true });
    await writeDaemonState(sample);
    expect(await readDaemonState()).toEqual(sample);
  });

  it("clearDaemonState unlinks the file", async () => {
    await writeDaemonState(sample);
    await clearDaemonState();
    expect(await readDaemonState()).toBeNull();
  });

  it("clearDaemonState is a no-op (does not throw) when the file is already absent", async () => {
    await expect(clearDaemonState()).resolves.toBeUndefined();
  });

  it("returns null (does not throw) on malformed JSON", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(daemonStateFilePath(), "{ not valid json", "utf8");
    expect(await readDaemonState()).toBeNull();
  });

  it("returns null (does not throw) when the JSON doesn't match the schema", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(daemonStateFilePath(), JSON.stringify({ pid: "not-a-number" }), "utf8");
    expect(await readDaemonState()).toBeNull();
  });
});
