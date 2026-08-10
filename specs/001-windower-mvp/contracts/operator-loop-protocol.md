# Operator Loop Protocol Contract

Phase 21, v1.4. The JSON-RPC 2.0 surface between the **daemon** and the **operator decision-loop child process** — the observe → decide → act loop of `contracts/operator.md`, extracted out of the daemon into its own OS process.

The loop is a different failure domain from everything else Windower does: it makes network calls to a model provider, holds a growing transcript in memory, and links a provider SDK the daemon otherwise has no reason to trust with its address space. Extracting it applies the same "isolate what can fail" rule `CLAUDE.md` already applies to capture sessions. A wedged, leaking, or `kill -9`'d loop must not be able to take down the daemon.

It also cannot affect a recording, and not because this protocol is careful about it: **there is no recording on this wire at all.** Per `contracts/operator.md` §Recording independence, the operator never knows whether a recording exists, never starts or stops one, and carries no session identifier — so no method, param, result, or error code below names one, and none may be added.

This document is to the loop child what `contracts/sidecar-protocol.md` is to the native sidecar. It does not redefine `OperatorRun`, `OperatorStep`, `InputAction`, `Rect`, or `CaptureTarget` — those are `data-model.md`'s.

## The rule this protocol exists to enforce

> The loop child **never** constructs a `SidecarClient`, **never** spawns a native binary, and **never** opens `~/.windower/capture.lock`. Every screen-facing action it takes is a proxied request to the daemon, which serves it from the capture sidecar or the control surface on the child's behalf.

Letting the loop process touch ScreenCaptureKit itself would silently reintroduce the exact multi-process `replayd` hazard the ScreenCaptureKit exclusivity mutex (`contracts/screen-capture-exclusivity.md`) exists to eliminate. This is enforced by a dependency-graph test over the loop entry point's import closure, not by code review — mirroring how the native split is enforced by `otool -L` rather than convention.

## Transport

- The daemon spawns the loop as a child process, one per `OperatorRun`, and owns its lifecycle.
- Requests/responses/notifications are **JSON-RPC 2.0**, one JSON object per line (newline-delimited), on the child's stdin (daemon → child) and stdout (child → daemon). Identical framing to `contracts/sidecar-protocol.md` — a second IPC shape would buy nothing.
- stderr is free-form human-readable logs only, never protocol data. The daemon runs the redaction filter over it before persisting anything.
- The channel is **bidirectional**: both ends send requests. A received message is a request if it has a `method` member, and a response otherwise. Each side numbers its own request `id`s independently and keeps its own pending map, so a daemon request `id: 1` and a child request `id: 1` are unrelated and cannot collide.
- Responses correlate to requests by `id` alone. Neither side may assume in-order answers, and both MAY service requests concurrently — the same requirement `contracts/sidecar-protocol.md` places on backends.
- No arguments carrying run configuration are passed on `argv`. Secret **names**, model config, and task text all arrive as the result of `ready` (below). Anything on `argv` is visible in `ps` output, which `contracts/operator.md` already rules out for API keys and which this protocol extends to the task string.

## Direction of calls, and why

| Direction | Traffic | Rationale |
|---|---|---|
| child → daemon | `ready`, the four proxied screen-facing methods, `beginStep`, `reportPlan`, `reportStep`, `reportResult`, `guardrailState`, `log` | All capability lives daemon-side. The child owns only the loop; every effect it wants is a request outward. |
| daemon → child | `abort`, `ping` | Both are **pushes the child cannot poll for cheaply**. |

`abort` must be a push. The child spends the overwhelming majority of each step blocked inside a provider HTTP call; if the kill switch (`windower operate abort <runId>` / `abort_operator_run`) were delivered by polling, its latency would be bounded below by a model round trip — seconds to tens of seconds, on a control the user reaches for precisely when something is going wrong. A pushed notification lets the child fire the `AbortController` already wired into `generateText` immediately.

`abort` is a notification and not simply a `SIGTERM` because the daemon wants the child's cooperation before it dies: a clean abort produces a final `reportResult` with `state: "aborted"` and whatever partial step the child was mid-way through, which is the difference between a useful transcript and a truncated one. `SIGTERM`-then-`SIGKILL` remains the backstop (see "Shutdown" below), not the first move.

