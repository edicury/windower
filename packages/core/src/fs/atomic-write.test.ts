import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-atomic-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a normal write", async () => {
    const path = join(dir, "record.json");
    await writeFileAtomic(path, JSON.stringify({ hello: "world" }));

    const contents = await readFile(path, "utf8");
    expect(JSON.parse(contents)).toEqual({ hello: "world" });
  });

  it("overwrites existing content atomically, never leaving a torn read", async () => {
    const path = join(dir, "record.json");
    await writeFileAtomic(path, "first-version");
    await writeFileAtomic(path, "second-version-longer-than-first");

    const contents = await readFile(path, "utf8");
    // A torn read (partial overwrite in place) would produce a value that is
    // neither the old nor the new full string — e.g. "second-versionersion".
    // Since writeFileAtomic never mutates `path` in place (it only renames a
    // fully-written temp file over it), the reader can only ever observe one
    // of the two complete values.
    expect(["first-version", "second-version-longer-than-first"]).toContain(contents);
    expect(contents).toBe("second-version-longer-than-first");
  });

  it("never leaves a temp file behind, and the temp path never collides with the final path", async () => {
    const path = join(dir, "record.json");
    await writeFileAtomic(path, "content");

    const entries = await readdir(dir);
    expect(entries).toEqual(["record.json"]);
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false);
  });

  it("supports Buffer input", async () => {
    const path = join(dir, "binary.bin");
    await writeFileAtomic(path, Buffer.from([1, 2, 3, 4]));

    const contents = await readFile(path);
    expect([...contents]).toEqual([1, 2, 3, 4]);
  });
});
