import { describe, expect, it } from "vitest";
import { packageVersion } from "./version.js";

describe("packageVersion", () => {
  it("reads the real semver version from the caller's own package.json", () => {
    // import.meta.url here resolves to this file's location inside
    // @windower/core, so this should find packages/core/package.json.
    const version = packageVersion(import.meta.url);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe("0.0.0");
  });

  it("falls back when no package.json is found before the walk is exhausted", () => {
    const version = packageVersion("file:///nonexistent-root/deeply/nested/dir/module.js");
    expect(version).toBe("0.0.0");
  });

  it("honors a custom fallback", () => {
    const version = packageVersion("file:///nonexistent-root/deeply/nested/dir/module.js", "9.9.9");
    expect(version).toBe("9.9.9");
  });
});
