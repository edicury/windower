import type { CancelRecordingResult, StopRecordingResult, WindowerBackend } from "@windower/core";
import { describe, expect, it, vi } from "vitest";
import { renderRecordResult, runInterruptibleRecording } from "./record.js";

describe("renderRecordResult", () => {
  it("renders the same as the stop result (record prints the final stop output)", () => {
    const result: StopRecordingResult = {
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      manifest: {} as StopRecordingResult["manifest"],
    };
    expect(renderRecordResult(result)).toContain("/out/rec.mp4");
    expect(renderRecordResult(result)).toContain("/out/rec.manifest.json");
  });
});

/**
 * `runInterruptibleRecording` — `record`'s Ctrl-C semantics
 * (`contracts/cli.md` "Ctrl-C semantics"). Fires synthetic `SIGINT` process
 * events instead of waiting out a real duration; `durationMs` is set high
 * enough in every test that the timer never fires first.
 */
describe("runInterruptibleRecording", () => {
  function fakeBackend(
    overrides: Partial<Pick<WindowerBackend, "stopRecording" | "cancelRecording">> = {},
  ): WindowerBackend {
    return {
      stopRecording: vi.fn().mockResolvedValue({
        outputPath: "/out/rec.mp4",
        manifestPath: "/out/rec.manifest.json",
        manifest: {} as StopRecordingResult["manifest"],
      } satisfies StopRecordingResult),
      cancelRecording: vi
        .fn()
        .mockResolvedValue({ canceled: true } satisfies CancelRecordingResult),
      ...overrides,
    } as unknown as WindowerBackend;
  }

  it("finalizes (stopRecording) when the duration elapses with no Ctrl-C", async () => {
    const backend = fakeBackend();
    const outcome = await runInterruptibleRecording(backend, "sess-1", 5, false);

    expect(outcome.canceled).toBe(false);
    expect(backend.stopRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(backend.cancelRecording).not.toHaveBeenCalled();
  });

  it("the first Ctrl-C finalizes by default", async () => {
    const backend = fakeBackend();
    const promise = runInterruptibleRecording(backend, "sess-1", 60_000, false);

    process.emit("SIGINT");

    const outcome = await promise;
    expect(outcome.canceled).toBe(false);
    expect(backend.stopRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(backend.cancelRecording).not.toHaveBeenCalled();
  });

  it("--discard makes the first Ctrl-C cancel instead of finalize", async () => {
    const backend = fakeBackend();
    const promise = runInterruptibleRecording(backend, "sess-1", 60_000, true);

    process.emit("SIGINT");

    const outcome = await promise;
    expect(outcome.canceled).toBe(true);
    expect(backend.cancelRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(backend.stopRecording).not.toHaveBeenCalled();
  });

  it("a second Ctrl-C before the first (finalize) settles cancels instead", async () => {
    let resolveStop: (value: StopRecordingResult) => void = () => {};
    const backend = fakeBackend({
      stopRecording: vi.fn().mockImplementation(
        () =>
          new Promise<StopRecordingResult>((resolve) => {
            resolveStop = resolve;
          }),
      ),
    });

    const promise = runInterruptibleRecording(backend, "sess-1", 60_000, false);

    process.emit("SIGINT"); // first: starts finalize, stopRecording never resolves
    await Promise.resolve(); // let the first SIGINT's synchronous handling run
    process.emit("SIGINT"); // second: forces cancel before the first settles

    const outcome = await promise;
    expect(outcome.canceled).toBe(true);
    expect(backend.cancelRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });

    // The abandoned stopRecording call is never awaited by the outcome —
    // resolve it late to make sure that doesn't retroactively flip the
    // already-settled outcome or leave a dangling unhandled rejection.
    resolveStop({
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      manifest: {} as StopRecordingResult["manifest"],
    });
  });

  it("surfaces a stopRecording error via outcome.error rather than throwing", async () => {
    const backend = fakeBackend({ stopRecording: vi.fn().mockRejectedValue(new Error("boom")) });
    const outcome = await runInterruptibleRecording(backend, "sess-1", 5, false);
    expect(outcome.error).toBeInstanceOf(Error);
  });
});