`ping` exists because pid liveness is not health. A child stuck in a synchronous loop, or wedged on a provider connection with no timeout, is alive to `kill(pid, 0)` and useless to everyone. Nothing else in this protocol can distinguish "the model is thinking" from "the child is wedged".

## Handshake

The child sends `ready` as its **first** message; the daemon's result is the run configuration. One round trip, no `argv`, and no race about when the child started reading stdin.

```jsonc
// child → daemon
// → {"jsonrpc":"2.0","id":1,"method":"ready","params":{"loopProtocolVersion":1,"pid":4890}}
// ← {"jsonrpc":"2.0","id":1,"result":{
//     "runId": "018f2c...",
//     "task": "open waroom.co in Safari",
//     "target": { "id": "window:4821", "kind": "window", "title": "Safari", "bounds": { … } },
//     "model": { "provider": "anthropic", "model": "claude-sonnet-5" },
//     "secretNames": ["password"],
//     "maxSteps": 40,
//     "maxBatchActions": 8,
//     "timeoutMs": 300000,
//     "unbounded": false,
//     "bounds": { "x": 0, "y": 0, "width": 3024, "height": 1964 },
//     "env": { "ANTHROPIC_API_KEY": "sk-..." },
//     "startedAtMs": 1786000931000
//   }}
```

`ready`'s result is `OperatorRunOptions` (`packages/core/src/operator/types.ts`) minus the four members that cannot cross a process boundary, plus one:

| Member | Disposition |
|---|---|
| `signal` | Replaced by the `abort` notification. |
| `onStep` | Replaced by the `reportStep` request. |
| `transcriptPath` | **Not sent.** The daemon owns all disk writes; see "Persistence". |
| `secrets` | **Not sent.** Replaced by `secretNames: string[]`; see "Secrets". |
| `startedAtMs` | New. The daemon's authoritative run-start epoch, so the child's `tMs` and the daemon's `timeoutMs` are measured from the same instant rather than from two independent `Date.now()` reads separated by a spawn. |

`target` is the **resolved** `CaptureTarget` the run operates — the daemon resolves the caller's `CaptureTarget | { targetId }` selector once, before the spawn, so the child never enumerates to find out what it is driving and `bounds` is always the resolved target's own `Rect`. It is the same selector shape `start_recording` takes, resolved the same way; it is **not** and **MUST NOT** become a channel for telling the child that a recording exists over that target.

`env` carries only the model's API-key variable — the same scoped snapshot `hello` defines in `contracts/daemon-rpc.md` §`env` scoping rules, forwarded verbatim. The daemon never logs it; neither does the child.

## Methods: child → daemon

