# Phase 21 manual live-verification harness

Scripts used to run `specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md`
§"Live verification". They are **manual and TCC-gated** in exactly the sense
`e2e/README.md` describes — they drive the real screen, need real Screen
Recording / Accessibility / Microphone grants, and (most of them) need a funded
model API key. They are deliberately **not** wired into `pnpm test`,
`pnpm test:e2e`, or Turbo: they are plain `bash` scripts you run by hand, kept
here only so the next session does not have to rewrite them.

They hard-code this machine's primary display (`--target 5 --kind display`) and
this repo's path. Re-check both before running.

## Prerequisites

Same as `e2e/README.md`, plus:

1. `pnpm turbo run build` (the scripts call `node packages/cli/dist/index.js`).
2. A funded `ANTHROPIC_API_KEY` in the repo-root `.env` — every script sources it
   with `set -a; . ./.env; set +a`. Verify with one cheap real model call first;
   an empty balance surfaces only as a mid-run `OPERATOR_MODEL_ERROR` and wastes
   a full 4-minute run.
3. No daemon pre-started for the core repro (it wants a cold start), and no
   recording in flight for the mutex checks (they are daemon-free by design).

Each script writes artifacts under a per-label directory and prints
`CHECK <name>: PASS|FAIL <detail>` lines, so a transcript can be read at a
glance.

## The scripts

| Script | Item it covers | Needs a model? |
|---|---|---|
| `core-repro.sh <label>` | The core repro: `start_recording` → `operate --detach` → poll → `stop_recording`. Run 3+ times. | yes |
| `metrics.mjs <label>` | Post-processes one `core-repro.sh` run: wall-clock vs manifest `video.durationMs` vs an independent `ffprobe` read, plus steps/plan/checkpoint/event counts. | no |
| `stress-run.sh <label>` | Concurrent-load stress variant — a `list_targets` burst layered on a real run, asserting exactly one capture process machine-wide. | yes |
| `crash-control.sh <label>` | Crash injection — `kill -9 windower-control-macos` mid-run. | yes |
| `crash-loop-child.sh <label>` | Crash injection — `kill -9` the operator `loop-entry.js` child; expects `OPERATOR_LOOP_CRASHED` with the recording untouched. | yes |
| `crash-capture.sh <label>` | Crash injection — `kill -9 windower-capture-macos` mid-recording with a run in flight. | yes |
| `parity-and-lifecycle.sh <label>` | Operator-without-recording parity, recording-without-operator parity, and independent lifecycle. | yes |
| `parity-b.sh` | The model-free half of the above: recording-without-operator parity, with a programmatic key-set diff of the session record and manifest against the caller-driven runs. | no |
| `mutex-checks.sh` | ScreenCaptureKit exclusivity mutex — busy behavior (`SCREEN_CAPTURE_BUSY`) and stale-holder recovery after `kill -9` of the lock owner. | no |

`core-repro.sh`, `parity-b.sh` and `mutex-checks.sh` have been run to completion
on real hardware; the rest are written and reviewed but **not yet run** — see
`STATUS.md`'s Phase 21 live-verification section for exactly which items passed
and which are outstanding.

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
