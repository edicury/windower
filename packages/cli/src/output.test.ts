import type { Writable } from "node:stream";
import { DaemonError } from "@windower/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_DAEMON_UNREACHABLE,
  EXIT_GENERIC_FAILURE,
  EXIT_PERMISSION_DENIED,
} from "./exit-codes.js";
import { printError, printResult } from "./output.js";

/**
 * `process.stdout.write`/`process.stderr.write` are overloaded in a way
 * `vi.spyOn`'s return type can't be named cleanly; capture just the calls
 * we care about (single string-chunk writes) behind a small typed wrapper.
 */
function spyOnWrite(stream: Writable): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string) => {
    calls.push(chunk);
    return true;
  }) as unknown as typeof original);
  return { calls, restore: () => spy.mockRestore() };
}

describe("printResult", () => {
  let stdoutWrite: ReturnType<typeof spyOnWrite>;

  beforeEach(() => {
    stdoutWrite = spyOnWrite(process.stdout);
  });

  afterEach(() => {
    stdoutWrite.restore();
  });

  it("prints pretty JSON when json is true", () => {
    printResult(true, { a: 1 }, () => "human rendering");
    expect(stdoutWrite.calls).toEqual([`${JSON.stringify({ a: 1 }, null, 2)}\n`]);
  });

  it("prints the human rendering when json is false", () => {
    printResult(false, { a: 1 }, (data) => `a=${data.a}`);
    expect(stdoutWrite.calls).toEqual(["a=1\n"]);
  });
});

describe("printError", () => {
  let stderrWrite: ReturnType<typeof spyOnWrite>;

  beforeEach(() => {
    stderrWrite = spyOnWrite(process.stderr);
  });

  afterEach(() => {
    stderrWrite.restore();
  });

  it("prints a JSON error body and returns the mapped exit code", () => {
    const code = printError(true, new DaemonError("DAEMON_UNREACHABLE", "no daemon"));
    expect(stderrWrite.calls).toEqual([
      `${JSON.stringify({ error: { code: "DAEMON_UNREACHABLE", message: "no daemon" } }, null, 2)}\n`,
    ]);
    expect(code).toBe(EXIT_DAEMON_UNREACHABLE);
  });

  it("prints PERMISSION_DENIED with its own exit code", () => {
    const code = printError(
      true,
      new DaemonError("PERMISSION_DENIED", "Screen Recording permission not granted"),
    );
    expect(stderrWrite.calls).toEqual([
      `${JSON.stringify(
        {
          error: {
            code: "PERMISSION_DENIED",
            message: "Screen Recording permission not granted",
          },
        },
        null,
        2,
      )}\n`,
    ]);
    expect(code).toBe(EXIT_PERMISSION_DENIED);
  });

  it("prints a plain text error line in human mode", () => {
    const code = printError(false, new Error("boom"));
    expect(stderrWrite.calls).toEqual(["Error: boom\n"]);
    expect(code).toBe(EXIT_GENERIC_FAILURE);
  });

  it("handles a non-Error thrown value", () => {
    const code = printError(false, "just a string");
    expect(stderrWrite.calls).toEqual(["Error: just a string\n"]);
    expect(code).toBe(EXIT_GENERIC_FAILURE);
  });
});
