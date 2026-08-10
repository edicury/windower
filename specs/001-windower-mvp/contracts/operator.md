# Operator Contract

`packages/operator` (Phase 19, revised in Phase 21). The operator is a bounded, tool-using agent loop that turns one natural-language instruction into a sequence of `enumerateElements`/`captureFrame`/`performInput` calls against **one target** (Phase 22 made the element list the default percept and the frame the fallback). It adds no capability the sidecar protocol doesn't already express — every tool below maps 1:1 onto an existing daemon or sidecar method.

The operator has **no relationship to recording of any kind** (Phase 21 — see "Recording independence"). It operates a target and emits its own events; whether anything is recording the screen while it does so is not expressible in this contract.

## Inputs

An operator run is fully specified by four things and nothing else:

| Input | Shape | Notes |
|---|---|---|
| `task` | `string` | The natural-language instruction. |
| `target` | `CaptureTarget \| { targetId: string }` | **The same target selector `start_recording` takes** (`contracts/mcp-tools.md`, `data-model.md`). Not a new type — the operator resolves it through `enumerateTargets` exactly as capture does, and its `Rect` is what the bounds clamp is evaluated against. |
| model/provider config | `OperatorModels` — `{ planner: ModelConfig, executor?: ModelConfig }` (+ `baseUrl` per tier for `openai-compatible`) | See "Model tiers". `executor` defaults to `planner`. |
| guardrails/planning config | `{ maxSteps?, timeoutSeconds?, maxBatchActions?, maxReplans?, unbounded?, observe? }`, plus `secrets?: SecretRef[]` | See "Guardrails", "Observation policy", and "Secret refs". |

```ts
type OperatorRunOptions = {
  task: string;
  target: CaptureTarget | { targetId: string };
  models: { planner: ModelConfig; executor?: ModelConfig };   // Phase 22; executor defaults to planner
  secrets?: SecretRef[];
  guardrails?: {
    maxSteps?: number;
    timeoutSeconds?: number;
    maxBatchActions?: number;
    maxReplans?: number;                                       // Phase 22
    unbounded?: boolean;
  };
  observe?: "auto" | "ax" | "vision";                          // Phase 22, default "auto"
};
```

`run_operator` accepts exactly these members. There is **no** `sessionId` member and **no** `recording` member — both were removed in Phase 21, and with them the `sessionId`-vs-`recording` mutual-exclusivity refinement, which is now moot and **MUST** be deleted rather than kept as a no-op. Passing either is `INVALID_ARGS` by schema strictness, not by refinement.

## Recording independence (Phase 21, normative)

The operator **MUST NOT**:

1. know whether a recording exists;
2. start a recording;
3. stop a recording;
4. look up a recording (by id, by target, or by any other means);
5. route frames through a recording session;
6. carry a recording or session identifier for timeline correlation, or for any other purpose.

> **The same `OperatorRun` MUST behave identically whether the screen is being recorded or not.** Any observable difference between the two — a different code path, a different error, a different transcript, a different frame source visible to the model — is a contract violation.

The operator observes the screen with `captureFrame(target)` — the same target it was given — and **never** `captureFrame(recordingSession)`; there is no session-shaped frame source it could name. How Windower serves that frame is an unobservable implementation detail *below* the operator: the capture sidecar (`windower-capture-macos`) **MAY** satisfy it from an already-live `SCStream` instead of taking a one-shot capture (`contracts/screen-capture-exclusivity.md`, `contracts/sidecar-protocol.md` §frame sharing). That optimization is invisible to the operator and **MUST NOT** be surfaced to it as knowledge that a recording exists.

### Breaking change: the standalone convenience mode is removed

Phase 19 shipped a mode in which `run_operator` started, owned, and finalized its own recording (`recording?: { … , disabled? }`). **That mode is removed in Phase 21.** It is not renamed, not deprecated-but-retained, and not reachable by any flag.

This is a **breaking change to a shipped surface** and is documented as such deliberately, rather than dropped quietly. The rationale: standalone mode is a direct violation of prohibitions 2 and 3 above. Retaining it would mean the operator's behavior depends on whether it owns a recording — exactly the coupling Phase 21 exists to eliminate — and would keep a `RecordingSession` reachable from operator code paths forever. A convenience mode that can only be described as an exception to the invariant is evidence the invariant was not real.

**Migration.** A caller that previously used standalone mode issues two calls instead of one, per "Ownership" below: `start_recording(target)` then `run_operator(target, task)`, with the same `target`. The recording is finalized by the caller. `recording.disabled: true` callers simply drop the member — an operator run with no recording is now the only shape there is.

