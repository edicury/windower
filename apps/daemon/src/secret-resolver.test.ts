import { DaemonError, type SecretRef } from "@windower/core";
import { describe, expect, it } from "vitest";
import { SecretResolver, redactSecrets } from "./secret-resolver.js";

describe("SecretResolver", () => {
  it("resolves env refs from the injected environment", async () => {
    const resolver = new SecretResolver({ env: { MY_PASSWORD: "hunter2" } });
    const refs: SecretRef[] = [{ name: "password", source: "env", ref: "MY_PASSWORD" }];
    await expect(resolver.resolveAll(refs)).resolves.toEqual([
      { name: "password", value: "hunter2" },
    ]);
  });

  it("fails with a structured error when an env ref is missing", async () => {
    const resolver = new SecretResolver({ env: {} });
    await expect(
      resolver.resolveAll([{ name: "password", source: "env", ref: "NOPE" }]),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it("delegates keychain refs to the swappable resolver (no platform branch)", async () => {
    const seen: string[] = [];
    const resolver = new SecretResolver({
      env: {},
      keychain: async (ref) => {
        seen.push(ref);
        return "from-store";
      },
    });
    await expect(
      resolver.resolveAll([{ name: "token", source: "keychain", ref: "windower-token" }]),
    ).resolves.toEqual([{ name: "token", value: "from-store" }]);
    expect(seen).toEqual(["windower-token"]);
  });

  it("surfaces a keychain resolver failure as a structured error", async () => {
    const resolver = new SecretResolver({
      env: {},
      keychain: async () => {
        throw new DaemonError("INVALID_ARGS", "no such item");
      },
    });
    await expect(
      resolver.resolveAll([{ name: "token", source: "keychain", ref: "missing" }]),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it("accepts literal refs but warns about shell-history exposure", async () => {
    const warnings: string[] = [];
    const resolver = new SecretResolver({ env: {}, warn: (m) => warnings.push(m) });
    await expect(
      resolver.resolveAll([{ name: "pin", source: "literal", ref: "1234" }]),
    ).resolves.toEqual([{ name: "pin", value: "1234" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("literal");
  });
});

describe("redactSecrets", () => {
  it("replaces secret values with their placeholders anywhere in a structure", () => {
    const redacted = redactSecrets(
      { toolCalls: [{ name: "type_text", args: { text: "login hunter2 now" } }], n: 3 },
      [{ name: "password", value: "hunter2" }],
    );
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).toContain("{{password}}");
  });

  it("is a no-op when there are no secrets", () => {
    const value = { a: "b" };
    expect(redactSecrets(value, [])).toBe(value);
  });
});
