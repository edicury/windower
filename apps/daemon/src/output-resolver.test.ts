import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureTarget } from "@windower/core";
import { DaemonError } from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureWritableOutputDir,
  resolveFilenameTemplate,
  resolveUniqueOutputPath,
} from "./output-resolver.js";

const TIMESTAMP = new Date(2026, 7, 9, 12, 30, 0); // 2026-08-09T12:30:00 local

const WINDOW_TARGET: CaptureTarget = {
  kind: "window",
  id: "window-1",
  title: "Terminal",
  appName: "My/App: Terminal",
  appBundleId: "com.apple.Terminal",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  isFocused: true,
  resizable: true,
};

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in Display",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const REGION_TARGET: CaptureTarget = {
  kind: "region",
  displayId: "display-2",
  bounds: { x: 10, y: 10, width: 100, height: 100 },
};

describe("resolveFilenameTemplate", () => {
  it("substitutes {target} using appName for a window target", () => {
    const result = resolveFilenameTemplate("{target}-{timestamp}", {
      target: { ...WINDOW_TARGET, appName: "Terminal" },
      sessionId: "sess-1",
      timestamp: TIMESTAMP,
    });
    expect(result).toBe("Terminal-2026-08-09T12-30-00");
  });

  it("substitutes {target} using name for a display target", () => {
    const result = resolveFilenameTemplate("{target}-{timestamp}", {
      target: DISPLAY_TARGET,
      sessionId: "sess-1",
      timestamp: TIMESTAMP,
    });
    expect(result).toBe("Built-in Display-2026-08-09T12-30-00");
  });

  it("substitutes {target} using displayId for a region target", () => {
    const result = resolveFilenameTemplate("{target}-{timestamp}", {
      target: REGION_TARGET,
      sessionId: "sess-1",
      timestamp: TIMESTAMP,
    });
    expect(result).toBe("display-2-2026-08-09T12-30-00");
  });

  it("substitutes {sessionId}, {date}, and {time}", () => {
    const result = resolveFilenameTemplate("{sessionId}_{date}_{time}", {
      target: DISPLAY_TARGET,
      sessionId: "sess-abc-123",
      timestamp: TIMESTAMP,
    });
    expect(result).toBe("sess-abc-123_2026-08-09_12-30-00");
  });

  it("{timestamp} is sortable and contains no colons", () => {
    const result = resolveFilenameTemplate("{timestamp}", {
      target: DISPLAY_TARGET,
      sessionId: "sess-1",
      timestamp: TIMESTAMP,
    });
    expect(result).not.toContain(":");
    expect(result).toBe("2026-08-09T12-30-00");
  });

  it("sanitizes unsafe characters (path separators, colons) from a window appName", () => {
    const result = resolveFilenameTemplate("{target}", {
      target: WINDOW_TARGET, // appName: "My/App: Terminal"
      sessionId: "sess-1",
      timestamp: TIMESTAMP,
    });
    expect(result).not.toContain("/");
    expect(result).not.toContain(":");
    expect(result).toBe("My_App_ Terminal");
  });

  it("leaves an unrecognized {placeholder} untouched", () => {
    const result = resolveFilenameTemplate("{unknown}-{target}", {
      target: DISPLAY_TARGET,
      sessionId: "sess-1",
      timestamp: TIMESTAMP,
    });
    expect(result).toBe("{unknown}-Built-in Display");
  });
});

describe("ensureWritableOutputDir", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "windower-output-resolver-"));
  });

  afterEach(async () => {
    // Restore permissions in case a failure test left something locked down,
    // so cleanup doesn't itself fail.
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("succeeds on a writable temp dir", async () => {
    await expect(ensureWritableOutputDir(root)).resolves.toBeUndefined();
  });

  it("creates missing nested directories (mkdir -p semantics)", async () => {
    const nested = join(root, "a", "b", "c");
    await ensureWritableOutputDir(nested);
    // No throw = success; a probe file write/unlink inside `nested` proved
    // both that mkdir -p ran and that the resulting dir is writable.
    await expect(ensureWritableOutputDir(nested)).resolves.toBeUndefined();
  });

  it("throws DaemonError with OUTPUT_DIR_NOT_WRITABLE for a non-writable directory", async () => {
    const readonlyDir = join(root, "readonly");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(readonlyDir);
    await chmod(readonlyDir, 0o444);

    // Skip when running as root (e.g. some CI/sandbox containers), where
    // permission bits don't block writes and this test would be unreliable.
    if (process.getuid && process.getuid() === 0) {
      return;
    }

    await expect(ensureWritableOutputDir(readonlyDir)).rejects.toMatchObject({
      name: "DaemonError",
      code: "OUTPUT_DIR_NOT_WRITABLE",
    });
    await expect(ensureWritableOutputDir(readonlyDir)).rejects.toBeInstanceOf(DaemonError);
  });
});

describe("resolveUniqueOutputPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-output-resolver-unique-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the plain path when nothing exists", async () => {
    const path = await resolveUniqueOutputPath(dir, "recording", ".mp4");
    expect(path).toBe(join(dir, "recording.mp4"));
  });

  it("returns a -2 suffixed path when the base already exists", async () => {
    await writeFile(join(dir, "recording.mp4"), "existing");
    const path = await resolveUniqueOutputPath(dir, "recording", ".mp4");
    expect(path).toBe(join(dir, "recording-2.mp4"));
  });

  it("returns a -3 suffixed path when base and -2 both exist", async () => {
    await writeFile(join(dir, "recording.mp4"), "existing");
    await writeFile(join(dir, "recording-2.mp4"), "existing");
    const path = await resolveUniqueOutputPath(dir, "recording", ".mp4");
    expect(path).toBe(join(dir, "recording-3.mp4"));
  });

  it("never returns a path that already exists on disk", async () => {
    await writeFile(join(dir, "recording.mp4"), "existing");
    const path = await resolveUniqueOutputPath(dir, "recording", ".mp4");
    await writeFile(path, "new content");
    // A second resolution must skip both now-existing files.
    const secondPath = await resolveUniqueOutputPath(dir, "recording", ".mp4");
    expect(secondPath).toBe(join(dir, "recording-3.mp4"));
  });
});
