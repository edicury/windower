# Phase 21 — resume prompt

Paste everything below the line into a fresh session at the repo root.

---

Implement Phase 21 of the Windower spec, using subagents for each task.

The architecture for this phase was settled across three product-owner corrections in a prior session and is **approved and final**. The spec and all contracts already reflect it. Do not relitigate it, and do not re-derive it from the code — the code is mid-migration and in several places still reflects superseded designs.

**Read first, in full, before writing any code:**

- `CLAUDE.md`
- `specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md` — the phase's task list and exit criteria. Note its "Reverted during Phase 21" and "YAGNI — what this phase must not turn into" sections; they are load-bearing.
- `specs/001-windower-mvp/contracts/screen-capture-exclusivity.md`
- `specs/001-windower-mvp/contracts/sidecar-protocol.md` — now defines two method-ownership surfaces
- `specs/001-windower-mvp/contracts/operator.md` and `contracts/operator-loop-protocol.md`
- `specs/001-windower-mvp/spec.md` §1.1–§1.2

## The governing architecture

**The user's coding agent is the orchestrator. Windower provides independent capabilities.**

```
             Coding Agent
             (orchestrator — Claude Code, Codex, script, human)
            /      |       \
           /       |        \
      Capture   Operator   Control
         |          |
         |       Reasoning loop (isolated child process)
         |
  windower-capture-macos          windower-control-macos
  (ScreenCaptureKit)              (CGEvent / AX — cannot link SCK)
         │
  ~/.windower/capture.lock  ← file mutex, macOS platform safety only
```

No capability owns or references another. Windower ships no code, type, or RPC that performs the `start_recording → run_operator → wait → stop_recording` sequence — that is a recipe in `plugins/claude-code/SKILL.md`, not a Windower workflow.

Three invariants that must hold at the end:

