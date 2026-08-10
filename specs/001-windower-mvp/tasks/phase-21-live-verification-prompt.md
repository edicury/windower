# Phase 21 — Live Verification (resume prompt)

Paste the block below into a fresh session. Run it from a terminal that **actually holds the TCC grants** (Screen Recording, Accessibility, Microphone) and has a working `ANTHROPIC_API_KEY` exported.

---

Run Phase 21's live verification — the phase's final task. All code, tests, and docs are complete and green; this is the only thing between Phase 21 and done.

**Read first, in full:**

- `CLAUDE.md`
- `STATUS.md` — the Phase 21 entry under "Done" and the "Next session — start here" section
- `specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md` — especially §"Live verification", §"Exit criteria", and §"Explicitly out of scope for this phase"
- `specs/001-windower-mvp/contracts/screen-capture-exclusivity.md`
- `e2e/README.md` — the manual/TCC-gated conventions and prerequisites
- `specs/001-windower-mvp/bugs.spec.md` #6 — the full history, including which repros have and haven't reproduced

## What was built (do not re-derive it from the code, and do not relitigate it)

The architecture is settled and approved. The user's coding agent is the orchestrator; Windower exposes three **independent peer capabilities** — Capture, Operator, Control — and none owns or references another. The Operator is completely recording-unaware. There is **no capture broker**: cross-process ScreenCaptureKit exclusivity is a `~/.windower/capture.lock` file mutex with a bounded wait and a clean `SCREEN_CAPTURE_BUSY`, and a caller is **never** routed to the lock holder. Orphan prevention is process ownership (capture child exits on stdin EOF, finalizing output first) — no pid tracking, no reaper.

Current green baselines, so you can tell a regression from a pre-existing state:

`pnpm -r build` all 13 projects · `pnpm turbo run test` 19/19 · core 218 · engine 154 · daemon 22 · operator 101 · cli 215 · mcp-server 53 · Swift 235 (1 skipped, TCC-gated) · `native/macos/scripts/check-no-screencapturekit.sh` passing · repo-wide `grep -i broker` clean.

## Prerequisites

1. `pnpm turbo run build` and `fixtures/demo-app/package-app.sh` (per `e2e/README.md`).
2. Confirm grants with `windower doctor` — all three `granted`, and check the new `captureLock` section reports the lock free.
3. `ANTHROPIC_API_KEY` exported **in this shell**. A prior session lost days to an invalid key and to the daemon freezing a keyless environment; `doctor`'s API-key-presence row exists precisely to catch this — read it before starting.
4. No daemon pre-started (the core repro wants a cold start).

## The work

Run every item in the phase file's §"Live verification" checklist. The load-bearing ones:

- **Core repro, repeated at least 3 times.** Caller-driven: `start_recording` → `run_operator` → poll `get_operator_run` → `stop_recording`, Finder→Safari→waroom.co, `--max-steps 30`. Confirm `manifest.json`'s asset-derived `video.durationMs` is **≥95%** of real wall-clock span on **every** run. 3+ runs is not optional — this bug's history includes single lucky runs that did not generalize.
- **`log stream` tracing on at least one run**, confirming **zero** `replayd`-invalidation lines anywhere in the trace. This is the evidence that closes the replayd-conflict class; absence of errors is not the same thing.
- **Exactly one capture process machine-wide**, verified with `ps`, including under the concurrent-load stress variant (a synthetic burst of `list_targets` at faster-than-organic cadence layered on a real run).
- **Crash injection**, three separate cases: `kill -9` the control sidecar, the operator loop child, and the capture sidecar mid-run. In each, a concurrently-running recording must be **completely unaffected** and finalize normally when stopped; the operator run must surface a clear distinct error (`OPERATOR_LOOP_CRASHED` for the loop child) rather than hanging or silently truncating.
- **Mutex behavior**: stale-holder recovery (`kill -9` a lock-holding capture process, then immediately `list_targets` — the dead pid must be detected and stolen cleanly, not wedge every later call), and busy behavior (a second daemon-free capture call either succeeds after a bounded wait or returns `SCREEN_CAPTURE_BUSY`, **never** spawns a second SCK process, and is **never** routed into the holder).
- **Parity checks**: the identical `run_operator` call with **no recording at all** produces equivalent steps/plan/guardrail accounting/terminal state; and a `start_recording`/`stop_recording` around a human-driven interaction produces a session record and manifest indistinguishable in shape from the caller-driven case — nothing identifies what drove the screen.
- **Independent lifecycle**: delay `stop_recording` well past the run's terminal state; the recording must keep recording normally while `get_operator_run` alone reports the run ended, and the session record must show no trace of the operator.
- **Resource hygiene**: after all of the above, `ps aux` shows no surviving `windower-capture-macos` / `windower-control-macos` / operator-loop children, and `~/.windower/capture.lock` does not outlive its last legitimate holder.

Also worth watching, since this is the first real run of newly-split machinery: the operator's `plan`/`checkpoint` behavior (a nominal run should produce a revision-0 plan before any input tool, and checkpoints the model states rather than the runtime infers), and step-latency spot-checks against the pre-split baselines — the split should add isolation without adding latency.

## Reporting

- Record results in `STATUS.md` under a Phase 21 live-verification heading: per-run duration-preserved percentages, the `log stream` finding, and any failure verbatim.
- **Only if every criterion passes**, write `bugs.spec.md` #6's dated closing entry cross-referencing Phase 21. **Do not close #6 on the strength of unit tests, and do not close it on a single good run.** If results are mixed, say so plainly and leave it open.
- The residual **PTS-gap-stall** pattern (~13–19%, self-recovering, correlating with dynamic on-screen content rather than any RPC) is a **different, likely OS-level** mechanism and is **explicitly out of scope** for this phase. If you see it, record it against #6's residual-issue thread — do not treat it as a Phase 21 regression, and do not let it block the phase.
- If a criterion fails, diagnose before patching, and fix the contract before the implementation per `CLAUDE.md`. If a fix appears to require a new cross-capability reference, lifecycle owner, IPC surface, or persistent coordination object, **stop and report the conflict** rather than inventing the abstraction — the whole phase exists to remove exactly those.

Use subagents per `CLAUDE.md`'s execution process for anything decomposable, but note the live runs themselves are interactive and TCC-bound, so they are yours to drive directly.
