import type { ResolvedWindowerConfig } from "@windower/core";
import { describe, expect, it } from "vitest";
import {
  getConfigValue,
  mergeConfigSet,
  renderConfigGetResult,
  renderConfigSetResult,
} from "./config.js";

const RESOLVED: ResolvedWindowerConfig = {
  outputDir: "/Users/me/Movies/Windower",
  filenameTemplate: "{target}-{timestamp}",
  daemonIdleTimeoutMs: 1_800_000,
};

describe("getConfigValue", () => {
  it("returns the value for a known top-level key", () => {
    expect(getConfigValue(RESOLVED, "outputDir")).toEqual({
      key: "outputDir",
      value: "/Users/me/Movies/Windower",
    });
  });

  it("returns undefined value for an unset optional key", () => {
    expect(getConfigValue(RESOLVED, "defaultVideo")).toEqual({
      key: "defaultVideo",
      value: undefined,
    });
  });

  it("throws INVALID_ARGS for an unknown key", () => {
    expect(() => getConfigValue(RESOLVED, "bogus")).toThrow(/Unknown config key "bogus"/);
  });
});

describe("mergeConfigSet", () => {
  it("sets a top-level string key", () => {
    expect(mergeConfigSet({}, "outputDir", "/tmp/out")).toEqual({ outputDir: "/tmp/out" });
  });

  it("parses daemonIdleTimeoutMs as a number", () => {
    expect(mergeConfigSet({}, "daemonIdleTimeoutMs", "60000")).toEqual({
      daemonIdleTimeoutMs: 60000,
    });
  });

  it("throws for a non-numeric daemonIdleTimeoutMs", () => {
    expect(() => mergeConfigSet({}, "daemonIdleTimeoutMs", "abc")).toThrow(/Invalid value/);
  });

  it("merges a dotted path into a nested defaultVideo object", () => {
    expect(mergeConfigSet({}, "defaultVideo.fps", "30")).toEqual({ defaultVideo: { fps: 30 } });
  });

  it("preserves existing nested keys when merging a new dotted path", () => {
    const base = { defaultVideo: { fps: 30 } };
    expect(mergeConfigSet(base, "defaultVideo.codec", "hevc")).toEqual({
      defaultVideo: { fps: 30, codec: "hevc" },
    });
  });

  it("falls back to the raw string when a dotted-path leaf isn't valid JSON", () => {
    expect(mergeConfigSet({}, "defaultVideo.codec", "hevc")).toEqual({
      defaultVideo: { codec: "hevc" },
    });
  });

  it("throws INVALID_ARGS for an unknown top-level key", () => {
    expect(() => mergeConfigSet({}, "bogus", "1")).toThrow(/Unknown config key "bogus"/);
  });

  it("throws INVALID_ARGS for a dotted path under a non-nested key", () => {
    expect(() => mergeConfigSet({}, "outputDir.sub", "x")).toThrow(/cannot have a dotted sub-path/);
  });
});

describe("renderConfigGetResult / renderConfigSetResult", () => {
  it("renders a scalar value", () => {
    expect(renderConfigGetResult({ key: "outputDir", value: "/tmp" })).toBe("outputDir: /tmp");
  });

  it("renders an unset value", () => {
    expect(renderConfigGetResult({ key: "defaultVideo", value: undefined })).toBe(
      "defaultVideo: (unset)",
    );
  });

  it("renders an object value as JSON", () => {
    expect(renderConfigGetResult({ key: "defaultVideo", value: { fps: 30 } })).toBe(
      'defaultVideo: {"fps":30}',
    );
  });

  it("renders a set confirmation", () => {
    expect(renderConfigSetResult({ key: "outputDir", value: "/tmp" })).toBe(
      "outputDir set to /tmp",
    );
  });
});
