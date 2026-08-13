import { describe, expect, it, vi } from "vitest";

import { flattenGraph, STAGES } from "../graph.mjs";
import { bumpPatch } from "../lib.mjs";
import { bumpAll } from "../bump.mjs";
import { runRelease } from "../publish.mjs";

const EXPECTED_ORDER = [
  "@windower/core",
  "@windower/engine",
  "@windower/engine-narration",
  "@windower/daemon",
  "@windower/cli",
  "@windower/mcp-server",
  "@windower/sidecar-macos-arm64",
  "@windower/sidecar-macos-x64",
];

function fakeReadPkg(versions) {
  return (dir) => {
    const entry = flattenGraph().find((e) => e.dir === dir);
    return { path: `${dir}/package.json`, json: { name: entry.pkgName, version: versions[entry.name] } };
  };
}

describe("graph.mjs", () => {
  it("flattens STAGES into the exact required publish order", () => {
    expect(flattenGraph(STAGES).map((e) => e.pkgName)).toEqual(EXPECTED_ORDER);
  });
});

describe("bumpPatch", () => {
  it("increments the patch segment only", () => {
    expect(bumpPatch("0.1.4")).toBe("0.1.5");
    expect(bumpPatch("1.2.9")).toBe("1.2.10");
  });

  it("rejects non-semver input", () => {
    expect(() => bumpPatch("not-a-version")).toThrow();
  });
});

describe("bumpAll", () => {
  const versions = Object.fromEntries(flattenGraph().map((e) => [e.name, "0.1.0"]));

  it("bumps every package in the graph together, by one patch", () => {
    const writes = [];
    const plan = bumpAll({
      readPkg: fakeReadPkg(versions),
      writePkg: (path, json) => writes.push({ path, json }),
      dryRun: false,
      log: () => {},
    });

    expect(plan).toHaveLength(EXPECTED_ORDER.length);
    for (const item of plan) {
      expect(item.oldVersion).toBe("0.1.0");
      expect(item.newVersion).toBe("0.1.1");
    }
    // dry-run: false means every package's package.json was actually written.
    expect(writes).toHaveLength(EXPECTED_ORDER.length);
  });

  it("--dry-run mode logs the plan but writes nothing", () => {
    const writes = [];
    const plan = bumpAll({
      readPkg: fakeReadPkg(versions),
      writePkg: (path, json) => writes.push({ path, json }),
      dryRun: true,
      log: () => {},
    });

    expect(plan).toHaveLength(EXPECTED_ORDER.length);
    expect(writes).toHaveLength(0);
  });
});

describe("runRelease (publish orchestration)", () => {
  const versions = Object.fromEntries(flattenGraph().map((e) => [e.name, "0.1.0"]));
  const readPkg = fakeReadPkg(versions);

  it("(c) publishes strictly in dependency-graph order", async () => {
    const published = [];
    const result = await runRelease({
      readPkg,
      checkExists: vi.fn().mockResolvedValue(false),
      publish: async (entry) => {
        published.push(entry.pkgName);
        return { status: 0 };
      },
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(published).toEqual(EXPECTED_ORDER);
  });

  it("(a) refuses to proceed if any target version already exists on the registry, before publishing anything", async () => {
    const published = [];
    const checkExists = vi.fn(async (pkgName) => pkgName === "@windower/daemon");

    const result = await runRelease({
      readPkg,
      checkExists,
      publish: async (entry) => {
        published.push(entry.pkgName);
        return { status: 0 };
      },
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.versionConflicts).toEqual(["@windower/daemon@0.1.0"]);
    // Preflight runs across the WHOLE graph before any publish starts.
    expect(checkExists).toHaveBeenCalledTimes(EXPECTED_ORDER.length);
    expect(published).toEqual([]);
  });

  it("(b) hard-stops at the failing package and does not continue publishing later packages", async () => {
    const published = [];
    const result = await runRelease({
      readPkg,
      checkExists: vi.fn().mockResolvedValue(false),
      publish: async (entry) => {
        published.push(entry.pkgName);
        if (entry.pkgName === "@windower/daemon") {
          return { status: 1, stderr: "403 Forbidden — You cannot publish over the previously published versions" };
        }
        return { status: 0 };
      },
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.failedAt.pkgName).toBe("@windower/daemon");
    // Attempted core, engine, engine-narration, daemon — then stopped.
    expect(published).toEqual([
      "@windower/core",
      "@windower/engine",
      "@windower/engine-narration",
      "@windower/daemon",
    ]);
    expect(published).not.toContain("@windower/cli");
    expect(published).not.toContain("@windower/mcp-server");
    expect(published).not.toContain("@windower/sidecar-macos-arm64");
    expect(published).not.toContain("@windower/sidecar-macos-x64");
  });

  it("--dry-run makes no registry or publish calls", async () => {
    const checkExists = vi.fn();
    const publish = vi.fn();

    const result = await runRelease({ readPkg, dryRun: true, checkExists, publish, log: () => {} });

    expect(result.ok).toBe(true);
    expect(checkExists).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
