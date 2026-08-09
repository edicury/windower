import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type EventTimeline,
  EventTimelineSchema,
  type TimelineEvent,
  TimelineEventSchema,
} from "@windower/core";

/**
 * Accumulates a session's `TimelineEvent`s to a temp NDJSON file as they
 * stream in from the sidecar's `event` notification, then validates and
 * writes the final `<recording>.events.json` on `finalize()` (or discards
 * the temp file on `cancel`/failure paths). Mirrors the sidecar's own
 * temp-video-path convention (CaptureService.swift), just on the TS side —
 * see contracts/sidecar-protocol.md: "streaming write, not buffered to end
 * — a crash mid-recording still leaves a partial, valid-JSON-lines... file".
 */
export class EventTimelineWriter {
  private readonly sessionId: string;
  private readonly tempPath: string;
  /** Serializes appends so concurrent `append()` calls don't interleave partial writes. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.tempPath = join(tmpdir(), `windower-${sessionId}.events.jsonl`);
  }

  async append(event: TimelineEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue.then(() => appendFile(this.tempPath, line, "utf8"));
    return this.writeQueue;
  }

  async finalize(finalPath: string, capabilities: { keystrokes: boolean }): Promise<void> {
    await this.writeQueue.catch(() => {});

    const raw = await readFile(this.tempPath, "utf8").catch((err) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    });

    const events: TimelineEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip malformed/corrupt lines (e.g. a crash mid-write left a
      // truncated JSON line, or a line that fails TimelineEvent shape
      // validation) rather than failing the whole recording.
      try {
        const parsed = TimelineEventSchema.safeParse(JSON.parse(trimmed));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // JSON.parse threw — not valid JSON at all; skip.
      }
    }

    const timeline: EventTimeline = EventTimelineSchema.parse({
      sessionId: this.sessionId,
      events,
      capabilities,
    });

    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
    await rm(this.tempPath, { force: true });
  }

  async discard(): Promise<void> {
    await this.writeQueue.catch(() => {});
    await rm(this.tempPath, { force: true });
  }
}
