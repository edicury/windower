import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { WindowerBackend } from "./backend.js";
import { DaemonClient } from "./client.js";

describe("WindowerBackend", () => {
  it("DaemonClient structurally satisfies WindowerBackend", () => {
    // Type-level check: this assignment only compiles if DaemonClient's
    // public method signatures match WindowerBackend 1:1 (method name,
    // params, and result types). Any drift between methods.ts and
    // client.ts/backend.ts fails `tsc`/`pnpm typecheck`, not just this test.
    const stream = new PassThrough();
    const client = new DaemonClient(stream);
    // Type-only assignment: fails to compile if DaemonClient drifts from
    // WindowerBackend's shape. Not read further; `client` (typed as
    // DaemonClient) is used below so DaemonClient-only members stay usable.
    const _backend: WindowerBackend = client;
    void _backend;

    expect(typeof client.hello).toBe("function");
    expect(typeof client.daemonInfo).toBe("function");
    expect(typeof client.listTargets).toBe("function");
    expect(typeof client.checkPermissions).toBe("function");
    expect(typeof client.requestPermission).toBe("function");
    expect(typeof client.resizeWindow).toBe("function");
    expect(typeof client.startRecording).toBe("function");
    expect(typeof client.getSession).toBe("function");
    expect(typeof client.stopRecording).toBe("function");
    expect(typeof client.cancelRecording).toBe("function");
    expect(typeof client.listSessions).toBe("function");
    expect(typeof client.runOperator).toBe("function");
    expect(typeof client.getOperatorRun).toBe("function");
    expect(typeof client.abortOperatorRun).toBe("function");
    expect(typeof client.listOperatorRuns).toBe("function");
    expect(typeof client.shutdown).toBe("function");

    client.dispose();
  });
});