| Method | Params | Result | Notes |
|---|---|---|---|
| `ready` | `{ loopProtocolVersion: number, pid: number }` | run configuration (above) | Must be first. A second `ready` is `LOOP_PROTOCOL_VIOLATION`. |
| `beginStep` | `{ index: number }` | `{ guardrail: GuardrailState }` | Opens step `index`. The **only** thing that increments the authoritative step counter. |
| `captureFrame` | `{ format: "png"\|"jpeg", maxWidth?: number, quality?: number, fresh?: boolean }` | `{ imageBase64, width, height, scale }` | Proxied to the capture sidecar, always against the run's own `target` — there is no session-shaped frame source on this wire, and whether the frame comes from a live capture source or a one-shot capture is unobservable here. `fresh` per `contracts/sidecar-protocol.md`'s frame-sharing note; the loop leaves it unset. |
| `performInput` | `{ actions: InputAction[] }` | `{ performed: number }` | Proxied to the control surface, after daemon-side bounds clamp and secret substitution. |
| `enumerateTargets` | `{ kinds?: ("display"\|"window"\|"app")[] }` | `{ targets: CaptureTarget[] }` | Proxied to the capture sidecar. `"app"` is filtered daemon-side exactly as `PassthroughService` does today. |
| `resizeWindow` | `{ targetId: string, bounds: Rect }` | `{ actualBounds: Rect, result: "success"\|"partial"\|"unsupported" }` | Proxied to the control surface. |
| `reportPlan` | `{ steps: string[], rationale?: string }` | `{ accepted: true, revision: number }` | The child's model called `plan`. The daemon assigns the revision, stamps `atStepIndex`/`tMs` from its own state and clock, sets `OperatorRun.plan`, and holds it for the open step. Requires an open step; never increments the step counter. |
| `reportStep` | `{ step: OperatorStep }` | `{ accepted: true, guardrail: GuardrailState }` | Closes the open step. The daemon redacts, appends to `OperatorRun.steps`, and persists. `step.checkpoint` and `step.reasoning` carry the turn's verification outcome and narration; see "Operator events on this wire". |
| `reportResult` | `{ state: OperatorRunState, summary?: string, error?: { code: string, message: string } }` | `{ accepted: true }` | Terminal. After the response the child writes nothing further and exits `0`. |
| `guardrailState` | `{}` | `GuardrailState` | Read-only. Lets the child render accurate budget numbers into the system prompt mid-run without inferring them. |
| `log` | `{ level: "debug"\|"info"\|"warn"\|"error", message: string, fields?: object }` | — (notification) | Structured alternative to stderr. Redacted daemon-side before it reaches any log file. |

```ts
type GuardrailState = {
  stepsUsed: number;         // steps opened via beginStep, authoritative
  maxSteps: number;
  actionsInStep: number;     // action requests served inside the currently open step; 0 when none is open
  maxBatchActions: number;   // per-step action ceiling (contracts/operator.md §Action batching)
  remainingMs: number;       // wall-clock budget left, from the daemon's clock
  aborted: boolean;          // an abort has been signalled
  unbounded: boolean;
  bounds?: Rect;
  planRevision?: number;     // highest plan revision the daemon has accepted; absent before the first reportPlan
};
```

The four proxied methods are exactly `OperatorDeps`' four members (`captureFrame`, `performInput`, `listTargets`, `resizeWindow`), which are in turn exactly the four sidecar-facing methods every other Windower interface already uses. This protocol adds **no** capability to the operator: the loop child can do strictly less than the in-process loop could, because it can no longer reach a `SidecarClient` at all. The daemon-side `OperatorDeps` implementation for a child process is a thin adapter over these methods.

There is no method here that spawns a process, reads or writes the filesystem, or makes an HTTP request on the child's behalf. `contracts/operator.md`'s closed-tool-surface guarantee holds a fortiori across this boundary — the model's tool surface is a subset of the child's, which is a subset of the table above.

### Step framing, and why `beginStep` exists

Screen-facing methods are only servable **inside an open step**. `captureFrame` / `performInput` / `enumerateTargets` / `resizeWindow` outside one is `NO_OPEN_STEP`.

This is what makes daemon-side step counting airtight. Counting `captureFrame` calls would double-count the `screenshot` tool against the loop's own per-step observation; counting `reportStep` calls would let a buggy child that simply never reports run forever while still issuing proxied actions. An explicit open/close bracket, with proxied calls gated on an open bracket, closes both holes with one mechanism.

- `beginStep({ index })` where `index !== stepsUsed` is `STEP_INDEX_MISMATCH` — the child cannot skip, rewind, or reuse an index.
- `beginStep` while a step is already open is `LOOP_PROTOCOL_VIOLATION`.
- `beginStep` at `index >= maxSteps`, past the deadline, or after an abort fails with the corresponding guardrail code below and the daemon begins finalization.

### Batches inside a step

`contracts/operator.md` §Action batching lets one turn emit several action tool calls. On this wire a batch is not a new frame: it is **several `performInput`/`resizeWindow` requests inside one open step**, and the step bracket is unchanged.

