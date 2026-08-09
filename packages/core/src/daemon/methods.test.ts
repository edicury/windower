import { describe, expect, it } from "vitest";
import { DaemonErrorCodeSchema } from "./methods.js";

describe("DaemonErrorCodeSchema", () => {
  it("includes the Phase 20 hello-handshake error codes", () => {
    expect(DaemonErrorCodeSchema.options).toContain("DAEMON_VERSION_MISMATCH");
    expect(DaemonErrorCodeSchema.options).toContain("DAEMON_BUSY");
  });

  it("still accepts pre-existing daemon-only codes", () => {
    expect(DaemonErrorCodeSchema.options).toContain("OUTPUT_DIR_NOT_WRITABLE");
    expect(DaemonErrorCodeSchema.options).toContain("OPERATOR_RUN_NOT_FOUND");
  });
});
