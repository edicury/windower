// Phase 21 live verification — per-run metrics.
// Originally reported operator run/step/plan/checkpoint counts alongside
// recording duration; the Operator has been removed (CLAUDE.md — Windower
// never drives UI itself), so this now reports only recording-side metrics
// against core-repro.sh's synthetic-input-driven runs.
// Usage: node metrics.mjs <runLabel>
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SCRATCH =
  "/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad";
const label = process.argv[2];
const dir = `${SCRATCH}/${label}`;

const stop = JSON.parse(readFileSync(`${dir}/stop.json`, "utf8"));
const session = JSON.parse(readFileSync(`${dir}/session.json`, "utf8"));

const wallMs = Date.parse(session.stoppedAt) - Date.parse(session.startedAt);
const videoMs = stop.manifest.video.durationMs;

// Independent check: ffprobe the actual file, never trust the manifest alone.
let ffprobeMs = null;
try {
  const ffprobe = `${process.env.HOME}/Documents/Development/windower/e2e/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe`;
  const out = execFileSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", stop.outputPath],
    { encoding: "utf8" },
  );
  ffprobeMs = Math.round(Number.parseFloat(out.trim()) * 1000);
} catch (err) {
  ffprobeMs = `ffprobe failed: ${err.message}`;
}

const events = JSON.parse(readFileSync(stop.eventTimelinePath, "utf8"));
const evList = Array.isArray(events) ? events : (events.events ?? []);
const sourceCounts = {};
for (const e of evList) {
  const key = e.source ?? "(none)";
  sourceCounts[key] = (sourceCounts[key] ?? 0) + 1;
}

console.log(
  JSON.stringify(
    {
      label,
      sessionId: session.id,
      wallClockMs: wallMs,
      manifestVideoMs: videoMs,
      ffprobeMs,
      preservedPct: Number(((videoMs / wallMs) * 100).toFixed(1)),
      totalEvents: evList.length,
      eventSourceCounts: sourceCounts,
      videoPath: stop.outputPath,
    },
    null,
    2,
  ),
);