- A batch costs **one** step, regardless of how many actions it contains. `stepsUsed` increments on `beginStep`, never on an action request.
- The daemon counts *action* requests — `performInput` and `resizeWindow` — within the open step as `actionsInStep`. `captureFrame` and `enumerateTargets` are observations, not actions, and do not count.
- An action request at `actionsInStep >= maxBatchActions` fails `OPERATOR_BATCH_LIMIT_EXCEEDED`. This is **not** run-terminating: the daemon leaves the step open, the child abandons the rest of the batch, records the over-limit and subsequent actions as `{ skipped: "BATCH_ABORTED" }`, and closes the step with `reportStep` as normal.
- Guardrails are re-checked per action, in request order — the bounds clamp, secret substitution, deadline, and abort state are evaluated when each action request arrives, never once for the batch. A batch is not a transaction: there is no rollback for actions the daemon already served.
- When an action fails mid-batch, the daemon serves nothing retroactively and does nothing implicit. Whether the run continues or ends is decided by the error's own class, per `contracts/operator.md` §Batch failure semantics — terminal guardrail codes (`INPUT_OUT_OF_BOUNDS`, `OPERATOR_TIMEOUT`, `OPERATOR_ABORTED`, `OPERATOR_MAX_STEPS_EXCEEDED`) end the run; proxied surface errors (`TARGET_NOT_FOUND`, `RESIZE_UNSUPPORTED`, `CAPTURE_FAILED`, `UNSUPPORTED_CAPABILITY`, `INPUT_UNSUPPORTED`) are returned to the child as that action's result and the run continues.

### Plans on this wire

`reportPlan` is the child's only planning surface, and it carries the *content* of the plan while the daemon owns its *identity*: the child sends `steps` and an optional `rationale`, and the daemon assigns `revision` (monotonic from 0, per run), `atStepIndex` (the open step's index), and `tMs` (from `startedAtMs`). A child cannot renumber, backdate, or overwrite a plan revision, for the same reason it cannot forge a step index.

- `reportPlan` outside an open step is `NO_OPEN_STEP`.
- More than one `reportPlan` in a single open step is `LOOP_PROTOCOL_VIOLATION` — one turn produces at most one plan revision.
- On acceptance the daemon sets `OperatorRun.plan` and attaches the revision to the open step, so it lands in the transcript as `OperatorStep.plan` when `reportStep` closes that step. The child does not repeat the plan inside `reportStep.step`; if it does, the daemon's copy wins.
- Planning has **no** effect on any guardrail budget. `reportPlan` does not consume a step and does not count toward `maxBatchActions`.
- Nothing in this protocol requires a plan to exist. A run with zero `reportPlan` calls is well-formed on the wire (`OperatorRun.plan` stays absent) — the "plan before acting" requirement is a property of the operator's prompt and its own test suite, not something the daemon referees. This keeps the wire provider-independent: a model that expresses planning poorly produces a worse transcript, never a protocol error.

### Operator events on this wire

`contracts/operator.md` §Operator events defines the five kinds a run emits — `plan`, `action`, `checkpoint`, `narration`, `result`. This protocol adds **no** event method: the child reports *facts*, the daemon derives *events*, in exactly the same division of labour that already lets the daemon own a plan's revision while the child owns its content.

| Event kind | How the child reports it | What the daemon does |
|---|---|---|
| `plan` | `reportPlan({ steps, rationale? })` | Stamps `revision`/`atStepIndex`/`tMs`, emits on acceptance. |
| `action` | each `performInput`/`resizeWindow` request, then the matching row in `reportStep.step.toolCalls` | Emits one event per row as the step closes, including `{ skipped: "BATCH_ABORTED" }` rows. |
| `checkpoint` | `reportStep.step.checkpoint` — `{ expectation, outcome, detail? }`, `outcome` one of `"held"`/`"failed-plan-sound"`/`"failed-plan-invalid"` | Emits on step close. Optional on the wire: a step with no checkpoint emits none. |
| `narration` | `reportStep.step.reasoning` | Emits on step close when present. Absent for providers exposing no rationale — never a protocol error. |
| `result` | `reportResult({ state, summary?, error? })` | Emits last. **Synthesized by the daemon** when the child dies without sending one (`OPERATOR_LOOP_CRASHED`), so every run's stream ends with exactly one `result`. |