## Tool surface exposed to the model

The model only ever sees this closed set of tools. No shell, filesystem, or raw network tool is ever offered, regardless of provider or config.

| Tool | Params | Maps to |
|---|---|---|
| `observe_elements` | `{ role?: string, labelContains?: string, maxElements?: number }` | shapes the **next** observation's `enumerateElements` call; returns no payload inline (same mechanism as `screenshot`) |
| `click_element` | `{ ref: string, button?: "left"\|"right"\|"other" }` | sidecar `enumerateElements` (re-resolve) then `performInput` (`mouse_click`) at the element rect's center |
| `double_click_element` | `{ ref: string }` | sidecar `enumerateElements` then `performInput` (two `mouse_click` actions) |
| `type_into_element` | `{ ref: string, text: string }` — may contain `{{name}}` secret-ref placeholders | sidecar `enumerateElements` then `performInput` (`mouse_click` + `type_text`), after secret substitution |
| `scroll_element` | `{ ref: string, deltaX: number, deltaY: number }` | sidecar `enumerateElements` then `performInput` (`scroll`) |
| `screenshot` | `{ maxWidth?: number }` | sidecar `captureFrame` |
| `move_mouse` | `{ x: number, y: number }` | sidecar `performInput` (`mouse_move`) |
| `click` | `{ x: number, y: number, button?: "left"\|"right"\|"other" }` | sidecar `performInput` (`mouse_click`) |
| `double_click` | `{ x: number, y: number }` | sidecar `performInput` (two `mouse_click` actions) |
| `drag` | `{ fromX: number, fromY: number, toX: number, toY: number }` | sidecar `performInput` (`mouse_drag`) |
| `scroll` | `{ x: number, y: number, deltaX: number, deltaY: number }` | sidecar `performInput` (`scroll`) |
| `type_text` | `{ text: string }` — may contain `{{name}}` secret-ref placeholders | sidecar `performInput` (`type_text`), after secret substitution |
| `press_key` | `{ key: string, modifiers?: string[] }` | sidecar `performInput` (`key_press`) |
| `wait` | `{ ms: number }` | local sleep, no RPC (bounded by guardrails, see below) |
| `list_targets` | `{ kinds?: ("display"\|"window"\|"app")[] }` | sidecar `enumerateTargets` (via daemon) |
| `resize_window` | `{ targetId: string, bounds: Rect }` | sidecar `resizeWindow` (via daemon) |
| `plan` | `{ steps: string[], rationale?: string }` | no RPC — records a new `OperatorPlan` revision on the run (see "Execution model") |
| `checkpoint` | `{ expectation: string, outcome: "held"\|"failed-plan-sound"\|"failed-plan-invalid", detail?: string, visual?: boolean }` | no RPC — records the verification onto the current `OperatorStep` (see "Execution model"); `visual: true` declares that verifying this expectation needs a frame (see "Observation policy") |
| `done` | `{ summary: string }` | ends the run, no RPC — `OperatorRun.state` → `"succeeded"` |
| `fail` | `{ reason: string }` | ends the run, no RPC — `OperatorRun.state` → `"failed"` |

There is no tool that spawns a process, reads/writes the filesystem, or makes an HTTP request. The model cannot escape the tool surface above; anything the operator does to the machine happens through `performInput`/`captureFrame`/`enumerateTargets`/`resizeWindow`/`enumerateElements` — the same five sidecar-facing methods every other Windower interface (CLI, MCP, plugin) already uses.

**Element tools resolve, they do not trust.** A `ref` is not a coordinate the runtime accepts on faith. Every element tool: re-resolves the ref via `enumerateElements({ refs: [ref] })` immediately before acting, takes the returned rect's center, runs that coordinate through the **same** target-bounds clamp every pixel tool goes through (see "Guardrails"), and only then issues `performInput`. There is no element-based exemption from any guardrail. `AX_ELEMENT_STALE` from the re-resolve is returned to the model as that action's tool result and is **not** run-terminating — the next observation re-enumerates. The re-resolve itself is an observation and does not count against `maxBatchActions`; the action it precedes does.

**AX is a sensor, never an actuator.** Windower never invokes a platform accessibility *action* (`AXUIElementPerformAction`/`AXPress`/`AXSetValue` or their Windows/Linux equivalents), and `UIElement.actions` is informational only. Input is always synthesized — real cursor travel, real key events — because a recording of a UI that changes with no visible cause is not a demo. This is not a default that a flag may override: an operator whose input mechanism depended on whether someone wanted the run recorded would violate "Recording independence" directly.

