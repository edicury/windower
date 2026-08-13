# Phase 21 — resume prompt

**Historical (Phase 21 is COMPLETE — see `tasks/phase-21-capture-control-broker.md`'s status banner).** Kept as a record of how the phase was originally kicked off. It predates Phase 24, which removed the Operator entirely (`windower operate`, `run_operator`, `packages/operator`, `performInput`, `enumerateElements`, `captureFrame`) — see `tasks/phase-24-remove-operator.md`. Everything below about the Operator, `run_operator`, or the operator decision-loop child process is dead; the capture/control process split and the ScreenCaptureKit exclusivity mutex it also describes are not, and stand as originally implemented. Do not paste this into a fresh session to redo Operator work.

Paste everything below the line into a fresh session at the repo root.

---

Implement Phase 21 of the Windower spec, using subagents for each task.

The architecture for this phase was settled across three product-owner corrections in a prior session and is **approved and final**. The spec and all contracts already reflect it. Do not relitigate it, and do not re-derive it from the code — the code is mid-migration and in several places still reflects superseded designs.

**Read first, in full, before writing any code:**

- `CLAUDE.md`
- `specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md` — the phase's task list and exit criteria. Note its "Reverted during Phase 21" and "YAGNI — what this phase must not turn into" sections; they are load-bearing.
- `specs/001-windower-mvp/contracts/screen-capture-exclusivity.md`
- `specs/001-windower-mvp/contracts/sidecar-protocol.md` — now defines two method-ownership surfaces
- `specs/001-windower-mvp/spec.md` §1.1–§1.2

## The governing architecture

**The user's coding agent is the orchestrator. Windower provides independent capabilities.**

```
             Coding Agent
             (orchestrator — Claude Code, Codex, script, human)
            /              \
           /                \
      Capture            Control
         |                   |
  windower-capture-macos          windower-control-macos
  (ScreenCaptureKit)              (CGEvent / AX — cannot link SCK)
         │
  ~/.windower/capture.lock  ← file mutex, macOS platform safety only
```

No capability owns or references another. Windower ships no code, type, or RPC that performs an implicit lifecycle-coupling sequence between capabilities on the caller's behalf — sequencing recipes live in `plugins/claude-code/SKILL.md`, not in a Windower workflow.

Invariants that must hold at the end:

1. **There is no Capture Broker.** No discovery, no routing, no IPC socket, no cross-process RPC, no broker lifecycle semantics. The `replayd`/ScreenCaptureKit conflict is a platform safety constraint, satisfied by the smallest possible mechanism: inside the daemon, it simply never starts a second capture process; across processes (Phase 20's daemon-optional execution), a `~/.windower/capture.lock` file mutex with a bounded wait and a clean `SCREEN_CAPTURE_BUSY` failure. **Never route a caller to the lock holder.**
2. **Orphan prevention is process ownership, not bookkeeping.** The capture sidecar is a child of the lock holder and exits on stdin EOF. No pid tracking, no reaper. The lock payload is exactly `{ pid, acquiredAt, windowerHome }`.

Apply YAGNI aggressively. The smallest architecture that makes the invalid state impossible wins.

## Work order

### 1. First task — EOF cleanup (`native/macos`)

Already verified in the prior session, do not re-investigate: `windower-capture-macos/main.swift:335-345` — the read loop terminates on EOF, `inFlightRequests.wait()` drains dispatched RPCs, and the process exits. **It exits on stdin EOF today ✅, but performs no capture cleanup on that path ❌** — nothing stops an active `SCStream` or finalizes the `AVAssetWriter`, so EOF mid-recording leaves an unfinalized video.

Implement EOF-triggered cleanup (stop the stream, finalize output, then exit); add an XCTest proving EOF causes cleanup + exit; add an e2e crash-injection test proving killing the parent leaves no capture child behind; do the same EOF-exit check and test for `windower-control-macos` (no capture state, so a plain exit).

### 2. Revert the superseded implementation

A prior session wrote code against designs that have since been rejected. All of this must go:

- **`packages/engine/src/broker-lock.ts` + `broker-lock.test.ts`** — heaviest item. Rename to `screen-capture-lock.ts`; `BrokerLock` → `CaptureLock`; `brokerLockPath()` → `captureLockPath()` (`broker.lock` → `capture.lock`); `CaptureBrokerBusyError` → `ScreenCaptureBusyError` with code `SCREEN_CAPTURE_BUSY`; interface `CaptureBroker` → `CaptureAccess`. **Delete** `serveBrokerSocket()`, `connectToBrokerSocket()`, `route()`, `forwardCaptureCall()`, `brokerSocketPathFor()`, `CAPTURE_SURFACE_METHODS`, `isTransportFailure()`, the `RoutedBroker`/`PublishedBrokerSocket` types, the `connectToBroker`/`publishBrokerSocket` options, `promoteTransientHold()` and all transient-vs-recording branching, and the payload fields `holderKind`/`brokerPid`/`brokerSocketPath`/`sessionId`. What survives: acquire, pid-liveness stale-steal, refcounted in-process sharing, bounded wait (5 ms backoff → 100 ms ceiling, 2000 ms budget), then `SCREEN_CAPTURE_BUSY`. `contracts/screen-capture-exclusivity.md` is the spec.
- `CAPTURE_BROKER_BUSY` → `SCREEN_CAPTURE_BUSY` in `DaemonErrorCodeSchema`.

(This section originally also listed reverting an Operator `sessionId`/attach-mode branch and an operator standalone-recording mode. Both are moot — Phase 24 removed the Operator entirely, see `tasks/phase-24-remove-operator.md`.)

### 3. Then continue the phase

Per the task file: daemon-side capture-lock wiring and in-process singleton, `ControlEngine` integration, and docs. (This section originally also listed operator-specific work — the operator loop child process and its daemon-side host, `run_operator`'s input shape, the `plan` tool and plan→execute→verify, safe action batching, CLI `windower operate` — all removed by Phase 24 along with the Operator.)

## Already done — do not redo or revert

- **`native/macos` capture/control split**: `WindowerSidecarShared` / `WindowerCaptureCore` / `WindowerControlCore` libraries, two executables, `swift build` + `swift test` green (231 tests), and `native/macos/scripts/check-no-screencapturekit.sh` enforcing via `otool -L` that the control binary cannot link ScreenCaptureKit even transitively. Wired into the package's `test` script.
- `packages/core/src/process/sidecar-path.ts`'s surface-aware resolver (`resolveSidecarBinaryPath(surface, ...)`, `WINDOWER_CONTROL_BINARY_PATH`), and both `packages/sidecar-macos-*` packages shipping both binaries.
- `packages/engine/src/control-engine.ts` (review it against the final contracts, but it was written to the surviving design).

(This section originally also listed frame sharing/`fresh` on `captureFrame`, operator plan/batching schemas, and `RecordingSession.operatorAttachedRunEnded`'s removal — all Operator-specific and moot since Phase 24, which removed `captureFrame` along with the rest of the Operator surface.)

## Constraints

- Follow `CLAUDE.md`'s execution process: decompose, dispatch subagents per task in parallel where independent, integrate.
- Never branch on `platform === "macos"` above the stdio line.
- Fix the contract before the implementation if you find something the protocol can't express.
- Live verification is TCC-gated and manual — it is the phase's final task, per `e2e/README.md` conventions.
- Update `STATUS.md` at the end of the session.

(This section originally also flagged a `windower operate`-focused `~/Documents/Development/windower-site` documentation pass as in scope. Moot — Phase 24 removed `windower operate` and updated the site's driving-the-UI story around computer-use/`claude-in-chrome` instead.)