`seq` and `tMs` are the daemon's, assigned in acceptance order from `startedAtMs` — the child cannot renumber or backdate an event any more than it can a plan revision. **No event carries any identifier other than `runId`**, and no member of any payload above may be extended to carry a recording or session id.

## Methods: daemon → child

| Method | Params | Result | Notes |
|---|---|---|---|
| `abort` | `{ reason: "user"\|"timeout"\|"max-steps"\|"daemon-shutdown" }` | — (notification) | The child aborts any in-flight model call, closes any open step with `reportStep`, sends a final `reportResult`, and exits `0`. |
| `ping` | `{}` | `{ pong: true, stepIndex: number, uptimeMs: number }` | Liveness/wedge probe. |

`abort` reasons map to terminal states the child reports back: `"user"` → `aborted`, `"timeout"` → `timed_out`, `"max-steps"` → `failed` with `OPERATOR_MAX_STEPS_EXCEEDED`, `"daemon-shutdown"` → `aborted`. The daemon does not depend on the child agreeing — it already knows the outcome it signalled and will apply it regardless (see "Guardrails are daemon-side").

The reason set is closed, and notably contains **no** recording-derived reason. A recording starting, stopping, failing, or never having existed **MUST NOT** abort an operator run — an earlier draft's `"session-ended"` reason is removed, because a run that ends when a recording ends is a run that behaves differently depending on whether it is being recorded, which `contracts/operator.md` forbids outright.

## Guardrails are daemon-side

`maxSteps`, `timeoutMs`, `maxBatchActions`, and the target-bounds clamp are enforced **by the daemon**, on the serving side of every request in this protocol. The child enforces them locally too — it has the same `Deadline` and `assertWithinBounds` code it always had, and a well-behaved child stops on its own without the daemon having to say anything — but the daemon's copy is authoritative and is the one that cannot be bypassed.

The reasoning is the same one `contracts/operator.md` already applies to the model: *the thing being bounded is not trusted to bound itself.* The child process runs provider SDK code, parses model output, and is the single most likely component in the system to be buggy or compromised. Placing its limits on the other side of the process boundary means a child that ignores its own `Deadline`, patches out `assertWithinBounds`, or simply never checks anything still cannot:

| Attempted bypass | What stops it |
|---|---|
| Loop past `maxSteps` | `beginStep` fails `OPERATOR_MAX_STEPS_EXCEEDED` at `index >= maxSteps`; proxied calls need an open step. |
| Run past `timeoutMs` | The daemon holds its own timer from `startedAtMs`; on expiry it pushes `abort({reason:"timeout"})`, refuses further `beginStep`/proxied calls with `OPERATOR_TIMEOUT`, and escalates to `SIGTERM`/`SIGKILL` if the child doesn't wind down. |
| Click outside the target on a bounded run | The daemon re-applies the bounds clamp to `performInput.actions` before touching the control surface, and rejects with `INPUT_OUT_OF_BOUNDS`. The child's own clamp is a courtesy that produces a better transcript; it is not the enforcement point. |
| Ignore `abort` | Same escalation as timeout. The abort is recorded against the `OperatorRun` when it is *signalled*, not when the child acknowledges. |
| Skip `beginStep` and act directly | `NO_OPEN_STEP`. |
| Forge step indices to reset the counter | `STEP_INDEX_MISMATCH`; `stepsUsed` is the daemon's, monotonic. |
| Batch an unbounded run of actions inside one step to stretch `maxSteps` | The daemon counts `actionsInStep` per open step and refuses past `maxBatchActions` with `OPERATOR_BATCH_LIMIT_EXCEEDED`. Batching changes the *cost* of a step, never the *number* of steps or the checks each action passes. |
| Batch to skip the bounds clamp on later actions | The clamp runs per action request, on arrival. There is no batch-level fast path. |
| Renumber or rewrite a plan revision | The daemon assigns `revision`/`atStepIndex`/`tMs`; `reportPlan` carries content only. |
| Exfiltrate a secret value | It never had one — see below. |

Two clamps in two processes is deliberate duplication, not redundancy to be refactored away. Deleting the daemon-side copy removes the guarantee; deleting the child-side copy only degrades transcript quality.

