# Phase 21 — Live Verification (resume prompt)

Paste the block below into a fresh session. Run it from a terminal that **actually holds the TCC grants** (Screen Recording, Accessibility). No model or API key is needed — see the Phase 24 note below.

---

Run Phase 21's live verification — the phase's final task. All code, tests, and docs are complete and green; this is the only thing between Phase 21 and done.

**Phase 24 note, read this first:** the Operator (`windower operate`, `run_operator`, `packages/operator`) has been removed entirely (`tasks/phase-24-remove-operator.md`). The harness scripts referenced below (`e2e/manual/phase-21/*.sh`) have been rewritten accordingly: they drive on-screen load via plain synthetic input (`osascript`/System Events) instead of `windower operate`, and the "operator-without-recording parity" item has been dropped as moot. Nothing below requires `ANTHROPIC_API_KEY`.

**Read first, in full:**

- `CLAUDE.md`
- `STATUS.md` — the Phase 21 entry under "Done" and the "Next session — start here" section
- `specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md` — especially §"Live verification", §"Exit criteria", and §"Explicitly out of scope for this phase"
- `specs/001-windower-mvp/contracts/screen-capture-exclusivity.md`
- `e2e/README.md` and `e2e/manual/phase-21/README.md` — the manual/TCC-gated conventions, prerequisites, and the per-script rundown
- `specs/001-windower-mvp/bugs.spec.md` #6 — the full history, including which repros have and haven't reproduced

## What was built (do not re-derive it from the code, and do not relitigate it)

The architecture is settled and approved. The user's coding agent is the orchestrator; Windower exposes **independent peer capabilities** — Capture and Control — and none owns or references another. There is **no capture broker**: cross-process ScreenCaptureKit exclusivity is a `~/.windower/capture.lock` file mutex with a bounded wait and a clean `SCREEN_CAPTURE_BUSY`, and a caller is **never** routed to the lock holder. Orphan prevention is process ownership (capture child exits on stdin EOF, finalizing output first) — no pid tracking, no reaper.

Current green baselines, so you can tell a regression from a pre-existing state:

`pnpm -r build` all projects · `pnpm turbo run test` green · Swift 235 (1 skipped, TCC-gated) · `native/macos/scripts/check-no-screencapturekit.sh` passing · repo-wide `grep -i broker` clean. (The original baseline line here also listed a `packages/operator` test count and `cli` test counts that included operator commands — both are gone as of Phase 24; re-check current counts against whatever `pnpm turbo run test` reports now.)

## Prerequisites

1. `pnpm turbo run build` (per `e2e/README.md`).
2. Confirm grants with `windower doctor` — Screen Recording and Accessibility `granted`, and check the `captureLock` section reports the lock free.
3. No daemon pre-started (the core repro wants a cold start).

## The work

Run every item in `e2e/manual/phase-21/README.md`'s script table (which mirrors the phase file's §"Live verification" checklist, rewritten for the synthetic-input load generator). The load-bearing ones:

- **Core repro, repeated at least 3 times** (`core-repro.sh`). A recording driven by sustained synthetic-input activity, no daemon pre-started. Confirm `manifest.json`'s asset-derived `video.durationMs` is **≥95%** of real wall-clock span on **every** run (`metrics.mjs` computes this, cross-checked against an independent `ffprobe` read). 3+ runs is not optional — this bug's history includes single lucky runs that did not generalize.
- **`log stream` tracing on at least one run**, confirming **zero** `replayd`-invalidation lines anywhere in the trace (see `e2e/manual/phase-21/README.md`'s Tracing section for the exact command). This is the evidence that closes the replayd-conflict class; absence of errors is not the same thing.
- **Exactly one capture process machine-wide**, verified with `ps`, including under the concurrent-load stress variant (`stress-run.sh`: a synthetic burst of `list_targets` at faster-than-organic cadence layered on a real run).
- **Crash injection**, two separate cases: `kill -9` the control sidecar (`crash-control.sh`) and the capture sidecar (`crash-capture.sh`) mid-recording. In each, a concurrently-running recording must be **completely unaffected** (control case) or fail cleanly (capture case) and finalize/report normally.
- **Mutex behavior** (`mutex-checks.sh`): stale-holder recovery (`kill -9` a lock-holding capture process, then immediately `list_targets` — the dead pid must be detected and stolen cleanly, not wedge every later call), and busy behavior (a second daemon-free capture call either succeeds after a bounded wait or returns `SCREEN_CAPTURE_BUSY`, **never** spawns a second SCK process, and is **never** routed into the holder).
- **Parity checks** (`parity-and-lifecycle.sh`, `parity-b.sh`): a recording driven by synthetic input, a recording left idle, and a recording driven by ordinary human/agent desktop activity all produce a session record and manifest indistinguishable in shape from one another — nothing identifies what drove the screen.
- **Independent lifecycle: control vs. capture** (`parity-and-lifecycle.sh`): a short burst of control-surface activity (`windower resize`) that starts and finishes well before `stop_recording`; the recording must keep recording normally past the burst's end, and the session record must show no trace of the control activity.
- **Resource hygiene**: after all of the above, `ps aux` shows no surviving `windower-capture-macos` / `windower-control-macos` children, and `~/.windower/capture.lock` does not outlive its last legitimate holder.

Also worth watching, since this is the first real run of newly-split machinery: step/RPC-latency spot-checks against the pre-split baselines — the split should add isolation without adding latency. (The original version of this section also flagged the operator's `plan`/`checkpoint` behavior as worth watching; moot since Phase 24 removed the Operator.)

## Reporting

- Record results in `STATUS.md` under a Phase 21 live-verification heading: per-run duration-preserved percentages, the `log stream` finding, and any failure verbatim.
- **Only if every criterion passes**, write `bugs.spec.md` #6's dated closing entry cross-referencing Phase 21. **Do not close #6 on the strength of unit tests, and do not close it on a single good run.** If results are mixed, say so plainly and leave it open.
- The residual **PTS-gap-stall** pattern (~13–19%, self-recovering, correlating with dynamic on-screen content rather than any RPC) is a **different, likely OS-level** mechanism and is **explicitly out of scope** for this phase. If you see it, record it against #6's residual-issue thread — do not treat it as a Phase 21 regression, and do not let it block the phase.
- If a criterion fails, diagnose before patching, and fix the contract before the implementation per `CLAUDE.md`. If a fix appears to require a new cross-capability reference, lifecycle owner, IPC surface, or persistent coordination object, **stop and report the conflict** rather than inventing the abstraction — the whole phase exists to remove exactly those.

Use subagents per `CLAUDE.md`'s execution process for anything decomposable, but note the live runs themselves are interactive and TCC-bound, so they are yours to drive directly.
