import { describe, expect, it } from "vitest";
import { type BackendMode, type CommandId, POLICY_TABLE, resolveBackendMode } from "./policy.js";

// Hardcoded from a direct reading of contracts/cli.md's "Daemon policy"
// table (as of Phase 20). This is intentionally a second, independent
// transcription of that table rather than a re-derivation from
// POLICY_TABLE, so a typo in policy.ts's transcription would still be
// caught here. A later CLI-side test asserts every *registered commander
// command* has a policy entry, which is a different (and stricter) check.
const EXPECTED: Record<CommandId, BackendMode> = {
  record: "local",
  targets: "local",
  doctor: "local",
  "permission request": "local",
  resize: "local",
  status: "local",
  list: "local",
  "config get": "local",
  "config set": "local",
  operate: "local",
  "operate status": "local",
  "operate list": "local",
  start: "daemon",
  "operate abort": "daemon",
  stop: "attach",
  cancel: "attach",
  "daemon status": "attach",
  "daemon stop": "attach",
  "daemon restart": "attach",
  "daemon kill": "local",
};

describe("POLICY_TABLE", () => {
  it("has an entry for every command in contracts/cli.md's Daemon policy table", () => {
    for (const command of Object.keys(EXPECTED) as CommandId[]) {
      expect(POLICY_TABLE[command]).toBe(EXPECTED[command]);
    }
  });

  it("has no extra entries beyond contracts/cli.md's Daemon policy table", () => {
    expect(Object.keys(POLICY_TABLE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe("resolveBackendMode", () => {
  it("matches POLICY_TABLE for every command when no options are passed", () => {
    for (const command of Object.keys(EXPECTED) as CommandId[]) {
      expect(resolveBackendMode(command)).toBe(EXPECTED[command]);
    }
  });

  it("operate defaults to local (blocking)", () => {
    expect(resolveBackendMode("operate")).toBe("local");
    expect(resolveBackendMode("operate", { detach: false })).toBe("local");
  });

  it("operate --detach forces daemon mode", () => {
    expect(resolveBackendMode("operate", { detach: true })).toBe("daemon");
  });

  it("--detach is a no-op for every other command", () => {
    for (const command of Object.keys(EXPECTED) as CommandId[]) {
      if (command === "operate") continue;
      expect(resolveBackendMode(command, { detach: true })).toBe(EXPECTED[command]);
    }
  });
});