## Secrets

The child receives `secretNames: string[]` and **never a resolved secret value**. `contracts/operator.md`'s substitution boundary moves one process outward: the placeholder token `{{name}}` is what the model emits, what the child puts in `performInput.actions`, and what crosses this protocol. The daemon substitutes the real value inside its `performInput` handler, immediately before the control-surface RPC, and the value exists only in daemon memory for the duration of that one call.

This strictly improves on the in-process arrangement: the process running provider SDK code and model-derived strings no longer holds any secret material at all, so no bug in it can leak one.

A `{{name}}` referencing an unknown name is `UNKNOWN_SECRET_REF` — never passed through literally, since typing a literal `{{password}}` into a login form is a silent failure that looks like a model mistake.

## Persistence

The child writes nothing to disk. `transcriptPath` is not part of its configuration, and it has no filesystem method in this protocol.

- `reportPlan` → the daemon stamps the revision, sets `OperatorRun.plan`, and persists. A plan revision is durable the moment it is accepted, so a crashed run's transcript still shows what it intended to do.
- `reportStep` → the daemon redacts the step, appends it to `OperatorRun.steps`, writes the observation frame into the run's own `frames/` directory (content-addressed, per `contracts/operator.md`), and rewrites `~/.windower/operator-runs/<runId>/transcript.json`. Operator artifacts live in operator-owned storage; resolving a path next to a video file would require knowing a recording exists.
- `reportResult` → the daemon sets `state`/`endedAt`/`error`, persists, and finalizes.

`OperatorStep.observationRef` in a `reportStep` payload names the frame the child observed by its content hash; the daemon already holds the bytes, because the frame came from its own `captureFrame` proxy. The child never re-sends image data upward — `captureFrame` results flow down, refs flow up.

This is what keeps the redaction filter and the manifest/transcript layout in exactly one process, and keeps a compromised child from writing to arbitrary paths.

## Error taxonomy

All JSON-RPC errors on this channel use a `data.code` from a fixed set, same shape as `contracts/sidecar-protocol.md` and `contracts/daemon-rpc.md`.

**Passed through unchanged** from the proxied surfaces — a routed error arrives at the child exactly as the capture sidecar or control surface produced it, so the child cannot tell a proxied call from a direct one: `PERMISSION_DENIED`, `TARGET_NOT_FOUND`, `RESIZE_UNSUPPORTED`, `CAPTURE_FAILED`, `UNSUPPORTED_CAPABILITY`, `INPUT_UNSUPPORTED`, `INPUT_OUT_OF_BOUNDS`, `INTERNAL_ERROR`, `SCREEN_CAPTURE_BUSY` (`contracts/screen-capture-exclusivity.md`).

**New to this protocol:**

