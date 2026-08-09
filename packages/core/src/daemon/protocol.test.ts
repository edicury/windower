import { describe, expect, it } from "vitest";
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonHelloEnvSchema,
  DaemonHelloRequestSchema,
  DaemonHelloResultSchema,
  DaemonIdentitySchema,
  DaemonInfoParamsSchema,
  DaemonInfoResultSchema,
} from "./protocol.js";

describe("DAEMON_PROTOCOL_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(DAEMON_PROTOCOL_VERSION)).toBe(true);
    expect(DAEMON_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe("DaemonHelloRequestSchema", () => {
  const base = {
    clientName: "windower-cli",
    clientVersion: "0.3.0",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    windowerHome: "/Users/x/.windower",
    cwd: "/Users/x/project",
  };

  it("round-trips without an env snapshot", () => {
    const parsed = DaemonHelloRequestSchema.parse(base);
    expect(parsed).toEqual(base);
  });

  it("round-trips with a scoped env snapshot", () => {
    const withEnv = {
      ...base,
      env: {
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        apiKeyValue: "sk-test",
        secretRefs: [{ name: "MY_SECRET", value: "shh" }],
      },
    };
    const parsed = DaemonHelloRequestSchema.parse(withEnv);
    expect(parsed).toEqual(withEnv);
  });

  it("rejects a missing required field", () => {
    const { windowerHome: _omit, ...missing } = base;
    expect(() => DaemonHelloRequestSchema.parse(missing)).toThrow();
  });
});

describe("DaemonHelloEnvSchema", () => {
  it("allows an empty object (all fields optional)", () => {
    expect(DaemonHelloEnvSchema.parse({})).toEqual({});
  });
});

describe("DaemonIdentitySchema / DaemonHelloResultSchema / DaemonInfoResultSchema", () => {
  const identity = {
    pid: 4821,
    version: "0.3.0",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    startedAt: "2026-08-09T14:02:11.000Z",
    socketPath: "/Users/x/.windower/daemon.sock",
    windowerHome: "/Users/x/.windower",
    execPath: "/usr/local/bin/node",
    entryPath: "/usr/local/lib/node_modules/windower/apps/daemon/dist/main.js",
  };

  it("DaemonIdentitySchema round-trips", () => {
    expect(DaemonIdentitySchema.parse(identity)).toEqual(identity);
  });

  it("hello's result and daemon_info's result accept the same identity shape", () => {
    expect(DaemonHelloResultSchema.parse(identity)).toEqual(identity);
    expect(DaemonInfoResultSchema.parse(identity)).toEqual(identity);
  });

  it("rejects a non-integer pid", () => {
    expect(() => DaemonIdentitySchema.parse({ ...identity, pid: 1.5 })).toThrow();
  });
});

describe("DaemonInfoParamsSchema", () => {
  it("accepts an empty object", () => {
    expect(DaemonInfoParamsSchema.parse({})).toEqual({});
  });
});