1. **The Operator is completely recording-unaware.** `run_operator(target, task)` behaves identically whether the screen is being recorded or not. It never receives a session id, never starts/stops/looks up a recording, and never routes frames through a recording session. It observes via `captureFrame(target)`, never `captureFrame(recordingSession)`.
2. **There is no Capture Broker.** No discovery, no routing, no IPC socket, no cross-process RPC, no broker lifecycle semantics. The `replayd`/ScreenCaptureKit conflict is a platform safety constraint, satisfied by the smallest possible mechanism: inside the daemon, it simply never starts a second capture process; across processes (Phase 20's daemon-optional execution), a `~/.windower/capture.lock` file mutex with a bounded wait and a clean `SCREEN_CAPTURE_BUSY` failure. **Never route a caller to the lock holder.**
3. **Orphan prevention is process ownership, not bookkeeping.** The capture sidecar is a child of the lock holder and exits on stdin EOF. No pid tracking, no reaper. The lock payload is exactly `{ pid, acquiredAt, windowerHome }`.

Apply YAGNI aggressively. The smallest architecture that makes the invalid state impossible wins.

## Work order

### 1. First task — EOF cleanup (`native/macos`)

Already verified in the prior session, do not re-investigate: `windower-capture-macos/main.swift:335-345` — the read loop terminates on EOF, `inFlightRequests.wait()` drains dispatched RPCs, and the process exits. **It exits on stdin EOF today ✅, but performs no capture cleanup on that path ❌** — nothing stops an active `SCStream` or finalizes the `AVAssetWriter`, so EOF mid-recording leaves an unfinalized video.

Implement EOF-triggered cleanup (stop the stream, finalize output, then exit); add an XCTest proving EOF causes cleanup + exit; add an e2e crash-injection test proving killing the parent leaves no capture child behind; do the same EOF-exit check and test for `windower-control-macos` (no capture state, so a plain exit).

### 2. Revert the superseded implementation

A prior session wrote code against designs that have since been rejected. All of this must go:

- **`packages/engine/src/broker-lock.ts` + `broker-lock.test.ts`** — heaviest item. Rename to `screen-capture-lock.ts`; `BrokerLock` → `CaptureLock`; `brokerLockPath()` → `captureLockPath()` (`broker.lock` → `capture.lock`); `CaptureBrokerBusyError` → `ScreenCaptureBusyError` with code `SCREEN_CAPTURE_BUSY`; interface `CaptureBroker` → `CaptureAccess`. **Delete** `serveBrokerSocket()`, `connectToBrokerSocket()`, `route()`, `forwardCaptureCall()`, `brokerSocketPathFor()`, `CAPTURE_SURFACE_METHODS`, `isTransportFailure()`, the `RoutedBroker`/`PublishedBrokerSocket` types, the `connectToBroker`/`publishBrokerSocket` options, `promoteTransientHold()` and all transient-vs-recording branching, and the payload fields `holderKind`/`brokerPid`/`brokerSocketPath`/`sessionId`. What survives: acquire, pid-liveness stale-steal, refcounted in-process sharing, bounded wait (5 ms backoff → 100 ms ceiling, 2000 ms budget), then `SCREEN_CAPTURE_BUSY`. `contracts/screen-capture-exclusivity.md` is the spec.
- **Operator `sessionId` / attach mode**, everywhere: `packages/core/src/operator/types.ts`, `schemas/operator.ts`, `daemon/methods.ts` (the `sessionId` field, the `recording` option, `--no-record`, and the mutual-exclusivity `.refine()`), plus their tests. `OperatorRun.sessionId` → `OperatorRun.target`.
- **Operator standalone recording mode** in `packages/engine/src/operator-run-engine.ts` (and the `ownsSession` bookkeeping) and `packages/cli/src/commands/operate-blocking.ts`. This is a **breaking change to Phase 19's shipped `run_operator` surface** and is documented as such in the contracts.
- **`OutputManifest.operatorRunPath`** — a capture artifact pointing at the operator.
- `CAPTURE_BROKER_BUSY` → `SCREEN_CAPTURE_BUSY` in `DaemonErrorCodeSchema`.
- The operator loop child (`packages/operator/src/loop/*`, `loop-entry.ts`) was written against the attach-mode `ready` payload — it must take a target, never a session.

### 3. Then continue the phase

Per the task file: daemon-side capture-lock wiring and in-process singleton, `ControlEngine` integration, the operator loop child process and its daemon-side host, `run_operator`'s new `{ task, target, model, secrets?, guardrails? }` shape, the `plan` tool and plan→execute→verify, safe action batching, CLI `windower operate` with `start`'s target flags, MCP tool updates, `plugins/claude-code/SKILL.md`'s orchestration recipe, and docs.

## Already done — do not redo or revert

- **`native/macos` capture/control split**: `WindowerSidecarShared` / `WindowerCaptureCore` / `WindowerControlCore` libraries, two executables, `swift build` + `swift test` green (231 tests), and `native/macos/scripts/check-no-screencapturekit.sh` enforcing via `otool -L` that the control binary cannot link ScreenCaptureKit even transitively. Wired into the package's `test` script.
- Frame sharing from a live `SCStream` in `FrameCapture.swift` with the `fresh` opt-out, and the `fetchShareableContent()` short-TTL cache in `Enumeration.swift`. Both are internal to the capture binary and unobservable to callers.
- `packages/core/src/process/sidecar-path.ts`'s surface-aware resolver (`resolveSidecarBinaryPath(surface, ...)`, `WINDOWER_CONTROL_BINARY_PATH`), and both `packages/sidecar-macos-*` packages shipping both binaries.
- `packages/core`'s plan/batching schemas: `OperatorPlan`, `OperatorRun.plan`, `OperatorStep.plan`, `maxBatchActions` (default 8), `BATCH_ABORTED_RESULT`, `OPERATOR_BATCH_LIMIT_EXCEEDED`, `reportPlan`, and the `GuardrailState` additions.
- `packages/engine/src/control-engine.ts` (review it against the final contracts, but it was written to the surviving design).
- `RecordingSession.operatorAttachedRunEnded` — already fully removed.

## Constraints

- Follow `CLAUDE.md`'s execution process: decompose, dispatch subagents per task in parallel where independent, integrate.
- Never branch on `platform === "macos"` above the stdio line.
- Fix the contract before the implementation if you find something the protocol can't express.
- Live verification is TCC-gated and manual — it is the phase's final task, per `e2e/README.md` conventions.
- Update `STATUS.md` at the end of the session.
- **`~/Documents/Development/windower-site` is in scope and already audited** — the phase file's Docs section lists ~10 concrete, line-referenced breakages in `src/data.ts` (the `operate` usage string, the `--no-record` flag entry, both worked examples and both example outputs, the `--unbounded` and `operate abort` copy, the transcript location, and the "recording as it goes" blurb). Treat those as real tasks, not a "check whether anything changed" — the site currently documents the removed operator-records-itself behavior as a headline feature. Dispatch them as their own subagent task alongside the code work.
