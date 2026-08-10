// Phase 21 live verification — per-run metrics.
// Usage: node metrics.mjs <runLabel>
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SCRATCH =
  "/private/tmp/claude-501/-Users-edicury-Documents-Development-windower/1e7cd64a-71fd-4a25-96ca-b53181c9776e/scratchpad";
const label = process.argv[2];
const dir = `${SCRATCH}/${label}`;

const stop = JSON.parse(readFileSync(`${dir}/stop.json`, "utf8"));
const session = JSON.parse(readFileSync(`${dir}/session.json`, "utf8"));
const run = existsSync(`${dir}/run-final.json`)
  ? JSON.parse(readFileSync(`${dir}/run-final.json`, "utf8"))
  : null;

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
const operatorEvents = evList.filter((e) => e.source === "operator");

console.log(
  JSON.stringify(
    {
      label,
      sessionId: session.id,
      runId: run?.id ?? null,
      runState: run?.state ?? null,
      runError: run?.error ?? null,
      steps: run?.steps?.length ?? null,
      planRevisions: run?.plan ? (run.plan.revision ?? "present") : null,
      checkpoints: (run?.steps ?? []).filter((s) => s.checkpoint !== undefined).length,
      wallClockMs: wallMs,
      manifestVideoMs: videoMs,
      ffprobeMs,
      preservedPct: Number(((videoMs / wallMs) * 100).toFixed(1)),
      totalEvents: evList.length,
      operatorEvents: operatorEvents.length,
      videoPath: stop.outputPath,
    },
    null,
    2,
  ),
);
