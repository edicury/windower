import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
  DEFAULT_FILENAME_TEMPLATE,
  readConfig,
  writeConfig,
} from "./config-file.js";
import { defaultOutputDir } from "./paths.js";
import { WINDOWER_HOME_ENV } from "./paths.js";

describe("readConfig / writeConfig", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-config-file-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("synthesizes defaults when config.json does not exist", async () => {
    const config = await readConfig();
    expect(config).toEqual({
      outputDir: defaultOutputDir(),
      filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
      daemonIdleTimeoutMs: DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
      defaultVideo: undefined,
      defaultAudio: undefined,
    });
  });

  it("round-trips a written config, applying defaults only for omitted fields", async () => {
    await writeConfig({
      outputDir: "/tmp/recordings",
      defaultVideo: { fps: 60 },
    });

    const config = await readConfig();
    expect(config.outputDir).toBe("/tmp/recordings");
    expect(config.defaultVideo).toEqual({ fps: 60 });
    expect(config.filenameTemplate).toBe(DEFAULT_FILENAME_TEMPLATE);
    expect(config.daemonIdleTimeoutMs).toBe(DEFAULT_DAEMON_IDLE_TIMEOUT_MS);
  });

  it("rejects an invalid config shape", async () => {
    await expect(writeConfig({ daemonIdleTimeoutMs: -1 })).rejects.toThrow();
  });
});
