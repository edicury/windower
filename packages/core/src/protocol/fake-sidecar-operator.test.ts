import { describe, expect, it } from "vitest";
import type { CaptureTarget } from "../schemas/capture-target.js";
import type { InputAction } from "../schemas/input-action.js";
import { SidecarError } from "./errors.js";
import { createFakeSidecarPair } from "./fake-sidecar.js";

/**
 * Phase 19 — `performInput` / `captureFrame` against the in-memory fake
 * sidecar. Covers both new error codes from
 * contracts/sidecar-protocol.md §Error taxonomy.
 */

const display: CaptureTarget = {
  kind: "display",
  id: "1",
  name: "Built-in Display",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

async function expectSidecarError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SidecarError);
  await promise.catch((err: SidecarError) => {
    expect(err.code).toBe(code);
  });
}

describe("FakeSidecar.performInput", () => {
  it("performs a batch and records what was performed, in order", async () => {
    const { client, sidecar, dispose } = createFakeSidecarPair();
    try {
      const actions: InputAction[] = [
        { kind: "mouse_click", x: 100, y: 200, button: "left" },
        { kind: "type_text", text: "hello" },
        { kind: "wait", durationMs: 50 },
      ];
      const result = await client.performInput({ actions });
      expect(result).toEqual({ performed: 3 });
      expect(sidecar.performed).toEqual(actions);
    } finally {
      dispose();
    }
  });

  it("accumulates across calls and can be cleared", async () => {
    const { client, sidecar, dispose } = createFakeSidecarPair();
    try {
      await client.performInput({ actions: [{ kind: "mouse_move", x: 1, y: 1 }] });
      await client.performInput({ actions: [{ kind: "mouse_move", x: 2, y: 2 }] });
      expect(sidecar.performed).toHaveLength(2);
      sidecar.clearRecordedCalls();
      expect(sidecar.performed).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("throws INPUT_OUT_OF_BOUNDS for a coordinate outside every display", async () => {
    const { client, sidecar, dispose } = createFakeSidecarPair({
      displayBounds: [{ x: 0, y: 0, width: 800, height: 600 }],
    });
    try {
      await expectSidecarError(
        client.performInput({
          actions: [{ kind: "mouse_click", x: 5000, y: 10, button: "left" }],
        }),
        "INPUT_OUT_OF_BOUNDS",
      );
      // Rejected batches are atomic — nothing was performed.
      expect(sidecar.performed).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("bounds-checks both ends of a drag", async () => {
    const { client, dispose } = createFakeSidecarPair({
      displayBounds: [{ x: 0, y: 0, width: 800, height: 600 }],
    });
    try {
      await expectSidecarError(
        client.performInput({
          actions: [
            { kind: "mouse_drag", fromX: 10, fromY: 10, toX: 10, toY: 5000, button: "left" },
          ],
        }),
        "INPUT_OUT_OF_BOUNDS",
      );
    } finally {
      dispose();
    }
  });

  it("accepts coordinates on a secondary display", async () => {
    const { client, dispose } = createFakeSidecarPair({
      displayBounds: [
        { x: 0, y: 0, width: 800, height: 600 },
        { x: 800, y: 0, width: 1920, height: 1080 },
      ],
    });
    try {
      await expect(
        client.performInput({
          actions: [{ kind: "mouse_click", x: 1500, y: 900, button: "left" }],
        }),
      ).resolves.toEqual({ performed: 1 });
    } finally {
      dispose();
    }
  });

  it("does not bounds-check keyboard/wait actions", async () => {
    const { client, dispose } = createFakeSidecarPair({ displayBounds: [] });
    try {
      await expect(
        client.performInput({
          actions: [{ kind: "key_press", key: "Return", modifiers: ["cmd"] }],
        }),
      ).resolves.toEqual({ performed: 1 });
    } finally {
      dispose();
    }
  });

  it("throws INPUT_UNSUPPORTED for a kind the backend can't synthesize", async () => {
    const { client, sidecar, dispose } = createFakeSidecarPair({
      unsupportedInputKinds: ["scroll"],
    });
    try {
      await expectSidecarError(
        client.performInput({
          actions: [{ kind: "scroll", x: 10, y: 10, deltaX: 0, deltaY: -3 }],
        }),
        "INPUT_UNSUPPORTED",
      );
      expect(sidecar.performed).toHaveLength(0);
      // Other kinds still work.
      await expect(
        client.performInput({ actions: [{ kind: "mouse_move", x: 10, y: 10 }] }),
      ).resolves.toEqual({ performed: 1 });
    } finally {
      dispose();
    }
  });

  it("throws UNSUPPORTED_CAPABILITY when input.keyboard is not advertised", async () => {
    const { client, dispose } = createFakeSidecarPair({
      capabilities: ["input.mouse", "screenshot"],
    });
    try {
      await expectSidecarError(
        client.performInput({ actions: [{ kind: "type_text", text: "hi" }] }),
        "UNSUPPORTED_CAPABILITY",
      );
      await expect(
        client.performInput({ actions: [{ kind: "mouse_move", x: 10, y: 10 }] }),
      ).resolves.toEqual({ performed: 1 });
    } finally {
      dispose();
    }
  });

  it("throws PERMISSION_DENIED when accessibility is not granted", async () => {
    const { client, dispose } = createFakeSidecarPair({
      permissions: { accessibility: "denied", screenRecording: "granted" },
    });
    try {
      await expectSidecarError(
        client.performInput({ actions: [{ kind: "mouse_move", x: 1, y: 1 }] }),
        "PERMISSION_DENIED",
      );
    } finally {
      dispose();
    }
  });

  it("throws SESSION_NOT_FOUND for an unknown sessionId", async () => {
    const { client, dispose } = createFakeSidecarPair();
    try {
      await expectSidecarError(
        client.performInput({
          sessionId: "nope",
          actions: [{ kind: "mouse_move", x: 1, y: 1 }],
        }),
        "SESSION_NOT_FOUND",
      );
    } finally {
      dispose();
    }
  });

  it("rejects a malformed action at the client's own params-validation boundary", async () => {
    const { client, dispose } = createFakeSidecarPair();
    try {
      // SidecarClient validates params against the frozen schema before the
      // request ever reaches the wire, so this never becomes a SidecarError.
      await expect(
        client.performInput({
          actions: [{ kind: "teleport", x: 1, y: 2 }],
        } as never),
      ).rejects.toThrow();
    } finally {
      dispose();
    }
  });
});

describe("FakeSidecar.captureFrame", () => {
  it("returns a real, decodable PNG sized from the target bounds", async () => {
    const { client, sidecar, dispose } = createFakeSidecarPair();
    try {
      const result = await client.captureFrame({ target: display, format: "png" });
      expect(result).toEqual({
        imageBase64: expect.any(String),
        width: 1920,
        height: 1080,
        scale: 2,
      });
      const bytes = Buffer.from(result.imageBase64, "base64");
      // PNG magic number.
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(sidecar.frameCaptures).toHaveLength(1);
      expect(sidecar.frameCaptures[0]?.format).toBe("png");
    } finally {
      dispose();
    }
  });

  it("downscales to maxWidth, preserving aspect ratio", async () => {
    const { client, dispose } = createFakeSidecarPair();
    try {
      const result = await client.captureFrame({
        target: display,
        format: "jpeg",
        maxWidth: 960,
        quality: 0.8,
      });
      expect(result.width).toBe(960);
      expect(result.height).toBe(540);
    } finally {
      dispose();
    }
  });

  it("leaves a target narrower than maxWidth alone", async () => {
    const { client, dispose } = createFakeSidecarPair();
    try {
      const result = await client.captureFrame({
        target: { kind: "region", displayId: "1", bounds: { x: 0, y: 0, width: 400, height: 300 } },
        format: "png",
        maxWidth: 960,
      });
      expect(result).toMatchObject({ width: 400, height: 300, scale: 1 });
    } finally {
      dispose();
    }
  });

  it("throws UNSUPPORTED_CAPABILITY when the backend has no screenshot capability", async () => {
    const { client, dispose } = createFakeSidecarPair({ capabilities: ["input.mouse"] });
    try {
      await expectSidecarError(
        client.captureFrame({ target: display, format: "png" }),
        "UNSUPPORTED_CAPABILITY",
      );
    } finally {
      dispose();
    }
  });

  it("throws PERMISSION_DENIED without Screen Recording", async () => {
    const { client, dispose } = createFakeSidecarPair({
      permissions: { screenRecording: "denied" },
    });
    try {
      await expectSidecarError(
        client.captureFrame({ target: display, format: "png" }),
        "PERMISSION_DENIED",
      );
    } finally {
      dispose();
    }
  });
});

describe("describe()", () => {
  it("advertises the Phase 19 capabilities by default", async () => {
    const { client, dispose } = createFakeSidecarPair();
    try {
      const result = await client.describe();
      expect(result.capabilities).toEqual(
        expect.arrayContaining(["input.mouse", "input.keyboard", "screenshot"]),
      );
    } finally {
      dispose();
    }
  });
});
