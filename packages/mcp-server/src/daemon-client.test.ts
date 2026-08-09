import { DaemonError } from "@windower/core";
import { describe, expect, it } from "vitest";
import { type ZodError, z } from "zod";
import { toMcpError } from "./daemon-client.js";

describe("toMcpError", () => {
  it("maps a DaemonError to an isError result carrying its code", () => {
    const result = toMcpError(new DaemonError("DAEMON_UNREACHABLE", "no daemon"));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("DAEMON_UNREACHABLE");
    expect(result.content[0]?.text).toContain("no daemon");
  });

  it("maps a ZodError to an INVALID_ARGS-tagged isError result", () => {
    const schema = z.object({ targetId: z.string() });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    const zodError = (parsed as { success: false; error: ZodError }).error;

    const result = toMcpError(zodError);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INVALID_ARGS");
  });

  it("maps a generic Error to an INTERNAL_ERROR-tagged isError result", () => {
    const result = toMcpError(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INTERNAL_ERROR");
    expect(result.content[0]?.text).toContain("boom");
  });

  it("maps a non-Error throw to an INTERNAL_ERROR-tagged isError result", () => {
    const result = toMcpError("just a string");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INTERNAL_ERROR");
    expect(result.content[0]?.text).toContain("just a string");
  });
});
