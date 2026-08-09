import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventTimelineSchema, type TimelineEvent } from "@windower/core";
import { describe, expect, it } from "vitest";
import { EventTimelineWriter } from "./event-timeline-writer.js";

const EVENTS: TimelineEvent[] = [
  { t: 0, type: "cursor_move", x: 1, y: 2, source: "user" },
  { t: 10, type: "mouse_down", x: 1, y: 2, button: "left", source: "user" },
  { t: 20, type: "mouse_up", x: 1, y: 2, button: "left", source: "user" },
  { t: 30, type: "key_down", key: "a", source: "user" },
];

describe("EventTimelineWriter", () => {
  it("appends events then finalizes into a schema-valid file", async () => {
    const sessionId = `writer-append-${Date.now()}`;
    const writer = new EventTimelineWriter(sessionId);
    for (const event of EVENTS) await writer.append(event);

    const finalPath = join(tmpdir(), `${sessionId}.events.json`);
    await writer.finalize(finalPath, { keystrokes: true });

    const raw = await readFile(finalPath, "utf8");
    const parsed = EventTimelineSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual({ sessionId, events: EVENTS, capabilities: { keystrokes: true } });
  });

  it("finalize with zero events still produces a valid empty-array file", async () => {
    const sessionId = `writer-empty-${Date.now()}`;
    const writer = new EventTimelineWriter(sessionId);

    const finalPath = join(tmpdir(), `${sessionId}.events.json`);
    await writer.finalize(finalPath, { keystrokes: false });

    const raw = await readFile(finalPath, "utf8");
    const parsed = EventTimelineSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual({ sessionId, events: [], capabilities: { keystrokes: false } });
  });

  it("discard removes the temp file without creating the final one", async () => {
    const sessionId = `writer-discard-${Date.now()}`;
    const writer = new EventTimelineWriter(sessionId);
    await writer.append(EVENTS[0]);

    const tempPath = join(tmpdir(), `windower-${sessionId}.events.jsonl`);
    await expect(stat(tempPath)).resolves.toBeTruthy();

    await writer.discard();

    await expect(stat(tempPath)).rejects.toThrow();
    const finalPath = join(tmpdir(), `${sessionId}.events.json`);
    await expect(stat(finalPath)).rejects.toThrow();
  });

  it("skips malformed lines in the temp NDJSON file rather than crashing", async () => {
    const sessionId = `writer-corrupt-${Date.now()}`;
    const writer = new EventTimelineWriter(sessionId);
    await writer.append(EVENTS[0]);
    // Simulate a crash mid-write leaving a truncated/corrupt trailing line.
    const tempPath = join(tmpdir(), `windower-${sessionId}.events.jsonl`);
    const fs = await import("node:fs/promises");
    await fs.appendFile(tempPath, '{"t": 40, "type": "cursor_move", "x":', "utf8");

    const finalPath = join(tmpdir(), `${sessionId}.events.json`);
    await writer.finalize(finalPath, { keystrokes: false });

    const raw = await readFile(finalPath, "utf8");
    const parsed = EventTimelineSchema.parse(JSON.parse(raw));
    expect(parsed.events).toEqual([EVENTS[0]]);
  });
});