| Code | Direction | Meaning |
|---|---|---|
| `LOOP_PROTOCOL_VERSION_MISMATCH` | daemon → child (as `ready`'s error) | `ready.loopProtocolVersion` disagrees with the daemon's compiled-in constant. Indicates a broken install, never a supported configuration — see "No capability negotiation". The child exits non-zero; the daemon fails the run. |
| `LOOP_NOT_STARTED` | daemon → child | Any method other than `ready` arrived first. |
| `LOOP_ALREADY_ENDED` | daemon → child | Any request after `reportResult`. |
| `LOOP_PROTOCOL_VIOLATION` | daemon → child | A second `ready`, a nested `beginStep`, a second `reportPlan` in one step, or a `reportStep` with no open step. Distinct from `INVALID_ARGS`: the *shape* was valid, the *sequence* was not. |
| `NO_OPEN_STEP` | daemon → child | A proxied screen-facing method, or `reportPlan`, outside an open step. |
| `STEP_INDEX_MISMATCH` | daemon → child | `beginStep.index !== stepsUsed`, or `reportStep.step.index !== ` the open step's index. |
| `OPERATOR_MAX_STEPS_EXCEEDED` | daemon → child | `beginStep` at `index >= maxSteps`. Same string as `packages/operator`'s existing `OPERATOR_ERROR_CODES.MAX_STEPS_EXCEEDED` — this is the same guardrail, moved, not a new one. |
| `OPERATOR_BATCH_LIMIT_EXCEEDED` | daemon → child | An action request (`performInput`/`resizeWindow`) at `actionsInStep >= maxBatchActions`. **Not run-terminating** — the step stays open, the child abandons the rest of the batch and closes the step normally. |
| `OPERATOR_TIMEOUT` | daemon → child | Any request after the wall-clock deadline. |
| `OPERATOR_ABORTED` | daemon → child | Any request after an abort was signalled. |
| `UNKNOWN_SECRET_REF` | daemon → child | `performInput` contained a `{{name}}` placeholder not in `secretNames`. |
| `CONTROL_SURFACE_UNAVAILABLE` | daemon → child | `windower-control-macos` is not running and could not be spawned, or died mid-call. Distinct from `CAPTURE_FAILED` so a control-surface crash is never mistaken for a capture problem — the two are independent failure domains and the whole phase depends on being able to tell them apart. |
| `INVALID_ARGS` | daemon → child | Params failed schema validation. |
| `OPERATOR_LOOP_CRASHED` | daemon-internal, **never on the wire** | See below. |

### `OPERATOR_LOOP_CRASHED`

Added to `DaemonErrorCodeSchema` (`packages/core/src/daemon/methods.ts`) with the same CLI exit-code and MCP tool-error propagation as the existing codes.

The daemon raises it when the child exits without having sent `reportResult` — non-zero exit, a signal, `kill -9`, an unparseable stdout line followed by EOF, or a `ping` that goes unanswered past `LOOP_PING_TIMEOUT_MS` (default 30000, generous enough to never fire during a slow model call).

On that event the daemon:

1. Marks the `OperatorRun` `state: "failed"` with `error: { code: "OPERATOR_LOOP_CRASHED", message }`, `message` naming the exit code or signal.
2. Persists the run with every step reported so far — a crashed run keeps its partial transcript rather than being discarded.
3. Reaps the child (`SIGKILL` if still in a zombie/wedged state) and tears down nothing else native.
4. Emits the synthesized `result` event (see "Operator events on this wire") and stops.

**What happens to the recording: nothing, ever.**

| Situation | What the daemon does to a recording |
|---|---|
| Loop child crashes, a recording happens to be running | **Nothing.** No `stopRecording`, no `cancelCapture`, no touch of any capture-sidecar client held for a recording, and no write — advisory or otherwise — to any session's persisted state. The recording keeps recording. |
| Loop child crashes, nothing is recording | **Nothing.** Identical code path — the daemon does not check. |
| Any other terminal outcome (`succeeded`, `failed`, `aborted`, `timed_out`) | **Nothing.** Same as above, for the same reason. |

There is no `ownsSession` flag, no attach-vs-standalone branch, and no ownership question to resolve, because the operator never owns a recording under any configuration (`contracts/operator.md` §Recording independence removed the standalone mode that was the only case where it did). `finalize()` consults nothing about recording — a branch there would be a defect, since the two rows above must be the *same* code path, not two paths that agree.

The orchestrator observes the run's terminal state by polling `get_operator_run`, and stops the recording it started when it is ready to, exactly as it would have on a successful run.

**Tested per outcome:** an operator run reaching `succeeded`, `failed`, `aborted`, `timed_out`, or `OPERATOR_LOOP_CRASHED` while a recording is active leaves that recording running and its session file byte-identical to a control run with no operator at all.

### Neither side knows about the other

A `RecordingSession` **MUST NOT** carry any knowledge of an operator run: it must be impossible, from the session's own state, to tell whether the thing being recorded is a human, Windower Operator, Claude Code, Playwright, some other agent, or nothing at all. And symmetrically, an `OperatorRun` **MUST NOT** carry any knowledge of a recording.

Concretely, and normatively:

- There is **no** relationship field in either direction. No reciprocal field on the session, and no `sessionId` on the run — a pointer either way is a dependency between peers, and a dependency added for orphan-visibility is still a dependency.
- The orchestrator learns that a run reached a terminal state by **polling `get_operator_run`**, which it is already doing to know when to call `stop_recording`. Nothing about the run is surfaced through `get_session`/`list_sessions`, and nothing about a recording is surfaced through `get_operator_run`.
- Any bookkeeping the daemon needs to serve a live run (which child process belongs to which run, which capture-sidecar client a proxied `captureFrame` routes to) is in-memory daemon state that dies with the daemon. Serving a proxied call from the capture sidecar process the daemon already has is ScreenCaptureKit exclusivity bookkeeping (`contracts/screen-capture-exclusivity.md`), not a fact about a recording, and **MUST NOT** be exposed to the child.
- Lining a run's events up with a recording's timeline is the caller's business — it initiated both — per `contracts/operator.md` §Correlating the two streams. No Windower component does it, and no `DemoRun`/`WorkflowRun` record is introduced.

This is the same rule the phase applies below the stdio line, one layer up: capture and control are peers that do not know about each other, and capture and *operation* are peers that do not know about each other either.

## Shutdown

| Trigger | Sequence |
|---|---|
| Normal completion | Child sends `reportResult`, receives the response, exits `0`. The daemon waits up to `LOOP_EXIT_GRACE_MS` (default 2000) and `SIGKILL`s if the process is still there. |
| Abort / timeout / max-steps | Daemon pushes `abort`, expects `reportResult` within `LOOP_ABORT_GRACE_MS` (default 5000), then `SIGTERM`, then `SIGKILL` after a further 2000 ms. A run that reaches `SIGKILL` is still recorded with the state the daemon signalled, not as `OPERATOR_LOOP_CRASHED` — the daemon asked for this exit. |
| Daemon graceful shutdown | `abort({reason:"daemon-shutdown"})` to every live loop child first, then the existing drain in `contracts/daemon-rpc.md` §Graceful shutdown. Any live recordings are finalized by the drain's own `stopRecording` pass, independently of and unordered with respect to the loop children — the two are drained as peers, and the loop's shutdown neither triggers nor waits on the recording's. |
| Daemon `SIGKILL` | The child sees EOF on stdin, aborts its model call, and exits `0` immediately without attempting `reportResult` — there is nobody to report to, and a child that outlives its daemon is an orphan holding a provider connection. The next daemon start's recovery pass marks the orphaned run `failed` with `OPERATOR_LOOP_CRASHED`. |

## No capability negotiation

There is none, deliberately. Both ends of this channel are always binaries from **this codebase, from the same installed package version**: the daemon computes the loop entry point's path from its own resolved module location and spawns it directly, so there is no path by which a 0.3.0 daemon talks to a 0.2.0 loop, and no third-party implementation of either end exists or is contemplated.

Contrast `contracts/sidecar-protocol.md`, where `describe`'s `capabilities[]` is load-bearing for real reasons: the sidecar is a *different language's* binary, implementing a *per-OS* backend, whose available features genuinely vary with the platform, the OS version, and which TCC grants the user has clicked. None of those axes exist here — the loop child is TypeScript running on the same Node binary, and every OS- and permission-dependent decision has already been made on the daemon side, *before* a proxied call reaches this protocol. A capability list would be a constant, and a constant negotiated at runtime is a constant that will eventually be wrong.

`ready.loopProtocolVersion` is therefore an **assertion, not a negotiation**: a mismatch means a corrupted or half-upgraded install, and the correct response is to fail the run loudly with `LOOP_PROTOCOL_VERSION_MISMATCH`, not to degrade to a smaller method set. It is bumped on any wire-incompatible change and is versioned independently of both `DAEMON_PROTOCOL_VERSION` and the sidecar's `describe.version`, the same way those two are independent of each other.

The corollary matters for implementation: **no method in this document may be optional.** A daemon that cannot serve `resizeWindow` is a broken daemon, not a reduced-capability one. Where the underlying platform genuinely can't do something, the proxied call returns `UNSUPPORTED_CAPABILITY` from the native surface and the child surfaces it to the model as a failed tool result — capability variance is handled where it actually lives, at the sidecar boundary, and never leaks into this protocol's shape.
