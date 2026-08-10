import { DaemonError } from "@windower/core";
import { describe, expect, it } from "vitest";
import {
  EXIT_DAEMON_BUSY,
  EXIT_DAEMON_UNREACHABLE,
  EXIT_DAEMON_VERSION_MISMATCH,
  EXIT_GENERIC_FAILURE,
  EXIT_INVALID_ARGS,
  EXIT_PERMISSION_DENIED,
  EXIT_SUCCESS,
  exitCodeForError,
} from "./exit-codes.js";

describe("exitCodeForError", () => {
  it("maps DAEMON_UNREACHABLE to its own distinct code", () => {
    expect(exitCodeForError(new DaemonError("DAEMON_UNREACHABLE", "no daemon"))).toBe(
      EXIT_DAEMON_UNREACHABLE,
    );
  });

  it("maps INVALID_ARGS to its own distinct code", () => {
    expect(exitCodeForError(new DaemonError("INVALID_ARGS", "bad input"))).toBe(EXIT_INVALID_ARGS);
  });

  it("maps PERMISSION_DENIED to its own distinct code", () => {
    expect(exitCodeForError(new DaemonError("PERMISSION_DENIED", "Screen Recording denied"))).toBe(
      EXIT_PERMISSION_DENIED,
    );
  });

  it("maps DAEMON_BUSY to its own distinct code", () => {
    expect(exitCodeForError(new DaemonError("DAEMON_BUSY", "session abc123 still recording"))).toBe(
      EXIT_DAEMON_BUSY,
    );
  });

  it("maps DAEMON_VERSION_MISMATCH to its own distinct code", () => {
    expect(
      exitCodeForError(new DaemonError("DAEMON_VERSION_MISMATCH", "protocol version 1 != 2")),
    ).toBe(EXIT_DAEMON_VERSION_MISMATCH);
  });

  it("maps other DaemonErrorCodes to the generic failure code", () => {
    expect(exitCodeForError(new DaemonError("TARGET_NOT_FOUND", "no such target"))).toBe(
      EXIT_GENERIC_FAILURE,
    );
    expect(exitCodeForError(new DaemonError("INTERNAL_ERROR", "boom"))).toBe(EXIT_GENERIC_FAILURE);
    expect(exitCodeForError(new DaemonError("RESIZE_UNSUPPORTED", "no window-control"))).toBe(
      EXIT_GENERIC_FAILURE,
    );
    expect(
      exitCodeForError(new DaemonError("UNSUPPORTED_CAPABILITY", "missing capture.display")),
    ).toBe(EXIT_GENERIC_FAILURE);
    expect(exitCodeForError(new DaemonError("CAPTURE_FAILED", "sidecar died"))).toBe(
      EXIT_GENERIC_FAILURE,
    );
    expect(exitCodeForError(new DaemonError("SESSION_NOT_FOUND", "no such session"))).toBe(
      EXIT_GENERIC_FAILURE,
    );
  });

  it("maps a plain Error to the generic failure code", () => {
    expect(exitCodeForError(new Error("oops"))).toBe(EXIT_GENERIC_FAILURE);
  });

  it("maps a non-Error thrown value to the generic failure code", () => {
    expect(exitCodeForError("not an error")).toBe(EXIT_GENERIC_FAILURE);
  });

  it("codes are distinct from success and from each other", () => {
    const codes = [
      EXIT_SUCCESS,
      EXIT_GENERIC_FAILURE,
      EXIT_DAEMON_UNREACHABLE,
      EXIT_INVALID_ARGS,
      EXIT_PERMISSION_DENIED,
      EXIT_DAEMON_BUSY,
      EXIT_DAEMON_VERSION_MISMATCH,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
