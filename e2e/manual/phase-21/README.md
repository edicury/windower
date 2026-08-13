# Phase 21 manual live-verification harness

Scripts used to run `specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md`
§"Live verification". They are **manual and TCC-gated** in exactly the sense
`e2e/README.md` describes — they drive the real screen and need real Screen
Recording / Accessibility grants. They are deliberately **not** wired into
`pnpm test`, `pnpm test:e2e`, or Turbo: they are plain `bash` scripts you run
by hand, kept here only so the next session does not have to rewrite them.

They hard-code this machine's primary display (`--target 5 --kind display`) and
this repo's path. Re-check both before running.

**No model, no API key, no Windower operator.** These scripts originally used
`windower operate` (an LLM-driven click/keystroke loop) to generate realistic
on-screen load during a recording. The Operator has been removed (Phase 24 —
see `CLAUDE.md`: "Windower never drives UI itself"). Load generation is now
plain synthetic input via `osascript`/System Events against TextEdit (or, for
the control-surface scripts, repeated `windower resize` calls against a
resolved window target) — the same technique `e2e/src/lib/demo-app.ts` uses
for synthetic clicks in the automated e2e suite. This also means none of
these scripts need a funded model API key anymore.

## Prerequisites

Same as `e2e/README.md`, plus:

1. `pnpm turbo run build` (the scripts call `node packages/cli/dist/index.js`).
2. No daemon pre-started for the core repro (it wants a cold start), and no
   recording in flight for the mutex checks (they are daemon-free by design).

Each script writes artifacts under a per-label directory and prints
`CHECK <name>: PASS|FAIL <detail>` lines, so a transcript can be read at a
glance.

## The scripts

| Script | Item it covers |
|---|---|
| `core-repro.sh <label> [duration]` | The core repro: `start_recording` → synthetic-input-driven activity → `stop_recording`. Run 3+ times. |
| `metrics.mjs <label>` | Post-processes one `core-repro.sh` run: wall-clock vs manifest `video.durationMs` vs an independent `ffprobe` read, plus event-source counts. |
| `stress-run.sh <label> [duration]` | Concurrent-load stress variant — a `list_targets` burst layered on a synthetic-input-driven recording, asserting exactly one capture process machine-wide. |
| `crash-control.sh <label>` | Crash injection — `kill -9 windower-control-macos` mid-recording, while a `windower resize` loop keeps it alive and a synthetic-input load generator drives general on-screen activity. |
| `crash-capture.sh <label>` | Crash injection — `kill -9 windower-capture-macos` mid-recording, with a synthetic-input load generator running. |
| `parity-and-lifecycle.sh <label>` | (a) recording driven by synthetic input, (b) recording idle with no driver at all, (c) independent lifecycle of a short control-surface (`windower resize`) burst against a recording that outlives it — plus a session-shape parity check across (a)/(b). |
| `parity-b.sh` | The model-free half of session-shape parity: a recording driven by plain human/agent-style desktop activity (`osascript`), with a programmatic key-set diff of the session record and manifest against `core-repro.sh`'s synthetic-input-driven runs. |
| `mutex-checks.sh` | ScreenCaptureKit exclusivity mutex — busy behavior (`SCREEN_CAPTURE_BUSY`) and stale-holder recovery after `kill -9` of the lock owner. Daemon-free by design; unaffected by the Operator's removal. |

`core-repro.sh`, `parity-b.sh` and `mutex-checks.sh` have been run to completion
on real hardware (against the pre-Phase-24 `windower operate`-driven versions
of these scripts); the rest are written and reviewed but **not yet run** with
the synthetic-input load generator — see `STATUS.md`'s Phase 21
live-verification section for exactly which items passed and which are
outstanding.

## Tracing

The load-bearing evidence for the replayd-conflict class is an OS-level trace
alongside a run:

```sh
/usr/bin/log stream --style compact \
  --predicate 'process == "replayd" OR process CONTAINS "windower"' > trace.txt
```

Then confirm **zero** hits for `didStopWithError`, and check that the transient
target-resolution capture sidecar and the recording's capture sidecar never
overlap (compare each pid's first/last line against the
`streamDidStartWithConfiguration` timestamp). Use `/usr/bin/log` explicitly —
a shell profile may shadow `log`.
