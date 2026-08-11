import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WINDOWER_HOME_ENV } from "./paths.js";
import {
  addSidecarPid,
  clearSidecarPids,
  readSidecarPids,
  removeSidecarPid,
  sidecarPidsFilePath,
} from "./sidecar-pids.js";

describe("addSidecarPid / removeSidecarPid / readSidecarPids / clearSidecarPids", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-sidecar-pids-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("returns [] when the file is absent", async () => {
    expect(await readSidecarPids()).toEqual([]);
  });

  it("resolves the path under WINDOWER_HOME", () => {
    expect(sidecarPidsFilePath()).toBe(join(home, "sidecar-pids.json"));
  });

  it("adds a pid and reads it back", async () => {
    await addSidecarPid(1234);
    expect(await readSidecarPids()).toEqual([1234]);
  });

  it("adding the same pid twice is idempotent", async () => {
    await addSidecarPid(1234);
    await addSidecarPid(1234);
    expect(await readSidecarPids()).toEqual([1234]);
  });

  it("tracks multiple pids", async () => {
    await addSidecarPid(1);
    await addSidecarPid(2);
    expect((await readSidecarPids()).sort()).toEqual([1, 2]);
  });

  it("removes a pid", async () => {
    await addSidecarPid(1);
    await addSidecarPid(2);
    await removeSidecarPid(1);
    expect(await readSidecarPids()).toEqual([2]);
  });

  it("removing an untracked pid is a no-op", async () => {
    await addSidecarPid(1);
    await removeSidecarPid(999);
    expect(await readSidecarPids()).toEqual([1]);
  });

  it("clearSidecarPids unlinks the file", async () => {
    await addSidecarPid(1);
    await clearSidecarPids();
    expect(await readSidecarPids()).toEqual([]);
    await expect(readFile(sidecarPidsFilePath(), "utf8")).rejects.toThrow();
  });

  it("clearSidecarPids is a no-op (does not throw) when the file is already absent", async () => {
    await expect(clearSidecarPids()).resolves.toBeUndefined();
  });

  it("returns [] (does not throw) on malformed JSON", async () => {
    await addSidecarPid(1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sidecarPidsFilePath(), "{ not valid json", "utf8");
    expect(await readSidecarPids()).toEqual([]);
  });

  it("handles concurrent adds without losing an update", async () => {
    await Promise.all([addSidecarPid(1), addSidecarPid(2), addSidecarPid(3)]);
    expect((await readSidecarPids()).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("handles concurrent add+remove without losing an update", async () => {
    await addSidecarPid(1);
    await Promise.all([addSidecarPid(2), removeSidecarPid(1), addSidecarPid(3)]);
    expect((await readSidecarPids()).sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
