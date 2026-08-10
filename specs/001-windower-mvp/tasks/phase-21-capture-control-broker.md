## Phase 21 — Capture/Control Process Split and ScreenCaptureKit Exclusivity (v1.4)

> **Status: COMPLETE (2026-08-10).** All code, test, doc, and contract tasks are done and green (`pnpm turbo run test` 19/19; Swift 235, 1 TCC-skipped; `check-no-screencapturekit.sh` passing; `grep -i broker` clean in code). The live-verification checklist below ran **6 of 12 items: 6 PASS, 0 FAIL, 6 not run.**
>
> **Passed, on real hardware with real TCC grants and a real model:** the core repro at **99.9% video-duration-preserved on all three runs** (304s / 211s / 273s, manifest and `ffprobe` agreeing to the millisecond, against historical baselines of 2.7%/59.5%/81.2%); `log stream` traces of **all three** runs showing **zero `didStopWithError`**, one clean stream start/stop pair each, and the exclusivity mutex visibly *serializing* the transient target-resolution capture sidecar against the recording's rather than letting them overlap; exactly one capture process machine-wide under organic load; busy-mutex `SCREEN_CAPTURE_BUSY` after a bounded wait with no second SCK process and no routing to the holder; stale-holder recovery with a clean steal on the next call and no surviving capture child (stdin-EOF ownership, no reaper); recording-without-operator parity with a byte-level-identical key set on the session record and manifest; and resource hygiene.
>
> **Not run — blocked on an exhausted model-provider balance, deliberately deferred by the product owner rather than switched to a different provider (which would break comparability with every prior `bugs.spec.md` #6 baseline):** the concurrent-load stress variant, the three crash-injection items, operator-without-recording parity, and independent lifecycle. Harness scripts for all six are written, reviewed, and checked in at `e2e/manual/phase-21/`.
>
> **Consequently `bugs.spec.md` #6 is NOT closed by this phase's completion.** Three clean runs show the replayd-conflict truncation class does not recur under nominal conditions; the crash-injection items — which prove a failure in one capability cannot silently truncate another's recording — are the other half of what #6 has always been about, and they have not been run. Close #6 only after they do. Full per-item results, including the pre-existing Phase 20 bug that had to be fixed first (`bugs.spec.md` #10), are in `STATUS.md` under "Live verification results (Phase 21, run this session)".
>
> Two open judgement calls recorded rather than silently resolved: this file is still named `…-broker.md`, which the "nothing named broker" exit criterion arguably catches (renaming breaks cross-references in `INDEX.md`, both prompt docs, and `STATUS.md`); and a control-sidecar crash surfaces as the generic `INTERNAL_ERROR` with a descriptive message rather than a distinct code, which the crash-injection item's "clear, distinct error" wording may or may not accept.

**Goal:** Split the single monolithic macOS sidecar into two structurally-separate native processes — a **capture sidecar** (`windower-capture-macos`) that is the only thing on the machine ever allowed to touch ScreenCaptureKit, and a **control sidecar** (`windower-control-macos`) that owns synthetic input and window control with zero relationship to ScreenCaptureKit — and move the operator's LLM decision loop into its own isolated process. Recording and "operating the screen" become fully independent, peer capabilities at every layer: protocol, process, and the capabilities Windower exposes. Neither knows the other exists except through one deliberate, opt-in optimization (frame sharing), which is an internal implementation detail of the capture sidecar, not a coupling between the two features.

**This phase adds no new architectural component.** It removes one (the monolithic sidecar), splits it in two, and adds a single low-level macOS safety mechanism: a file mutex that makes "two processes holding ScreenCaptureKit state at once" impossible. See the YAGNI section below for the explicit list of things this phase must not become.

### Context / why now

This phase is the direct, root-cause-informed follow-up to `bugs.spec.md` #6 — a multi-session investigation into `windower operate` recordings silently losing 3–97% of their footage with zero reported errors. The chain of findings that motivates this phase, in order:

1. **The proximate bug** (found and fixed this session): `packages/engine/src/passthrough.ts` spawned a brand-new, transient `windower-sidecar-macos` process for every `list_targets` call the operator made — including while a recording's own sidecar had a live `SCStream` running. OS-level `log stream` tracing caught the actual mechanism red-handed:
   ```
   windower-sidecar-macos[52257] +[SCShareableContent getShareableContentWithCompletionHandler:]
   replayd[...] invalidated because the client process (pid 52257) either cancelled the connection or exited
   replayd[...] -[RPClientProxy stream:didStopWithError:]
   ```
   A second process's `SCShareableContent` call — which itself succeeded normally — caused `replayd` (ScreenCaptureKit's system daemon) to kill the *other* process's unrelated, healthy live stream. The immediate fix (already shipped) made the operator reuse the recording's own sidecar process instead of spawning a second one, taking truncation from as low as 2.7%-preserved to 81–101%-preserved across repro runs.