## Observation policy (Phase 22)

The operator's default percept is the target's **accessibility element list** (`enumerateElements`), not a screenshot. Elements carry exact rects, so acting on one is a lookup rather than an estimate — and an estimated coordinate read off a downscaled PNG was the most common way a run wasted steps.

A frame is captured for a step only when at least one of these holds:

1. the model called `screenshot` on the previous turn;
2. `enumerateElements` returned nothing, returned fewer than the documented minimum useful count (currently 1 — i.e. an empty list), or returned `UNSUPPORTED_CAPABILITY` — i.e. the target is canvas, WebGL, custom-drawn, or otherwise accessibility-opaque;
3. the model declared its checkpoint `visual: true` on the previous step — "the badge turned green" is not an accessibility fact and no element list can answer it — which forces a frame on the *next* step (a checkpoint is verified against the observation that follows it, not the one that produced it);
4. the step is a **planner** turn — the initial plan and every escalation always ground in one frame alongside the element list, per "Model tiers" below, regardless of `observe`;
5. the run was started with `observe: "vision"`.

`observe: "ax"` is a hard override, not a reweighting of 1–4: none of them apply, ever, including the planner-turn grounding frame and a model-issued `screenshot` call (the tool still returns success — "attached to next observation" — but the request is silently dropped by the observation stage, since the whole point of `"ax"` is a run with a *provable* zero-frame transcript). A target with no usable elements and no `ui.elements` support under `"ax"` gets an explicit "no observation available this step" text message instead of the frame that `"auto"` would substitute — the one case where `"ax"` trades correctness for its no-capture guarantee, and why it is not the default.

The two percepts are not exclusive: a step may reason over both, and `OperatorStep.observations` records what it actually got. `observe` has three values — `"auto"` (the policy above, the default), `"ax"` (never capture a frame), and `"vision"` (always capture, i.e. pre-Phase-22 behavior).

Normatively:

- The choice of percept **MUST NOT** depend on whether anything is recording. An AX-observed step makes zero capture calls in both cases; a vision-observed step makes the same `captureFrame(target)` call in both cases (see "Recording independence").
- An element `ref` is valid only for the observation that produced it. The operator **MUST NOT** carry refs across steps as if they were stable identifiers, and **MUST NOT** cache an element list between steps — a stale list is a misclick with extra steps.
- A backend without `ui.elements` degrades to vision-only. That degradation surfaces exactly like every other capability gap — an `UNSUPPORTED_CAPABILITY` result the runtime reacts to — and **never** as a platform branch above the stdio line.

## Execution model — plan → execute → verify

The operator's execution model is:

```
task → plan → execute one or more actions → verify checkpoint → continue / replan only when necessary
```

Planning is an **explicit stage**, not behavior that emerges inside every observation/action turn. The pre-Phase-21 loop was observe → reason about the next tiny action → act → observe → rediscover the same context, which spends a model round trip per click and re-derives the task's structure from scratch every turn. An explicit plan is what removes that cost.

- The operator **MUST** produce a concise initial action plan before it begins manipulating the UI. Concretely: the first model turn of a run observes, then calls `plan` — and it **MUST NOT** emit any input tool (`move_mouse`, `click`, `double_click`, `drag`, `scroll`, `type_text`, `press_key`, `resize_window`) in a turn that precedes the run's first `plan` call. A run whose first turn acts without planning is a prompt-quality defect, not a protocol error: the runtime does not reject it (see "Guardrails" — nothing here is enforced by asking the model nicely, and nothing here needs the daemon to referee it either), but the transcript records `plan: undefined` and it is a test assertion in `packages/operator`'s suite that a nominal run has a revision-0 plan.
- The plan is **GUIDANCE, not an immutable script.** The operator **MAY** call `plan` again at any point to replace the current plan when observations invalidate its assumptions (the target app was already open, a login wall appeared, the navigation landed somewhere unexpected). Each call produces a new `OperatorPlan` revision; revisions are never edited in place and never deleted.
- The operator **SHOULD** replan only when an observation actually invalidates the current plan. Replanning on every step reintroduces exactly the per-action round trip this section exists to remove.
- A plan step is one line of natural language describing an intent, not a tool call. Plan steps are never executed mechanically — nothing in the runtime dispatches from `OperatorPlan.steps`.

Worked example. Task: *"Open Safari, navigate to Warroom, create an incident."* The revision-0 plan:

1. Activate/open Safari.
2. Navigate directly to the target URL.
3. Wait for Warroom to load.
4. Open Incidents.
5. Start incident creation.
6. Populate required fields.
7. Submit.
8. Verify the incident exists.

