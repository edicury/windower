import type { DaemonHelloRequest } from "@windower/core";
import { describe, expect, it } from "vitest";
import { buildRequestContext } from "./request-context.js";

const BASE: DaemonHelloRequest = {
  clientName: "windower-cli",
  clientVersion: "0.0.0-test",
  protocolVersion: 1,
  cwd: "/callers/cwd",
  windowerHome: "/callers/.windower",
};

describe("buildRequestContext", () => {
  it("yields an empty scoped env when hello carried no `env` at all", () => {
    const context = buildRequestContext(BASE);
    // Empty — NOT the daemon's own `process.env`. `OperatorRunEngine` reads
    // "empty" as "nothing scoped" and lets the run fall back to `process.env`.
    expect(context.env).toEqual({});
    expect(context.resolvedSecrets).toEqual([]);
    expect(context.cwd).toBe("/callers/cwd");
    expect(context.windowerHome).toBe("/callers/.windower");
  });

  it("yields an empty scoped env when `env` is present but names no API key", () => {
    const context = buildRequestContext({ ...BASE, env: {} });
    expect(context.env).toEqual({});
    expect(context.resolvedSecrets).toEqual([]);
  });

  it("keys the caller's forwarded API key by the env var name hello named", () => {
    const context = buildRequestContext({
      ...BASE,
      env: { apiKeyEnvVar: "MY_CUSTOM_KEY", apiKeyValue: "fake-key-value" },
    });
    expect(context.env).toEqual({ MY_CUSTOM_KEY: "fake-key-value" });
  });

  it("carries forwarded env-sourced secret refs through unchanged", () => {
    const context = buildRequestContext({
      ...BASE,
      env: {
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        apiKeyValue: "fake-key-value",
        secretRefs: [{ name: "password", value: "fake-secret-value" }],
      },
    });
    expect(context.env).toEqual({ ANTHROPIC_API_KEY: "fake-key-value" });
    expect(context.resolvedSecrets).toEqual([{ name: "password", value: "fake-secret-value" }]);
  });

  it("ignores a half-specified env (a var name with no value, or a value with no name)", () => {
    expect(
      buildRequestContext({ ...BASE, env: { apiKeyEnvVar: "ANTHROPIC_API_KEY" } }).env,
    ).toEqual({});
    expect(buildRequestContext({ ...BASE, env: { apiKeyValue: "fake-key-value" } }).env).toEqual(
      {},
    );
  });

  it("returns a plain copyable object with no live reference to the request", () => {
    const request: DaemonHelloRequest = {
      ...BASE,
      env: { apiKeyEnvVar: "ANTHROPIC_API_KEY", apiKeyValue: "fake-key-value" },
    };
    const context = buildRequestContext(request);
    // A detached run outlives the connection, so mutating the request after
    // the fact must not reach into the context.
    if (request.env) request.env.apiKeyValue = "mutated";
    expect(context.env.ANTHROPIC_API_KEY).toBe("fake-key-value");
  });
});