2. **That fix is a workaround, not an architectural answer.** It works by accident of today's implementation (operator and recording happen to share one process already), not by design — nothing stops a future feature from reintroducing a second concurrent ScreenCaptureKit consumer, and the fix required operator and recording code to know intimate details about each other's sidecar lifetime. That mutual knowledge is exactly what this phase deletes.
3. **External research this session** (Apple docs, WWDC content, developer forums, and real-world issue trackers — OBS Studio, an unrelated `SCShareableContent`-hangs sample repo, and two independent Codex issues) found **no official Apple documentation** of a multi-process concurrency limit, but did find a consistent pattern of `replayd` being a shared, stateful, easily-destabilized system singleton across unrelated processes. This is a real, corroborated OS-level fragility, not a one-off fluke — and Apple gives no supported way to avoid it other than not contending for it in the first place.
4. **A residual, separate, milder issue remains uncharacterized**: even after the fix, ~13–19% of a run's footage can still be lost to short, self-recovering PTS-gap stalls that correlate with real dynamic on-screen content (not with any specific RPC) — i.e. plain `SCStream`/compositor backpressure, a different and likely OS-level-only-fixable problem, explicitly out of scope for this phase (see below).
5. **A precise map of which native calls actually touch ScreenCaptureKit** (produced this session, file:line cited): `performInput` (`InputSynthesis.swift`, `CGEventPost`/`CGEventSource`) and `resizeWindow` (`WindowControl.swift`, `AXUIElement*` + `CGWindowListCopyWindowInfo`) have **zero** ScreenCaptureKit dependency and are safe to run anywhere, in any process, concurrently with anything. `enumerateTargets` (`Enumeration.swift`) and `captureFrame` (`FrameCapture.swift`) both call `SCShareableContent.getWithCompletionHandler` — `captureFrame` does so as an implementation artifact (it re-resolves the target from scratch on every call instead of reusing an already-resolved filter or an already-live stream's frames), not because the operation fundamentally requires it.
6. **The product owner's own instinct, independently arrived at**: recording and "operating the screen" are different concerns and should be orchestrated as peers by the calling agent (e.g. Claude Code), not have one own the other's lifecycle. This phase is that instinct, built out to the OS-process level it turns out the evidence actually supports — and, per the correction recorded below, taken to its full conclusion: the Operator does not merely avoid *owning* a recording, it is entirely **unaware** that recording exists.

### Reasoning — the governing principle

Every bug this investigation chased reduces to one violated invariant: **more than one OS process was, at some point, allowed to hold ScreenCaptureKit state at the same time.** The fix so far has been a special case of a general rule. This phase makes the general rule the architecture, instead of an emergent property of which sidecar happens to be reused today:

> **Exactly one process on the machine may ever hold live `SCShareableContent`/`SCStream`/`SCScreenshotManager` state at a time.** Windower must not allow multiple independent processes to concurrently establish conflicting ScreenCaptureKit ownership.

That is the entire invariant. It is a **platform safety constraint**, not a reason to invent an orchestration component. The smallest mechanism that makes the invalid state impossible is what this phase builds: inside the daemon, ordinary in-process bookkeeping (there is one capture sidecar, so nothing ever starts a second one); across processes, a global file mutex. A caller that finds ScreenCaptureKit busy **waits with a bounded timeout or fails cleanly** — it is never routed to whoever holds the mutex, and there is no discovery, no routing, and no cross-process RPC to make that possible.

This generalizes past today's specific operator/recording conflict to any future feature that wants to look at the screen (a thumbnail previewer, a second concurrent recording, a different agent framework entirely) — the invariant holds by construction rather than by remembering to route through the right existing sidecar instance each time.

A second, independent principle falls out of the capability map in point 5 above: **input and window control have no OS-level reason to ever be coupled to capture.** Splitting them into their own process isn't just safe, it's free — there is no shared resource to arbitrate, so there is no reason not to.

A third principle, extending the same "isolate what can fail" logic CLAUDE.md already applies to capture sessions ("A capture crash is isolated to its session"), to the operator: the LLM decision loop is a different failure domain from anything native (a wedged synchronous call, a native-crash-inducing dependency pulled in transitively by a model provider SDK, unbounded memory growth from a very long transcript) and should not be able to take the daemon, or an in-progress recording, down with it.

A fourth principle, and the one that governs everything above the stdio line: **Windower provides independent capabilities; the user's coding agent is the orchestrator.** Claude Code, Codex, a shell script, a CI job, or a human at a terminal owns the workflow. Windower does not model that workflow internally — it exposes excellent primitives the calling agent composes:

```
             Coding Agent
             (orchestrator)
            /      |       \
           /       |        \
      Capture   Operator   Control
         |          |
         |       Reasoning
         |
    native capture
```

The intended flow, in full — this lives in `plugins/claude-code/SKILL.md` as a **recipe for the calling agent**, not in Windower's domain model:

```
Coding agent:
  recording = start_recording(target)
  operator  = run_operator(target, task)
  wait for operator terminal state
  stop_recording(recording)
```

Recording does not know about Operator. Operator does not know about Recording. The calling agent owns sequencing: start recording → start operator run → wait for the run to reach a terminal state → optionally allow a short settle period → stop recording → render/continue the pipeline. Windower ships no code that performs that sequence on the caller's behalf.

**The Operator receives exactly four things: the task, the target, model/provider configuration, and guardrails/planning configuration.** It operates that target and emits its own events and results. The Operator **must not**: know whether a recording exists; start a recording; stop a recording; look up a recording; route frames through a recording session; or carry a recording/session identifier for timeline correlation. **The same `OperatorRun` must behave identically whether the screen is being recorded or not.**

Settled decision, recorded here so it isn't rediscovered: **do NOT introduce a first-class `RecordingAgent` concept** — or any Windower-level `DemoRun`/`WorkflowRun` orchestration abstraction. Claude Code may well use a subagent to manage recording lifecycle for concurrency or isolation; that is a **Claude Code implementation detail, explicitly not Windower architecture**. Windower exposes recording as a *deterministic capability/session*, never as an intelligent agent. Other agents must be free to orchestrate the same primitives differently, and the architecture must remain equally valid for orchestrators that are not Claude Code. Do not duplicate orchestration capabilities the calling agent already provides.

Together, these four principles produce a topology of independent capabilities instead of one monolithic sidecar, described below.

### Settled decision — the Operator is recording-unaware (breaking change to Phase 19)

This supersedes any earlier draft of this phase, and any shipped Phase 19 surface that conflicts with it.

- **There is no operator "attach mode."** The concept is *deleted*, not renamed. `sessionId` is removed from `run_operator`'s input, from `OperatorRun`, from the CLI's operator flags, and from every semantic that depended on it.
- **The "standalone convenience mode" — in which the operator started and owned its own recording — is also removed.** It directly violates "the Operator must not start a recording." There is no operator-owned recording of any kind, convenience or otherwise.
- **This is a breaking change to Phase 19's shipped `run_operator` surface**, and it is accepted deliberately. Rationale: keeping either mode preserves a dependency edge from Operator onto Capture. Once that edge exists in any form — even as a documented fallback — every future contributor has a sanctioned path to reintroduce the coupling the whole phase exists to remove, and the "same run behaves identically with or without a recording" invariant becomes untestable. A one-time break of a pre-1.0 surface is cheaper than a permanent structural exception. The MVP is pre-1.0 and `run_operator` is new in Phase 19; there is no long-lived caller base to migrate.
- Timeline correlation is **the calling agent's job, not either peer's** — see the next section.

### Timeline correlation belongs to the caller

- The Operator MAY emit structured events: `plan`, `action`, `checkpoint`, `narration`, `result`.
- Capture MAY emit its own events: cursor, mouse, keyboard, window/capture events.
- If an active recording and an `OperatorRun` happen to concern the same demo the calling agent is driving, the daemon MAY correlate those two streams and persist the result into the resulting demo timeline — as a convenience over two handles it already holds, not as a workflow it owns.
- **That correlation must not require either capability to reference the other.** No `OperatorRun.sessionId`, no `RecordingSession.operator*` field, no shared identifier threaded through either surface. Correlation is done by the layer that already holds both handles, because the caller handed it both.
- For Phase 21: **prefer ephemeral, in-memory correlation.** Do **not** introduce a persistent `DemoRun`/`WorkflowRun` model unless a current requirement demands persistence. Theoretical future extensibility is not such a requirement; the simplest design that preserves separation wins.

### Architecture — the capability boundaries

These are **conceptual ownership boundaries**, not a mandate to create N packages, N processes, or N binaries. They describe who is allowed to own what. Some already map onto a process boundary for the OS-level reasons above (capture vs. control); others do not and should not. **Do not add abstractions or processes purely to make this diagram literal.**

- **Capture** — target enumeration, screenshots/frames, recording, the event timeline. The only capability permitted to hold ScreenCaptureKit state on macOS.
- **Control** — mouse, keyboard, window activation and control, resize/focus. Zero ScreenCaptureKit dependency on macOS, enforced by the dependency graph.
- **Operator (reasoning)** — task planning, observation interpretation, action selection, verification and replanning. Never directly spawns native processes and never touches platform capture/control APIs; every screen-facing effect is a request routed through the daemon boundary. Knows nothing about recording.
- **Orchestration is not a Windower capability.** Lifecycle and sequencing across the three above — start a recording, run an operator, wait, stop the recording, then narrate/render/verify — belongs to the calling coding agent. Windower's only concession to it is the optional in-memory event correlation described above. There is no Windower orchestration layer, engine, or domain object, and none should be added.

### Preserved, unchanged by these refinements

The planning/batching refinements in this document do **not** alter any of the following, all of which stand exactly as originally specified and remain correct:

- Exactly one ScreenCaptureKit-owning capture sidecar process per machine.
- The capture/control binary separation on macOS — a separate control binary with **no** ScreenCaptureKit dependency.
- The system-wide ScreenCaptureKit exclusivity mutex (simplified in scope — see Daemon below — but not removed).
- Operator decision-loop process isolation from the daemon and from all native processes.
- Frame sharing served from an already-live `SCStream`.
- Crash isolation: an operator crash never affects a recording, and a recording's problems never wedge an operator run.
- Windows/Linux remaining free to use a different native process topology.

### YAGNI — what this phase must not turn into

Phase 21 originated from a real bug: multiple processes touching ScreenCaptureKit could destabilize an active recording. **Fix that root cause and stop.** Keep the architecture boring. The following are explicitly forbidden in this phase, and a future reader should treat their reappearance as scope creep to be reverted, not as progress:

- 🔵 **No capture broker.** Windower does not gain a "Capture Broker" component, domain concept, or vocabulary. There is a capture *sidecar process* and a *mutex*. Do not reintroduce the name; naming this thing a broker is what invites everything below.
- 🔵 **No routing layer.** Never route a capture call to whoever holds the mutex. Busy means wait-with-timeout or fail cleanly, full stop.
- 🔵 **No broker discovery, no broker IPC socket, no cross-process capture RPC**, no "clients locate an existing capture process," no broker lifecycle semantics.
- 🔵 **No distributed anything.** The mutex is a file. Its entire contract is "who currently owns ScreenCaptureKit, and is that pid still alive."
- 🔵 **No workflow engine and no Windower-level orchestration abstraction** — no `DemoRun`, `WorkflowRun`, `RecordingAgent`, or similar. The calling coding agent orchestrates.
- 🔵 **No recording/operator lifecycle coupling** in either direction, including "helpful" convenience paths.
- 🔵 **No speculative concurrency infrastructure** — no queues, schedulers, priority arbitration, or multi-tenant capture plumbing for scenarios no current requirement demands.

The smallest architecture that makes the invalid state impossible is preferable to a more general one.

### Reverted during Phase 21

Earlier in-phase work and earlier drafts of this document specified things that are now invalid. Implementation agents must treat these as **removed**, not as pending work:

- **Operator `sessionId` / attach mode** — deleted from `run_operator` input, `OperatorRunOptions`, `OperatorRun`, CLI flags, MCP tool schema, `contracts/operator.md`, `contracts/mcp-tools.md`, and all prose. Any partially-landed attach-mode branch in `operator-run-engine.ts` (including `ownsSession` bookkeeping) is removed, not fixed.
- **Operator standalone recording mode** — the operator no longer starts, owns, or finalizes a recording under any circumstance. The recording flags on `windower operate` go away with it.
- **`RecordingSession.operatorAttachedRunEnded`** — already settled as rejected; confirm it is gone from `packages/core/src/schemas/session.ts` and from every writer/reader.
- **The capture-broker abstraction itself** — earlier drafts of this phase introduced a "capture broker" as a new architectural/domain component. It is deleted. There is a **capture sidecar process** (`windower-capture-macos`) and a **ScreenCaptureKit exclusivity file mutex**; nothing else. The word "broker" must not name a component in this phase's code, docs, contracts, or identifiers.
- **Broker discovery, broker routing, and the broker IPC socket** — a previous draft had daemon-free callers discover and route capture calls into another process's capture session over a socket. All of it is deleted from this phase. See the Daemon section for the correct, much smaller behavior.
- **The `CAPTURE_BROKER_BUSY` error code** — renamed to `SCREEN_CAPTURE_BUSY`. `contracts/broker-lock.md` is likewise deleted and replaced by `contracts/screen-capture-exclusivity.md`.
- **Any Windower-level orchestration abstraction** — `DemoRun`, `WorkflowRun`, `RecordingAgent`, or an "orchestration engine/plane" owned by Windower. The calling coding agent orchestrates; see the YAGNI section.

### Explicitly settled (do not relitigate during implementation)

- The single-writer ScreenCaptureKit invariant is enforced by construction (separate binaries that cannot link the other's SCK-touching sources — see native/macos below) and by a system-wide file mutex (see Daemon below), not by convention or code review.
- `performInput`/`resizeWindow` move to a separate binary with **no** ScreenCaptureKit linkage, full stop — this is a hard target, not an aspiration, since the capability map already proves it's achievable with zero API changes.
- The operator's decision loop becomes a genuinely separate OS process from the daemon. It communicates with the daemon over the same JSON-RPC-over-stdio framing the native sidecar already uses (consistency with an existing, well-understood pattern beats inventing a second IPC shape), and it **never** opens its own `SidecarClient` or spawns any native process directly — every screen-facing action is proxied through the daemon to the capture sidecar or the control sidecar. Getting this wrong (letting the operator process touch ScreenCaptureKit itself) would silently reintroduce the exact hazard this phase exists to eliminate.
- **The Operator is recording-unaware, and the previous `run_operator` recording surface is removed** — see the settled-decision section above. Do not reintroduce either mode as an option, a flag, or a "documented fallback."
- **`RecordingSession` carries no operator-derived field of any kind.** The invariant: a `RecordingSession` must not know whether it is recording a human, Windower Operator, Claude Code, Playwright, another agent, or nothing at all. Orphan visibility for "an outer agent started a run and then forgot to `stop_recording`" is served by the calling agent polling `get_operator_run` — it already holds both handles, since it created both. Ephemeral correlation bookkeeping may live in daemon memory; it must not be persisted onto the session record, and no persistent `DemoRun`/`WorkflowRun` concept is introduced in this phase.
- The residual PTS-gap-stall issue (point 4 above) is a different, likely-OS-level-only problem and is explicitly **not** this phase's job to fix — this phase's exit criteria are about eliminating the *replayd-conflict* class of truncation entirely, not the milder compositor-backpressure class.
- No Windows/Linux capture/control process split in this phase — this is macOS-only, matching every other phase's platform scoping; the protocol split must not assume a single platform going forward (see Protocol below), so Phases 16/17 aren't blocked or contradicted later.

### Protocol (first — per `CLAUDE.md`, fix the contract before implementing)

- 🔵 Restructure `contracts/sidecar-protocol.md` to document **two method-ownership groups** instead of one flat method table: a **capture surface** (`describe`, `enumerateTargets`, `startCapture`, `stopCapture`, `cancelCapture`, `captureFrame`) and a **control surface** (`describe`, `performInput`, `resizeWindow`). Each surface is implemented by its own binary; a client may hold connections to both simultaneously for one logical session. No existing method's params/result shape changes — this is a re-grouping of an already-frozen protocol, not a breaking change. Capability strings (`input.mouse`, `input.keyboard`, `screenshot`, `capture.display`, etc.) already work per-binary via `describe` with zero new fields needed — the protocol never assumed one binary implements everything, it just happened to be true until now.
- 🔵 Document the **frame-sharing optimization** as an explicit, opt-in protocol note on `captureFrame`: when the capture sidecar has a live `SCStream` covering the requested target, it MAY serve the most recently delivered frame instead of invoking a fresh `SCScreenshotManager` capture. This is observable only as (a) potentially lower latency and (b) frame staleness bounded by the stream's own frame interval — callers that need a guaranteed-fresh frame (rare; not needed by the operator's use case) pass a new `fresh: boolean` param (default `false`) that forces a real `SCScreenshotManager` call regardless of an active stream. Add this param to `captureFrame`'s params in `contracts/sidecar-protocol.md` and `data-model.md`. Note explicitly in the doc that this optimization is invisible to the caller's semantics — a `captureFrame` client cannot tell whether a recording is in progress, and must not be able to.
- 🔵 **Frame access is addressed by target, never by recording.** The operator (and every other client) asks for `capture_frame(target)` — never `capture_frame(recordingSession)`. Whether Windower serves that frame from an already-live capture source or from a one-shot capture is an internal implementation detail the caller cannot observe and must never depend on. State plainly in `contracts/sidecar-protocol.md` and `contracts/operator.md` that the frame-sharing optimization **must not create a Recording→Operator or Operator→Recording dependency in either direction**: no recording handle in the frame request, no operator identity in the capture path, no schema field on either side that exists only because the other might be running.
- 🔵 **Remove `sessionId` from `run_operator`'s input** in `contracts/mcp-tools.md` and `contracts/operator.md`, and remove `sessionId` from `OperatorRun` in `contracts/operator.md` and `data-model.md`. Remove all attach-mode and standalone-recording prose. `run_operator`'s input becomes exactly: **task, target, model/provider configuration, guardrails/planning configuration.** Document the breaking change and its rationale inline where the tool is specified, so callers reading only the contract understand why the recording options vanished.
- 🔵 Document in `contracts/operator.md` the structured event kinds an `OperatorRun` MAY emit — `plan`, `action`, `checkpoint`, `narration`, `result` — as the operator's *own* output stream, carrying no recording/session identifier. State that correlating these with capture events is the calling agent's job (or, at most, an in-memory convenience in the daemon) and is out of the operator contract's scope.
- 🔵 New `contracts/screen-capture-exclusivity.md` (replacing the deleted `contracts/broker-lock.md`; alternatively a section in `contracts/daemon-rpc.md`): documents the system-wide single-writer invariant for ScreenCaptureKit-touching processes as a **low-level macOS safety mechanism**, not an abstraction. Scope it precisely to what it actually exists for — **the cross-process invariant created by daemon-optional operation (Phase 20)**. Specify: the mutex path (`~/.windower/capture.lock`); what holds it; that a daemon-free caller waits with a bounded timeout or receives `SCREEN_CAPTURE_BUSY`; and stale-mutex detection/steal via pid liveness, mirroring `FileLock`'s existing pattern. Explicitly document that the mutex defines **no** discovery, routing, or IPC mechanism between processes, and that no caller is ever routed to the holder.
- 🔵 Add a new operator-loop-to-daemon IPC contract doc, `contracts/operator-loop-protocol.md`: the JSON-RPC-over-stdio method surface the daemon exposes to the now-separate operator decision-loop process (proxied `captureFrame`/`performInput`/`enumerateTargets`/`resizeWindow`, plus lifecycle methods for guardrail state, abort signaling, and step/transcript/event reporting back to the daemon). This is new protocol surface, not a re-grouping — write it with the same rigor as `sidecar-protocol.md` (method table, error taxonomy, capability-free since both ends are always this codebase's own binaries). The surface must contain **no** recording-related method, param, or identifier.
- 🔵 Update `research.md` §2's per-method feasibility matrix: note that the capture/control split and the single-writer mutex are macOS-specific implementation details of this phase, not new protocol methods — Windows/Linux backends (Phases 16/17) are free to implement the existing protocol with one process, two processes, or any topology that satisfies the same method contracts; nothing in the protocol requires two binaries.

### Native macOS (`native/macos`)

**First implementation task — process ownership / EOF cleanup.** Settled: orphan prevention is process ownership, not pid tracking. See `contracts/screen-capture-exclusivity.md` §Process ownership.

> **Verification finding, already performed — do not re-investigate.** `native/macos/Sources/windower-capture-macos/main.swift:335-345`: the `while let line = readLine(...)` loop terminates on EOF, `inFlightRequests.wait()` drains dispatched RPCs, and the process falls off the end of `main.swift` and exits. **Exits on stdin EOF today ✅. Performs no capture cleanup on that path ❌** — nothing stops an active `SCStream` or finalizes the `AVAssetWriter`, so EOF mid-recording exits without finalizing the video file.

- 🔵 Implement EOF-triggered cleanup in `windower-capture-macos`: on EOF, stop any active `SCStream`, finalize the `AVAssetWriter`/output, then exit. No pid tracking and no reaper — the parent's death closes the pipe, and this path does the rest.
- 🔵 Add an XCTest proving EOF causes capture cleanup and process exit (active capture → close stdin → output finalized, process exits).
- 🔵 Add a crash-injection test proving that killing the parent process leaves no `windower-capture-macos` child behind (verify with `ps`). This needs a real capture and is e2e/TCC-gated — place it per the repo's e2e conventions, see `e2e/README.md`.
- 🔵 Same EOF-exit check and test for `windower-control-macos` — simpler, no capture state to clean up, so the EOF path is a plain exit.

- 🔵 Restructure `Package.swift` into three targets: `WindowerCaptureCore` (library: `Enumeration.swift`, `FrameCapture.swift`, `CaptureService.swift`, `VideoAssetWriter.swift`, and anything else that imports `ScreenCaptureKit`), `WindowerControlCore` (library: `InputSynthesis.swift`, `WindowControl.swift` — confirmed zero SCK imports already, verified this session), and two executables: `windower-capture-macos` (depends only on `WindowerCaptureCore`) and `windower-control-macos` (depends only on `WindowerControlCore`). The split must be enforced by the dependency graph, not by convention — `windower-control-macos` should not even be able to `import ScreenCaptureKit` transitively; verify this by grepping the built binary's linked frameworks (`otool -L`) as part of this task's own acceptance check.
- 🔵 Each binary gets its own `main.swift` with its own `readLine()`-based JSON-RPC dispatch loop (reuse the existing concurrent-dispatch-queue structure from this session's bug-#6 fix — a stalled request must not block either binary's ability to service other requests), dispatching only the methods in its surface per the protocol restructure above.
- 🔵 `FrameCapture.swift`'s `captureFrame` implementation gains the frame-sharing optimization: when `CaptureSessionManager` has an active `SCStream` whose target overlaps the requested one and `fresh !== true`, serve the most recently delivered `CMSampleBuffer` (converted to the same PNG/JPEG+downscale pipeline `captureFrame` already uses) instead of calling `fetchShareableContent()` + `SCScreenshotManager.captureImage` again. This removes `captureFrame`'s per-call `SCShareableContent` dependency in the common (recording-active) case entirely — the single biggest reduction in SCK call frequency, since operator calls this every step. This is an optimization internal to `windower-capture-macos`: the caller passes a target, never a recording handle, and learns nothing about whether a stream exists.
- 🔵 `Enumeration.swift`'s `fetchShareableContent()` gains a short-TTL cache (a few hundred ms, tunable) inside `windower-capture-macos` so back-to-back `enumerateTargets` calls (e.g. `list_targets` immediately followed by a resolve-target-for-capture call) don't each trigger an independent `SCShareableContent` round-trip.
- 🔵 Update `fixtures/demo-app` and `e2e/` test harnesses to spawn both binaries where a test needs both capture and control (most existing e2e tests only need one or the other — audit and split accordingly).

### Daemon (`apps/daemon`, `packages/engine`)

- 🔵 **Inside the daemon: no mechanism at all beyond ordinary bookkeeping.** The daemon owns exactly one capture sidecar process, and all capture calls (`enumerateTargets`, `captureFrame`, recording start/stop, operator-proxied frames — everything) go to it **in-process**. It simply never starts a second capture process. No mutex round-trip, no socket, no discovery, no arbitration: it is one object the daemon already holds a reference to.
- 🔵 **ScreenCaptureKit exclusivity mutex — the whole of the cross-process mechanism.** Its *only* purpose is enforcing the ScreenCaptureKit single-writer invariant across processes, which exists solely because of daemon-optional operation (Phase 20). It is not a router, not service discovery, and not an IPC channel. Implement `packages/engine/src/screen-capture-lock.ts` modeled on the existing `FileLock`/`TargetLock` pattern (`~/.windower/capture.lock`, `O_EXCL` acquire, pid-liveness stale-steal, unlink release), scoped to the whole ScreenCaptureKit resource rather than a per-target key. Treat it as a low-level macOS safety primitive; do not build a domain concept on top of it.
- 🔵 **A daemon-free command needing capture**: attempt to acquire the mutex. If acquired, spawn/use a transient capture sidecar under it, exactly as `PassthroughService` does today. If it is held by a **live** process, wait with a bounded timeout or return a clear `SCREEN_CAPTURE_BUSY` error. Stale mutexes (holder pid no longer alive) may be stolen after pid-liveness validation.
- 🔵 **Never route to the holder — not now, not later.** Do not route daemon-free callers into another process's capture sidecar, and do not build discovery, routing, or an IPC socket for it. "Wait with a bounded timeout, or fail cleanly" is the complete and correct behavior. Reconsider only if a concrete user requirement proves concurrent daemon-free capture clients must interoperate — and treat that as a new phase, not a Phase 21 extension.
- 🔵 `RecordingEngine`'s `startCapture` path uses the daemon's one capture sidecar for the duration of a recording; every other capture-surface call arriving while a recording is active — from the operator loop, from `list_targets`, from anywhere — resolves to that same in-process object. This generalizes the bug-#6 fix's `createDeps()` comment (already written this session) from "operator specifically reuses the recording's sidecar" to "there is only ever one capture process inside the daemon, unconditionally."
- 🔵 New `ControlEngine` (parallel to `RecordingEngine`, much simpler — no session/manifest/lifecycle state, just a thin owner of the one long-lived-or-on-demand `windower-control-macos` process and its client) used by both direct `performInput`/`resizeWindow` calls and the operator.
- 🔵 Operator decision-loop-as-separate-process: extract `packages/operator`'s `run.ts` loop into a new entry point (`packages/operator/src/loop-entry.ts` or a new `packages/operator-loop` package, TBD during implementation — decide based on whether `packages/operator` should keep shared types/schemas importable by both the daemon and the child process, or whether a clean split needs two packages) that the daemon spawns as a child process per operator run, communicating over the new `contracts/operator-loop-protocol.md` surface. The daemon-side `OperatorDeps` implementation for this child process proxies every call to the daemon's capture sidecar or `ControlEngine` — the child process never constructs a `SidecarClient` and never spawns a native process itself. Guardrail enforcement (`maxSteps`, `timeoutMs`, bounds clamp) can live on either side of the boundary; recommend keeping it daemon-side (the child process is untrusted from the daemon's perspective in the same way a model's own output already is) so a compromised or buggy loop process can't bypass its own guardrails.
- 🔵 Crash handling: if the operator loop child process dies unexpectedly, the daemon marks the `OperatorRun` `failed` with a distinct error code (`OPERATOR_LOOP_CRASHED` or similar, new to the error taxonomy) and — critically, this is the whole point — **does not touch any recording session, ever.** There is no branch here: the operator never owns a recording, so there is nothing to finalize on its behalf.
- 🔵 Remove the attach-mode branch and any `ownsSession`-style bookkeeping from `operator-run-engine.ts` (or its successor after the loop-process extraction). An operator run has no session handle to reason about, so `finalize()` has no recording responsibility at all.
- 🔵 **Enforce the no-cross-reference invariant in both directions**: audit `apps/daemon`/`packages/engine` for any place that writes operator-derived state onto a session record *or* threads a recording identifier into an operator run, and remove both. Any transient "run X and session Y belong to the same demo the caller is driving" bookkeeping the daemon needs for event correlation stays in memory and is never persisted to `~/.windower/sessions/<id>.json` or onto the run record.
- 🔵 Event correlation (optional, in-memory): where the daemon happens to hold both a live `CaptureSession` and a live `OperatorRun` for the same demo the caller is driving, it MAY merge the operator's `plan`/`action`/`checkpoint`/`narration`/`result` events with capture's cursor/mouse/keyboard/window events into the demo timeline it already writes. Implement this only with information the daemon already has; do not add a field to either peer to make it easier, and do not let it grow into a workflow object.

### Core schemas (`packages/core`)

- 🔵 `captureFrame` params gain `fresh?: boolean` (default `false`) per the protocol change above.
- 🔵 **Remove `sessionId` from `OperatorRunOptions`/`run_operator` input and from `OperatorRun`**, along with the operator's recording-configuration options. Remove any Zod refinement that existed to police attach-vs-standalone mutual exclusivity — there are no longer two modes to disambiguate. Removal must keep already-written operator-run records on disk parseable: an unknown extra key in an existing JSON file must not fail validation.
- 🔵 New error code `OPERATOR_LOOP_CRASHED` (or equivalent) in the daemon error taxonomy, with CLI/MCP propagation tests mirroring the existing 7-code coverage from Phase 13.
- 🔵 New error code `SCREEN_CAPTURE_BUSY` for the daemon-free bounded-wait path, with the same propagation-test treatment.
- 🔵 **Confirm removal** of the partial `operatorAttachedRunEnded` implementation from `packages/core/src/schemas/session.ts` (and any writer/reader of it), per the settled decision above. `RecordingSession` carries no operator-derived field of any kind. Removal must keep already-written session files on disk parseable — an unknown extra key in an existing `<id>.json` must not fail validation.

### `packages/operator` / operator-loop split

- 🔵 Decide and execute the package boundary (see Daemon section above) — either a new `packages/operator-loop` that depends on `packages/operator`'s existing tool/schema/guardrail code, or a new entry point inside `packages/operator` itself that's invoked as a child process rather than dynamically imported in-process. Whichever is chosen, the acceptance bar is: **the loop process's `OperatorDeps` implementation has no import of `SidecarClient`, `sidecar-process`, or anything that can spawn a native binary** — enforce this with a lint rule or a dependency-graph test, not just code review, mirroring how the native-side split is enforced by `otool -L` rather than convention.
- 🔵 **Additional dependency-graph bar**: `packages/operator` (and the loop package, if separate) must not import any recording/session type, engine, or client. Enforce this the same mechanical way — a dependency-graph test that fails if the operator packages reach `RecordingEngine`, `RecordingSession`, or the daemon's recording RPC surface.
- 🔵 Update `packages/operator`'s existing test suite to cover the new IPC boundary (fakes for the daemon-side proxy, same spirit as the existing fake-sidecar pattern in `packages/core/src/protocol/fake-sidecar.ts`), and to assert the recording-unawareness invariant directly: an identical run configuration produces an identical sequence of operator-visible calls whether or not a recording is active.

### Operator reasoning — formalize plan → execute → verify

Planning becomes an **explicit stage of the run**, not emergent behavior that has to re-materialize inside every observe/act iteration. The loop's shape becomes:

```
task → plan → execute one or more actions → verify checkpoint → continue/replan only when necessary
```

- 🔵 The Operator produces a concise initial **action plan** before it begins manipulating any UI: a short ordered list of intended steps and the checkpoint that proves each one landed. Illustration, using this phase's own investigation task ("create an incident in Warroom via Safari"): *activate Safari → navigate to waroom.co → locate and click "New incident" → fill in title/severity → submit → verify the incident appears in the list* — produced up front, in one model call, instead of being rediscovered one observation at a time.
- 🔵 The plan is **guidance, not an immutable script.** When an observation invalidates an assumption in the plan (the page looks different, a dialog intercepts, the element isn't where the plan expected), the Operator replans rather than forcing the stale plan through. Replanning is a first-class, expected transition — not an error path.
- 🔵 Purpose, stated so it can be measured: reduce model round trips and kill the current *observe → reason about one tiny action → act → observe → rediscover everything* pattern. Track steps-per-run and model-calls-per-run against this session's pre-change baselines.
- 🔵 The planning stage must be **provider/model-independent** — it is a property of the loop's structure and prompt contract, not of any one model's tool-calling behavior or of a provider-specific "planning" API. Any provider `packages/operator` supports must be able to run it.
- 🔵 Persist the plan (and each replan) into the run's step/transcript record, and emit it as a `plan` event, so a finished `OperatorRun` shows what the Operator intended, not just what it did.

### Operator execution — safe action batching

- 🔵 The execution contract supports **short batches of deterministic actions between observations**, where failure risk is low. Concrete example: `activate Safari → Cmd+L → type URL → Enter → observe`, rather than taking a full observation between each of those four actions.
- 🔵 A batch is appropriate when **all** of the following hold:
  - the actions are deterministic and locally sequential;
  - later actions in the batch do not require interpreting a changed UI;
  - the target/focus is sufficiently known at batch-construction time;
  - the existing guardrails still apply to **every** action in the batch (bounds clamping, step accounting, timeout, abort — a batch is not a guardrail bypass).
- 🔵 After a batch, always take a fresh observation and **verify the expected checkpoint** before continuing. A batch that ends without verification is not a valid batch.
- 🔵 Do **not** batch interactions that depend on intermediate UI state (clicking an element whose position is only knowable after the previous action's render, dismissing a dialog that may or may not appear, anything conditional). When in doubt, observe.

### CLI / MCP / plugin skill

- 🔵 `windower operate` (CLI, blocking) and `run_operator` (MCP) both **lose all recording-related options** — no `--session`/`sessionId`, and no flags that would start a recording. Their inputs reduce to task, target, model/provider config, and guardrail/planning config. Update CLI help text, `contracts/cli.md`, and the MCP tool description accordingly, and make the error message for a removed flag point at the caller-side recipe rather than just rejecting the flag.
- 🔵 `plugins/claude-code/SKILL.md`: rewrite the "driving the UI yourself vs. delegating to the operator" section so the **default and only** recipe is framed as *the calling agent orchestrating independent Windower capabilities*. The recipe is: `start_recording(target)` → `run_operator(target, task)` → poll `get_operator_run` until terminal → optionally allow a short settle period → `stop_recording`. **This recipe lives in SKILL.md and nowhere else** — it is guidance for Claude Code, not a Windower domain model, and other agents (Codex, a CI job, a shell script) must be free to compose the same primitives differently. The skill's job is to teach Claude Code that **it is the orchestrator**. Make explicit that the operator does not know a recording exists, never starts or stops one, and behaves identically with or without one; that the recording does not know or care what is driving the screen; and that recording is a deterministic capability the caller sequences — **not** a `RecordingAgent` and not something the operator owns. If Claude Code uses subagents for concurrency or isolation while managing recording lifecycle, say plainly that this is a Claude Code implementation detail, explicitly not Windower architecture. Remove the old "quick, standalone" all-in-one fallback entirely — it no longer exists. Draft already produced during this session's research pass — reuse it, reframed per the above, rather than starting from scratch.
- 🔵 No change to `contracts/mcp-tools.md`'s non-blocking/daemon-backed justification for `run_operator` — removing the recording options doesn't alter that reasoning.

### Docs

- 🔵 `CLAUDE.md`'s repo layout cheat sheet: `native/macos/` becomes two binaries under one Swift Package — update the tree diagram and the "one sidecar process per active session" convention note to describe the ScreenCaptureKit exclusivity invariant instead (supersedes, doesn't contradict — the convention was already gesturing at this). Add the recording-unaware-Operator invariant, and the "the calling agent is the orchestrator; Windower ships capabilities, not workflows" rule, to the non-obvious conventions list.
- 🔵 `specs/001-windower-mvp/bugs.spec.md` bug #6: add a closing dated entry once this phase's live verification (below) confirms the replayd-conflict class of truncation cannot recur by construction — cross-reference this phase number.
#### `~/Documents/Development/windower-site` (audited — these are real breakages, not a "check whether")

The capture/control process split is internal hardening with no site impact. The `run_operator`/`windower operate` surface change **is** user-facing and breaking, and the site currently documents the removed behavior as the headline feature. Everything below is in `src/data.ts` unless noted; `src/components/Operator.tsx` needs no change beyond whatever copy it pulls from `data.ts`.

- 🔵 **Usage string (~line 96)** — `windower operate "<task>" [recording flags] ... [--no-record]` must become the new shape: `"<task>" --target <id> [--kind window|display|region] [--region x,y,w,h] [--model p:m] [--base-url u] [--secret name=source:ref]... [--max-steps n] [--timeout s] [--max-batch n] [--unbounded] [--detach] [--json]`.
- 🔵 **Delete the `--no-record` flag entry (~line 135)** — the flag no longer exists, because the operator never records.
- 🔵 **Both worked examples (~lines 84 and 154)** pass `--resolution 1920x1080 --out ~/Desktop` to `operate`. Those are recording flags and are gone. Rewrite as the three-call caller-side recipe: `windower start --target <id> --resolution ... --out ...` → `windower operate "<task>" --target <id>` → `windower stop $SESSION`.
- 🔵 **Both example outputs (~lines 85 and 157)** show `operate` producing an mp4 and a manifest, and `operate status` reporting a `recording` path. The operator produces neither. Rewrite so the recording artifacts come from the `start`/`stop` pair and the run reports only run state.
- 🔵 **Operator blurb (~line 99)** — "drives one natural-language task to completion, **recording as it goes**" is now false. The operator drives a target; the caller records around it if it wants to.
- 🔵 **`--unbounded` copy (~line 133)** — "clamping every coordinate to the **recorded** target's bounds … it physically cannot click outside the window it is **recording**". The clamp is against the operator's own target, which has nothing to do with recording. Reword both sentences.
- 🔵 **`operate abort` copy (~line 141)** — "Any active recording is stopped and finalized, not discarded" is now false and inverts the invariant: aborting a run never touches a recording. Say so explicitly; it is a selling point, not a caveat.
- 🔵 **Transcript location (~line 160)** — "Three files land next to each other: the mp4, its `manifest.json`, and `<recording>.operator.json`" is wrong twice over. The transcript moved to `~/.windower/operator-runs/<runId>/` precisely because locating it next to a video required knowing about a recording. Rewrite; keep the (still accurate) secret-redaction and `source: "operator"` timeline-tagging copy.
- 🔵 **FAQ (~line 205)** — "start/stop/record work exactly as before … The operator is an extra path" survives, but check the surrounding framing now that the operator is strictly a peer capability rather than a recorder variant.
- 🔵 Consider whether the site should state the **breaking change** for existing users (the operator no longer records; `--no-record` and the recording flags are gone from `operate`) — a short migration note, wherever the site handles version-to-version changes.

- 🔵 `STATUS.md`.

### Explicitly out of scope for this phase

- Fixing the residual PTS-gap-stall truncation pattern (bugs.spec.md #6's "milder, self-recovering" residual issue) — different, likely-OS-level-only mechanism, not addressed by this phase's architecture.
- Windows/Linux capture/control process split — macOS-only; the protocol restructure must not block Phases 16/17 from choosing their own process topology.
- Any discovery/routing socket, or any mechanism letting one process's capture sidecar serve another process's capture calls — deliberately deferred until a concrete requirement proves concurrent daemon-free capture clients must interoperate.
- A persistent `DemoRun`/`WorkflowRun` model, or any Windower-owned orchestration/workflow component — event correlation stays in memory for this phase, and sequencing stays with the calling agent.
- Any new user-facing recording capability (multi-target concurrent recording, thumbnail previews, etc.) — this phase only builds the architecture that would make such features safe to add later, it doesn't add them.
- Authentication/sandboxing between the daemon and the two native binaries or the operator-loop child process beyond what already exists for the current single sidecar (same-machine, same-UID trust model, unchanged).
- Filing the Apple Feedback/radar report for the underlying `replayd` behavior (worth doing, tracked separately, not a code task).

### Exit criteria

- `windower-control-macos` cannot link ScreenCaptureKit even transitively — verified via `otool -L` as part of the build, not just by code review.
- **Exactly one capture sidecar process exists machine-wide** for the duration of a live recording — it is the **only** ScreenCaptureKit-touching process on the machine — under every call pattern the operator makes (`captureFrame`, `list_targets`, both in quick succession, both while the model is also calling `performInput`/`resize_window` concurrently) — verified by OS-level `log stream` tracing showing zero `replayd`-invalidation events across a real, long (3+ minute) caller-driven recording + operator run, repeated at least 3 times to rule out this bug's history of run-to-run variance.
- The same real repro (Safari/waroom.co task or equivalent, driven by a caller as `start_recording` → `run_operator` → poll → `stop_recording`) achieves ≥95% video-duration-preserved on every one of those 3+ runs — a durable fix, not a lucky sample, closing the replayd-conflict class of `bugs.spec.md` #6 for good.
- Neither the operator surface nor the recording surface contains an identifier, field, or option referring to the other — verified by a dependency-graph/schema test, not by review.
- **The same `OperatorRun` configuration behaves identically with and without a recording active** — same call sequence, same guardrail accounting, same terminal states — verified by a test that runs it both ways.
- **The same `CaptureSession` can record activity produced by something other than the Windower Operator** (a human, Claude Code driving the UI itself, Playwright, or nothing at all) with no schema or code path that distinguishes the cases.
- Killing the operator loop's child process mid-run does not affect a concurrently-running recording session at all (it keeps recording; only the `OperatorRun` transitions to a crashed/failed state) — verified by a real crash-injection test.
- Killing `windower-control-macos` mid-operator-run does not affect the capture sidecar or an in-progress recording.
- **Operator success, failure, crash, or timeout never affects a recording** under any outcome (`succeeded`/`failed`/`aborted`/`timed_out`/loop-crashed) — verified by a test per outcome. There is no code path from an operator terminal state to `stop_recording`.
- **Recording failure never leaves the operator wedged** — a capture-sidecar crash or a failed/aborted recording must not stall, hang, or silently degrade a concurrently-running `OperatorRun`.
- A caller-driven run (`start_recording` → `run_operator` → poll → `stop_recording`) produces recording fidelity identical to a recording with no operator running — the split adds isolation without adding latency or capability regressions (spot-check step latency against this session's pre-split baselines).
- **Killing the parent process leaves no `windower-capture-macos` or `windower-control-macos` child process behind** — the child exits via its stdin-EOF path, finalizing any in-progress capture output first — and **no pid-tracking or orphan-reaping infrastructure was introduced** to achieve it (the lock payload is still exactly `{ pid, acquiredAt, windowerHome }`).
- A daemon-free capture call made while another live process holds `~/.windower/capture.lock` either succeeds after a bounded wait or fails with a clear `SCREEN_CAPTURE_BUSY` — and never spawns a second ScreenCaptureKit process, and is never routed to the mutex holder.
- **No component, type, file, error code, or identifier introduced by this phase is named "broker"** — grep the repo to confirm; the vocabulary is capture sidecar, control sidecar, and ScreenCaptureKit exclusivity mutex.
- **Frame access carries no recording handle** — `capture_frame` is addressed by target only, and no dependency exists from Recording onto Operator or from Operator onto Recording in either direction, verified by the dependency-graph/schema tests above.

**Caller-orchestration acceptance criteria:**

- A calling coding agent can start a recording, run an operator against the same target, wait for it to finish, and stop the recording — as four independent calls it controls, with no implicit lifecycle coupling and no shared identifier between the two capabilities.
- Windower ships **no** code, type, or RPC that performs that sequence on the caller's behalf; the recipe exists only as guidance in `plugins/claude-code/SKILL.md`, and an agent that is not Claude Code can compose the same primitives in a different order without fighting the architecture.
- Claude Code's recommended skill recipe reflects caller-side orchestration rather than implicit lifecycle coupling, and documents no operator-owned-recording mode.
- Any correlation between operator events and capture events is produced by the daemon from handles the caller already gave it, and is absent from both peers' persisted records except in the merged demo timeline.

- Full existing test suites (Swift + all TS workspaces) green with no regressions; new tests cover the mutex's stale-holder recovery and bounded-wait/`SCREEN_CAPTURE_BUSY` path, the frame-sharing optimization's cache-hit/miss paths, and the dependency-graph enforcement described above.

### Live verification (final task — do this last, after everything above, manual/TCC-gated per `e2e/README.md` convention)

- 🔵 **The core repro, repeated.** Real caller-driven run (real model, real TCC grants, no daemon pre-started): `start_recording` → `run_operator` → poll → `stop_recording`, same Finder→Safari→waroom.co task used throughout this investigation, `--max-steps 30`. Run it **at least 3 times** (this bug's history includes single "lucky" runs that didn't generalize). Confirm `manifest.json`'s asset-derived `video.durationMs` is ≥95% of the real wall-clock session span on every run, and capture `log stream` output for at least one run to positively confirm zero `replayd`-invalidation lines appear anywhere in the trace.
- 🔵 **Concurrent-load stress variant**: same task, but with an added synthetic burst of `list_targets` calls injected at a faster-than-organic cadence (reusing the raw-sidecar-harness pattern already built during this session's investigation) layered on top of the real caller-driven run, to confirm that exactly one capture sidecar process exists machine-wide under load heavier than a real model happens to generate (verify with `ps`, not just by absence of errors).
- 🔵 **Operator-without-recording parity**: run the identical `run_operator` call with **no recording active at all**. Confirm the run's steps, plan/replan behavior, guardrail accounting, and terminal state are equivalent to the recorded run, and that nothing in the operator's output or persisted record differs in kind because a recording existed.
- 🔵 **Recording-without-operator parity**: run `start_recording`/`stop_recording` around a human or Claude-Code-driven interaction with no operator involved. Confirm the session record and manifest are indistinguishable in shape from the caller-driven case — nothing identifies what drove the screen.
- 🔵 **Independent lifecycle**: with `stop_recording` deliberately delayed well past the operator run's terminal state, confirm the recording keeps recording normally while `get_operator_run` alone reports the run has ended, and that the session record shows no trace of the operator.
- 🔵 **Crash injection — control surface**: `kill -9` the `windower-control-macos` process mid-run. Confirm the recording is completely unaffected (finalizes normally when eventually stopped) and the operator run surfaces a clear, distinct error rather than hanging or silently truncating.
- 🔵 **Crash injection — operator loop**: `kill -9` the operator decision-loop child process mid-run. Confirm the concurrently-running recording session is completely unaffected and finalizes normally when the calling agent stops it, and that the `OperatorRun` fails with `OPERATOR_LOOP_CRASHED`.
- 🔵 **Crash injection — capture sidecar**: `kill -9` the `windower-capture-macos` process mid-recording, with an operator run in flight. Confirm this behaves at least as well as today's pre-split single-sidecar crash recovery (Phase 13's existing e2e crash-injection test) — no regression from the split — and that the operator run surfaces clear errors rather than wedging.
- 🔵 **Mutex stale-holder recovery**: `kill -9` a capture sidecar process while it holds `~/.windower/capture.lock`, then immediately issue a new daemon-free `list_targets` call. Confirm the stale mutex is detected (dead pid) and stolen cleanly rather than wedging every subsequent capture-surface call.
- 🔵 **Busy-mutex behavior**: with a live daemon-free capture sidecar holding the mutex, issue a second daemon-free capture call. Confirm it either succeeds after a bounded wait or returns `SCREEN_CAPTURE_BUSY`, that no second ScreenCaptureKit process is ever spawned, and that the second caller is **not** routed into the holder's process.
- 🔵 **Resource hygiene**: after a full session of mixed recording/operator/crash-injection activity above, confirm via `ps aux` that no `windower-capture-macos`/`windower-control-macos`/operator-loop child processes remain running, and that `~/.windower/capture.lock` does not persist past the last legitimate holder's exit.
- 🔵 File the Apple Feedback/radar report for the underlying `replayd` cross-process behavior found this session (tracked as a follow-up action, not a blocking exit criterion for this phase, but do it while the `log stream` evidence is fresh and available).