Note what the plan is doing: step 2 commits to the address bar rather than to hunting for a link, and step 8 is a verification checkpoint rather than an assumption that step 7 worked. Both are decisions worth making once, before acting, rather than rediscovering at each observation.

**Verification checkpoints.** Verification is a first-class stage of the loop, not a side effect of replanning:

```
plan → execute → observe → checkpoint → continue / replan
```

After each executed batch (below), the operator **MUST** obtain a fresh observation and check it against the outcome the plan expected at that point, recording the result with the `checkpoint` tool. A checkpoint has exactly three outcomes: the expectation held (continue with the plan), the expectation failed but the plan is still sound (retry or adjust within the current plan), or the expectation failed in a way that invalidates the plan (call `plan` again). Only the third is a replan.

The model **MUST** supply `expectation` and `outcome` explicitly, and `detail` where it adds information (typically what was observed instead). **Outcomes MUST NOT be inferred by the runtime** — in particular, "the turn replanned" is not a usable proxy for `failed-plan-invalid`, and its absence is not a proxy for `held`. The runtime has no semantic access to whether an expectation was met; only the turn that observed the screen does. Deriving the outcome would make `held` mean nothing more than "did not replan", which is not verification.

A checkpoint verifies **a meaningful plan step or action batch, after the resulting UI state has been observed** — it is *not* required after every individual action. A step that executed no batch (the opening observe-and-plan turn, say) verifies nothing, and a step with no checkpoint stays well-formed wherever this contract already permits it; `OperatorStep.checkpoint` is optional and `contracts/operator-loop-protocol.md` §Operator events makes it optional on the wire.

`OperatorCheckpoint` (`data-model.md`) is the single representation of a checkpoint — the `checkpoint` tool's params are that shape, and no second representation is introduced.

**Provider independence.** This model **MUST NOT** depend on any single vendor's features. The plan is carried by the `plan` tool call — an ordinary tool in the closed surface above — precisely because tool calling is the one capability every supported provider (`anthropic`, `openai`, `openai-compatible`) exposes identically. Extended-thinking blocks, provider-native "planning" modes, structured-output modes, and prompt-caching behavior **MUST NOT** be load-bearing for planning: `OperatorStep.reasoning` stays exactly what it already is, an optional best-effort capture of whatever rationale the provider happens to expose, and a provider that exposes none must still produce identical plan records.

**Prompt caching (Phase 22) is a pure optimization.** The runtime **MAY** mark the run-stable prefix as cacheable for providers that support it. As shipped, that means `cache_control` on the system prompt (built once before the loop and byte-identical every turn), and only for the `anthropic` provider — `promptCacheProviderOptions` (`providers.ts`) returns `undefined` for every other provider, which `run.ts` treats as "attach nothing." Tool-schema caching is not wired up: this package builds tool entries as plain `{ description, inputSchema }` records with no per-tool `providerOptions` hook in the installed AI SDK version, and the system prompt (~1.5 KB) is the larger, more clearly stable target, so it's what's cached now — extending the same mechanism to tool schemas and to other providers' cache-control shapes is a follow-up, not a correctness gap. Whatever the scope, the rule is unconditional: it **MUST** be skipped silently for a provider with no known mechanism, and loop behavior **MUST** be identical whether the cache hits, misses, or is ignored entirely. This amends the sentence above rather than excepting it: caching may reduce what a run costs, and may never change what a run does.

**Where the plan lives.** `OperatorRun.plan` is the current (highest-revision) `OperatorPlan`; the revision that a `plan` call produced is also recorded on the `OperatorStep` whose turn produced it, as `OperatorStep.plan`. The full plan history is therefore the ordered `step.plan` values in the transcript — there is no second history array to keep in sync. See "Transcript format" for both shapes.

## Action batching

A **batch** is the ordered sequence of action tool calls the model emits in a single turn. The loop executes them sequentially, in emission order, within one `OperatorStep`.

The execution contract **supports** short batches of deterministic actions between observations. The canonical good batch is:

```
activate Safari → press_key Cmd+L → type_text "<url>" → press_key Return → (observe)
```

Four actions, one observation, one model round trip. The pre-Phase-21 alternative was four observations and four round trips to reach the same known-in-advance state.

A batch **MUST** satisfy **all** of the following:

1. Every action in it is deterministic and locally sequential — the operator knows what each action does without seeing the result of the previous one.
2. No later action in the batch requires interpreting a changed UI (a new coordinate, a newly rendered control, a value read off the screen).
3. The target and keyboard focus are sufficiently known for the whole batch — typically because the batch itself establishes focus as its first action.
4. Every action in the batch is individually subject to the guardrails (bounds clamp, secret substitution, deadline, abort) — batching **never** relaxes a per-action check.

