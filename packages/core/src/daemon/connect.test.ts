import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectToDaemon, ensureDaemonRunning, spawnDaemonDetached } from "./connect.js";
import { DaemonError } from "./errors.js";
import { WINDOWER_HOME_ENV, daemonSocketPath } from "./paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "fake-daemon-cli.mjs");

describe("connectToDaemon / ensureDaemonRunning", () => {
  let home: string;
  let originalHome: string | undefined;
  let spawned: ChildProcess | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-daemon-connect-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    spawned?.kill("SIGKILL");
    spawned = undefined;
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("rejects with DAEMON_UNREACHABLE when nothing is listening", async () => {
    await expect(connectToDaemon(daemonSocketPath())).rejects.toThrow(DaemonError);
    await expect(connectToDaemon(daemonSocketPath())).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
    });
  });

  it("connects once a daemon (spawned via spawnDaemonDetached) is listening", async () => {
    spawned = spawnDaemonDetached(FIXTURE_PATH);
    await waitForSocket();

    const client = await connectToDaemon(daemonSocketPath());
    expect(client).toBeDefined();
    client.dispose();
  });

  it("ensureDaemonRunning takes the fast path when a daemon is already reachable (no spawn)", async () => {
    spawned = spawnDaemonDetached(FIXTURE_PATH);
    await waitForSocket();

    const client = await ensureDaemonRunning({
      socketPath: daemonSocketPath(),
      entryPath: FIXTURE_PATH,
      spawnTimeoutMs: 3000,
    });
    expect(client).toBeDefined();
    client.dispose();
  }, 10_000);

  async function waitForSocket(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const client = await connectToDaemon(daemonSocketPath());
        client.dispose();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("fake daemon never started listening");
  }
});