The operator **MUST NOT** batch interactions that depend on intermediate UI state: clicking a menu item that only exists after the menu opens, typing into a field whose position is not yet known, or anything gated on a network round trip completing. Those stay one action per observation.

After every batch the operator **MUST** obtain a fresh observation and verify the expected checkpoint before emitting the next batch. A batch that is not followed by a verification is a defect even if every action in it succeeded.

`maxBatchActions` (see "Guardrails") bounds batch length. It is a runtime limit, not a suggestion in the prompt.

### Batch failure semantics

Actions execute in order. When action *k* of *n* fails:

| Concern | Rule |
|---|---|
| Remainder | Actions *k+1…n* are **not** executed. There is no "continue past the failure" mode — the batch's premise (the UI is where we think it is) is exactly what a failure disproves. |
| Recording | Actions *1…k−1* are recorded in `OperatorStep.toolCalls` with their real results. Action *k* is recorded with `result: { error: { code, message } }`. Actions *k+1…n* are recorded with `result: { skipped: "BATCH_ABORTED" }`, so the transcript states which actions ran, which one failed, and which never ran — never inferred from array length. |
| Step accounting | The batch is **one** step. It consumed one step from `maxSteps` whether it executed 1 action or `maxBatchActions`, and a partial batch does not consume extra steps. Step cost is per observation/decision, not per action — that is the whole economic point of batching. |
| Run continuation | A *non-terminal* failure (`TARGET_NOT_FOUND`, `RESIZE_UNSUPPORTED`, `CAPTURE_FAILED`, `UNSUPPORTED_CAPABILITY`, `INPUT_UNSUPPORTED`) closes the step normally, feeds the error back to the model as that action's tool result, and the run continues at the next step with a fresh observation. The model treats it as a failed checkpoint per above. |
| Run termination | A *terminal* failure ends the run mid-batch, exactly as it does outside a batch: `INPUT_OUT_OF_BOUNDS` → `failed`, deadline → `timed_out`, abort → `aborted`, `maxSteps` → `failed`. The partial step is still recorded, with the skipped-action rows intact. Batching **MUST NOT** convert a terminal guardrail failure into a recoverable one. |
| Ordering | The guardrail check for action *k* happens immediately before action *k* is issued, not once for the whole batch up front. A batch is not a transaction and there is no rollback: actions *1…k−1* already happened to the real machine. |

Exceeding `maxBatchActions` is `OPERATOR_BATCH_LIMIT_EXCEEDED`: the over-limit action and everything after it are skipped as above, the step closes, and the run continues — an over-long batch is a model mistake worth correcting, not worth ending the run over.

## Model tiers (Phase 22)

A run uses **two** model tiers, `OperatorModels = { planner, executor }` (`data-model.md`). Planning is the expensive judgement and happens once; executing "click the element labeled Create Incident, whose rect you were just handed" is nearly mechanical and does not need the same model.

| Stage | Model | Percept | Tools |
|---|---|---|---|
| Plan | `planner` | element list **and** one grounding frame — the plan is written once and is worth an image | full surface, including `plan` |
| Execute | `executor` | the step's observation per "Observation policy" | full surface **minus `plan`** |
| Escalate | `planner` | compact run summary plus a fresh frame | full surface, emits a new plan revision |

- Only the planner may create or revise a plan. Removing `plan` from the executor's surface is what makes that structural rather than a prompt request.
- **Escalation edges**, exhaustively: a `failed-plan-invalid` checkpoint; or a second consecutive `failed-plan-sound` on the same plan step (one retry within the plan is the executor's, the second is an admission it is not converging). Nothing else escalates.
- Escalations are bounded by `maxReplans` (see "Guardrails"). Exhausting it ends the run with `OPERATOR_MAX_REPLANS_EXCEEDED` rather than letting a non-converging run quietly consume the whole step budget, which is what happens today.
- `executor` defaults to `planner`. **A run configured with a single `--model` MUST behave exactly as a pre-Phase-22 single-model run** — same percept policy aside, same plan, same tools per stage resolving to one model. This is a test assertion, not an intention.
- Tiers are independent `ModelConfig`s over the one provider registry: they may use different providers, and either may be `openai-compatible`, so a fully-local two-tier run is possible.

## Model configuration

`--model <provider>:<model>` sets both tiers; `--planner-model` / `--executor-model` set one each. E.g.:

- `anthropic:claude-sonnet-5`
- `openai:gpt-5`
- `openai-compatible:llama-3.3` with `--base-url <url>` for local/self-hosted endpoints (e.g. Ollama, LM Studio)

Provider selection is a thin dispatch over the Vercel AI SDK (`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/openai-compatible`) — swapping the config string swaps the model with zero code change in `packages/operator`.

API keys are resolved from an environment variable named per-provider in config (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), **never** accepted as a CLI flag — and this holds per tier, so a run whose tiers use two providers requires both env vars present — a key typed on the command line ends up in shell history and process listings, which this contract explicitly avoids.

Defaults (provider, model, base URL, guardrail values) live in a new `operator` block of `WindowerConfig` (`~/.windower/config.json`), read/written via the existing `windower config get|set` command — no separate config file.

## Secret refs

`--secret <name>=<source>:<ref>`, repeatable. `source` is one of:

- `env` — `<ref>` is an environment variable name, resolved from the daemon's environment.
- `keychain` — `<ref>` is a macOS Keychain item name (post-MVP backends resolve their own OS credential store equivalents).
- `literal` — `<ref>` is the value itself, inline on the command line. Discouraged; using `literal` logs a warning (shell history exposure) but is not blocked, for quick local testing.

**Substitution boundary** (load-bearing, applies everywhere a secret can flow):

1. The model's prompt and every tool-call argument it produces only ever contain the placeholder token `{{name}}` — the real value is never included in anything sent to or returned from the model.
2. Real-value substitution happens exactly once, inside the `type_text` tool handler, immediately before the `performInput` RPC call is made — the substituted value exists in process memory only as long as it takes to issue that one RPC call.
3. A redaction filter runs over the operator transcript, per-step records, daemon logs, and sidecar logs before any of them are persisted to disk — every known secret value is replaced with `{{name}}` (or a fixed redaction marker if the name itself is unknown at filter time) wherever it would otherwise appear.

## Guardrails

All guardrails are enforced by the `packages/operator` runtime, not requested via the model's system prompt — the model is never trusted to self-limit.

| Guardrail | Default | Override |
|---|---|---|
| `maxSteps` | 40 | `--max-steps <n>` |
| `timeoutMs` (wall-clock) | 300000 (5 min) | `--timeout <s>` |
| `maxBatchActions` | 8 | `--max-batch <n>` |
| `maxReplans` (Phase 22) | 3 | `--max-replans <n>` |
| Target-bounds clamp | every coordinate in every input tool call is checked against the recorded target's `Rect` before any RPC is issued — including a coordinate derived from a resolved element rect, which gets no exemption; an out-of-bounds coordinate ends the run rather than being silently moved | `--unbounded` disables the check |
| Kill switch | `windower operate abort <runId>` (CLI) / `abort_operator_run` (daemon RPC / MCP) | — |
| Tool surface | fixed at the table above — no filesystem, process-spawn, or network tool is ever offered to the model, in any configuration | not overridable |

Exceeding `maxSteps`, or an out-of-bounds coordinate under a non-`--unbounded` run, ends the run with `state: "failed"` and a structured error (`INPUT_OUT_OF_BOUNDS` for the bounds case), the same error taxonomy used by the sidecar protocol. Exceeding `timeoutMs` ends it with `state: "timed_out"` — a distinct terminal state in `data-model.md`'s `OperatorRunState`, so a wall-clock stop is distinguishable from a genuine failure.

`maxReplans` bounds how many times the planner may re-enter and emit a new plan revision (see "Model tiers"); exceeding it ends the run with `state: "failed"` and `OPERATOR_MAX_REPLANS_EXCEEDED`. It is deliberately terminal: a run on its fifth plan is not converging, and the failure mode it replaces — silently exhausting `maxSteps` — costs the caller the full step budget to learn the same thing.

`maxBatchActions` bounds how many action tool calls one turn may execute (see "Action batching"); exceeding it is `OPERATOR_BATCH_LIMIT_EXCEEDED` and is **not** run-terminating. Like every other guardrail here, it is enforced by the runtime — the prompt describes it so the model can plan around it, and the runtime is what actually stops it.

## Ownership — the caller orchestrates, the operator owns nothing but its run (Phase 21)

Recording and Operator are **independent capabilities**; the **calling coding agent** is the orchestrator. Windower models no workflow of its own. The canonical recipe — a caller-side pattern documented in `plugins/claude-code/SKILL.md`, not an internal Windower sequence, and one other agents are free to compose differently:

```
start_recording(target)
run_operator(target, task)
wait for the operator run to reach a terminal state
stop_recording(session)
```

Normatively:

- Recording does **not** know about Operator. Operator does **not** know about Recording. **Neither owns the other's lifecycle.** Every call above is the caller's, issued in its own order, with its own error handling.
- The two calls share only a `target` — the same selector value, passed twice, to two independent capabilities. A shared `target` is **not** a link between the two: nothing correlates them by it, and passing different targets is legal (and merely means the recording shows something other than what the operator is driving).
- The orchestrator learns the run finished by polling `get_operator_run`. It **MUST NOT** be able to learn it any other way, and in particular never by reading something the operator wrote onto a session.
- A `RecordingSession` **MUST NOT** know what it is recording — a human, Windower Operator, Claude Code, Playwright, some other agent, or nothing at all. No field, state, or code path on the capture side may branch on the existence of an operator run. A reverse dependency from Capture onto Operator is a contract violation, not an optimization. The reverse dependency is equally prohibited: see "Recording independence".
- Windower deliberately does **not** model recording as an intelligent agent. There is no `RecordingAgent` concept and none is to be introduced. **A Claude Code subagent managing recording lifecycle is an implementation detail of the Claude Code skill, not a Windower domain concept.**
- The model **MUST** hold for orchestrators that are not Claude Code: a shell script, a CI job, a different agent framework, or a human at a terminal. Anything that only makes sense because the caller happens to be an agent belongs in the caller, not here.

### Correlating the two streams

Operator events (below) and the recording's `EventTimeline` are both wall-clock stamped, so anyone holding both can line them up. **The caller already knows which operations it initiated together**, so nothing in Windower correlates them on its behalf:

- No Windower component exists for this. There is no correlator, no joining record, and no persistent state that outlives either capability. A persistent `DemoRun`/`WorkflowRun` model **MUST NOT** be introduced.
- Correlation **MUST NOT** require either capability to reference the other. No identifier of one may appear in the other's inputs, outputs, records, or persisted state.
- If Windower itself ever needs internal event-stream correlation, it will be designed for the **rendering** problem specifically — never by making the Operator aware of Recording.

## Operator events

A run emits a single ordered stream of **structured events**, and it is the run's only output channel besides its terminal state. There are exactly five kinds. **No event kind carries, or may be extended to carry, a recording or session identifier** — see "Recording independence".

| Kind | Emitted when | Payload |
|---|---|---|
| `plan` | the model calls `plan` | `{ revision, steps, rationale? }` — the `OperatorPlan` the daemon just stamped |
| `action` | each action tool call in a batch resolves | `{ stepIndex, name, args, result? }` — `args` already secret-redacted; `result` is the real result, an `{ error }`, or `{ skipped: "BATCH_ABORTED" }` |
| `checkpoint` | the operator verifies a batch against the plan's expectation | `{ stepIndex, expectation, outcome, detail? }` with `outcome: "held" \| "failed-plan-sound" \| "failed-plan-invalid"` — the three outcomes of §Execution model, verbatim |
| `narration` | the model produces human-readable commentary for a step | `{ stepIndex, text }` — best-effort, provider-independent; absent for providers that expose no rationale, exactly like `OperatorStep.reasoning` |
| `result` | the run reaches a terminal state | `{ state, summary?, error? }` — emitted exactly once, last |

```ts
type OperatorEvent = {
  runId: string;               // the OperatorRun this event belongs to — the ONLY id an event carries
  seq: number;                 // monotonic from 0, per run
  tMs: number;                 // ms since run start
  kind: "plan" | "action" | "checkpoint" | "narration" | "result";
  payload: unknown;            // per the table above
};
```

Normative properties:

- Events **MUST** be emitted in `seq` order, and `tMs` **MUST** come from the daemon's clock (the same `startedAtMs` the loop child is handed), so the stream is alignable with any other wall-clock stream without either side knowing the other exists.
- A `result` event **MUST** be the last event of a run, and **MUST** be emitted for every terminal state including `OPERATOR_LOOP_CRASHED` — the daemon synthesizes it when the child dies without reporting one.
- `narration` is the only optional kind. A run that emits none is well-formed.

**How they surface.** The event stream is not a second source of truth alongside the transcript — it is a projection of it:

- `plan` → `OperatorRun.plan` (current revision) and `OperatorStep.plan` (the revision's own step).
- `action` → the corresponding row of `OperatorStep.toolCalls`.
- `checkpoint` → `OperatorStep.checkpoint`.
- `narration` → `OperatorStep.reasoning`.
- `result` → `OperatorRun.state` / `endedAt` / `error`, and the `done`/`fail` summary → `OperatorRun.summary`.

A consumer that polls `get_operator_run` therefore sees every event's content without subscribing to anything, which is why Phase 21 adds no push/event-stream transport (`contracts/mcp-tools.md`). The ordered stream exists so a caller holding both handles can line the events up (above) without re-deriving ordering from the transcript.

## Transcript format

Written to `~/.windower/operator-runs/<runId>/transcript.json`, with observation frames in `~/.windower/operator-runs/<runId>/frames/`. The transcript is **operator-owned storage**: it is not written next to a video file, because locating a video file would require the operator to know a recording exists and to look it up — both prohibited. An orchestrator that wants the two artifacts side by side copies or symlinks them itself, using the two paths it already holds.

`OperatorRun.transcriptPath` is the run's own record of where it wrote. No manifest field points at it and no `OutputManifest` member is required for it — a pointer from the capture side to an operator artifact is the same reverse dependency §Ownership prohibits.

The transcript is exactly the `OperatorRun` / `OperatorStep` / `OperatorPlan` shape defined in `data-model.md` — that file is the single source of truth for these types and this contract does not redefine them, the same way it doesn't redefine `Rect` or `CaptureTarget`. Reproduced here for reference only:

```ts
type OperatorRunState = "pending" | "running" | "succeeded" | "failed" | "aborted" | "timed_out";

type OperatorRun = {
  id: string;                  // uuid
  state: OperatorRunState;
  task: string;                // the natural-language instruction
  target: CaptureTarget;       // the resolved target this run operates — same selector shape start_recording takes
  models: OperatorModels;      // resolved planner/executor tiers; one --model records the same config twice
  plan?: OperatorPlan;         // the CURRENT plan revision; absent until the first `plan` call
  steps: OperatorStep[];
  startedAt: string;           // ISO 8601
  endedAt?: string;
  summary?: string;            // the `done`/`fail` summary; absent on a run that crashed without reporting one
  error?: { code: string; message: string };
  transcriptPath?: string;
};

type OperatorPlan = {
  revision: number;            // 0 for the initial plan, +1 per replan; never reused, never edited in place
  steps: string[];             // ordered, one concise line of intent per planned step — never dispatched mechanically
  rationale?: string;          // why this revision replaced the previous one; conventionally absent at revision 0
  atStepIndex: number;         // the OperatorStep.index whose turn produced this revision
  tMs: number;                 // ms since run start
};

type OperatorStep = {
  index: number;
  observations: ObservationRef[];  // what this step reasoned over — elements, a frame, or both; never inlined
  toolCalls: Array<{ name: string; args: unknown; result?: unknown }>; // secrets already redacted to {{name}}
  plan?: OperatorPlan;         // set only on a step whose turn called `plan`; the ordered step.plan values are the full history
  checkpoint?: { expectation: string; outcome: "held" | "failed-plan-sound" | "failed-plan-invalid"; detail?: string; visual?: boolean };
  reasoning?: string;          // model's stated rationale for this step, if the provider exposes it
  tMs: number;                 // ms since run start
};
```

`OperatorRun.plan` is always the highest-revision `OperatorPlan` and is redundant with the last `step.plan` by construction — it exists so a consumer polling `get_operator_run` reads the current plan without walking the transcript. There is no separate plan-history array; the ordered `step.plan` values *are* the history, which keeps replanning impossible to record inconsistently.

`toolCalls[].result` for an action skipped by a batch abort is the literal `{ skipped: "BATCH_ABORTED" }` (see "Batch failure semantics"), which is why a skipped action is still a row rather than a missing one.

`observations` points at what the step looked at, stored alongside the transcript rather than inlined — keeps `transcript.json` small and diffable. Both kinds are content-addressed: frames as `<sha256-prefix>.png` under the run's `frames/`, element snapshots as `<sha256-prefix>.json` under `observations/`, so a ref carries the content's hash as well as its location. Counting `kind` across a transcript is how "did this run avoid capturing frames" is answered — from the record, not from logs. It replaces Phase 19's single `observationRef: string`; see `data-model.md` for the full breaking-change note. Stated here too since it's a wire-format break, not an additive one: a transcript written before Phase 22 has a bare `observationRef: string` on each step, not an `observations` array, and it is **not** migrated — it is a read-only artifact under the shape it was written in, the same treatment Phase 21 gave pre-Phase-21 `OperatorRun` records when `target` became required. `toolCalls[].args` reflects exactly what the model saw and sent, i.e. secret placeholders (`{{name}}`), never resolved values — this is the same document the redaction filter (see "Secret refs" above) has already run over before it's written.
