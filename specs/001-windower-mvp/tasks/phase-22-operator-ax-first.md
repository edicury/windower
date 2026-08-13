**Superseded by Phase 24 — the Operator was removed.** Kept for historical record only.

## Phase 22 — Operator: AX-First Observation and the Planner/Executor Split (v1.5)

**Goal:** Make an operator run cheap and fast enough to be boring. Today a run that opens Safari, types a URL, and clicks through a form costs several dollars and burns the whole step budget. This phase changes what the operator *looks at* (a compact accessibility-element list instead of a screenshot, on every step where that is sufficient) and *who does the thinking* (a strong model plans once, a cheap model executes each step, and the strong model re-enters only when a checkpoint invalidates the plan) — by freezing a new capture-free observation method on the **control** surface first, per this repo's protocol-before-platform rule.

**This phase adds no new architectural component.** It adds one sidecar method, one capability flag, five model-facing tools, and a second `ModelConfig` slot. It does not add a process, a package, a cache layer, a router, or an orchestration surface. See the YAGNI section for the explicit list of things this phase must not become.

### Context / why now

Phase 21 formalized `plan → execute → verify` and shipped action batching. It did not touch the two things that actually dominate an operator run's cost and latency. Measured against the shipped code this session:

1. **A PNG is captured on every single step, unconditionally.** `packages/operator/src/run.ts:276` calls `deps.captureFrame({ format: "png", maxWidth: 1280 })` at the top of every loop iteration — after a `wait`, after a no-op turn, after a turn that only called `plan`. Nothing skips it, nothing caches it. Up to three images live in the context window at once (`MAX_RETAINED_IMAGES = 3`, `run.ts:45`); older ones are replaced by the text stub `"[earlier screenshot omitted from context]"`, but the surrounding history is never trimmed.

2. **The model's only percept is pixels.** `packages/operator/src/prompt.ts:62` states it outright: "Everything you know about the screen comes from that image." Every coordinate the model emits is an *estimate* read off a downscaled screenshot. A misestimate is not a cheap mistake — a misclick costs a full observe → reason → act round trip to notice and another to correct, and it is the single most common way a run burns its step budget. The only structured percept that exists is `list_targets`, which is window-level (`CaptureTarget`: id, title, bounds) and says nothing about what is *inside* a window.

3. **Nothing is cached.** There is no `cache_control`, no `providerOptions`, and no `anthropic-beta` header anywhere in the repository. The ~1,500-token system prompt (`prompt.ts:19`, byte-stable for the whole run — it is built once at `run.ts:210`) and ~2.6 KB of tool-schema descriptions (`tools.ts:111-146`) are re-sent uncached on every one of up to 40 turns.

4. **One model does everything.** `--model` selects a single `ModelConfig` used identically for producing the plan, for deciding which pixel to click, and for stating whether a checkpoint held. Deciding "click the button labeled Create Incident, whose rect I was just handed" does not need the model that decided the eight-step plan.

Live Phase 21 baselines, from `STATUS.md`: three real runs at `--max-steps 30` consumed **29 / 30 / 29** steps. Steps are the binding constraint, and each step is one full-strength model call carrying an image.

This phase is the deferred idea recorded at `STATUS.md`'s "Next session" item 4, promoted to a real phase with the open questions settled. Two things in the repo already sanction it: `spec.md` §2.2 describes the operator as driving "at the pixel/**AX** level", and `AXUIElement*` already lives on the **control** surface in `native/macos/Sources/WindowerControlCore/WindowControl.swift` with **zero** ScreenCaptureKit linkage.

### Reasoning — the governing principle

> **An observation should cost what the question is worth.** "Where is the button labeled Create Incident?" is a structured question with an exact structured answer the OS already holds. Rendering that answer into 1280 pixels of PNG, shipping it to a frontier model, and asking it to guess coordinates back out is an expensive way to read a number the accessibility API will hand over for free.

Three consequences follow, and they are the whole phase:

- **Vision becomes the fallback, not the default.** An AX element list for a typical app window is 1–3 KB of JSON against ~200 KB of PNG, and it carries *exact* rects rather than estimates. But it is genuinely insufficient for canvas, WebGL, Electron chrome, some web content, and for any checkpoint whose expectation is visual ("the badge turned green" is not an AX fact). Hybrid, never replacement.
- **Observation moves off the capture surface entirely.** `enumerateElements` touches no ScreenCaptureKit symbol and takes no `~/.windower/capture.lock`. An AX-observed step makes **zero** capture calls, which further decouples Operator from Capture (`contracts/operator.md` §Recording independence) and cuts the rate at which anything on the machine pokes `SCShareableContent` — the exact class of pressure Phase 21 exists to relieve.
- **Planning and executing are different jobs and deserve different models.** The plan is written once from a rich observation and is the expensive judgement. Executing a plan step against a labeled element list is nearly mechanical. Escalation back to the planner is what keeps this honest: a cheap executor that cannot make progress must be able to hand the problem back, not thrash.

What this phase deliberately does **not** conclude: that AX should also *act*. See the settled decisions.

### Settled decisions (do not relitigate during implementation)

1. **Observe via AX, act via CGEvent.** AX resolves an element to an exact pixel `Rect`; the click is still synthesized at that rect's center through `performInput`. **No `AXPress`/`AXSetValue`/`AXConfirm` action path is added, in this phase, behind a flag, or otherwise.** Rationale: Windower's output is a *recording*. An `AXPress` mutates the UI with no cursor travel and no typing animation, producing a demo video in which things happen for no visible reason. A flag would be worse — it would make the operator's observable behavior depend on whether someone wanted the run recorded, which is precisely the coupling `contracts/operator.md` §Recording independence forbids. AX is a **sensor** in Windower, never an actuator.

2. **The observation is a compact interactable element list, not a full AX dump and not a query-only API.** A full tree is mostly layout scaffolding and would trade an expensive image for an expensive JSON blob. A pure `find_element(label)` API is cheaper still but blinds the model — it cannot see what is available and must guess labels, which is the misclick problem in a new costume. The middle is a filtered, depth-capped, count-capped list of actionable and labeled elements, each with a stable ref and an exact rect.

3. **Two model tiers, planner and executor, with escalation.** The executor never gets the `plan` tool; only the planner can create or revise a plan. A run configured with a single `--model` sets both tiers to it and **MUST** behave exactly as today.

4. **Prompt caching is a pure optimization and MUST NOT be load-bearing.** This is an amendment to, not an exception to, `contracts/operator.md` §Provider independence, which currently forbids caching from being load-bearing for planning and is silent on caching as an optimization. Behavior must be identical when the provider ignores the cache directive entirely.

5. **Token and dollar accounting are out of scope.** `generateText`'s `usage` stays unread and `OperatorStep` gains no token fields. **Consequence, stated so no one is surprised by it later:** this phase can prove *fewer model calls*, *fewer steps*, *fewer captured frames*, and *lower wall-clock*, and cannot prove a dollar figure end to end. Every exit criterion below is written against a countable, and a per-run cost metric is left to a future phase that wants to design it properly (including where it is surfaced, given `spec.md` §7's no-telemetry rule).

### YAGNI — what this phase must not turn into

Phase 22 originated from a concrete complaint: a trivial task costs several dollars and hits the step ceiling. **Make the observation cheap, split the model tiers, and stop.** The following are forbidden here, and a future reader should treat their reappearance as scope creep to be reverted, not as progress:

- 🔵 **No AX action path.** No `AXPress`, `AXSetValue`, `AXConfirm`, `AXShowMenu`, or any other `AXUIElementPerformAction`. See settled decision 1.
- 🔵 **No `AXObserver`, no notification subscriptions, no element watching.** The observation is pull-based, once per step. A push channel would need a new notification kind, a new lifecycle, and would make the observation stream depend on timing — for no benefit the pull path doesn't already give.
- 🔵 **No cross-step AX caching.** Each step's observation stands alone. A cached tree that goes stale is a misclick with extra steps.
- 🔵 **No DOM or browser automation.** `spec.md` §2.2's non-goal is unchanged: Windower ships no browser engine and is not a Playwright replacement. Web content is exactly the case where vision fallback earns its keep.
- 🔵 **No third model tier and no per-tool model routing.** Two tiers, one escalation edge.
- 🔵 **No deterministic plan compiler.** A planner that emits a typed action script the runtime replays without a model call per step was evaluated and rejected: it is brittle on any UI that renders asynchronously, and its failure mode (silently acting on a stale premise) is worse than the cost it saves. Plan steps remain natural-language intent, never dispatched mechanically (`contracts/operator.md` §Execution model).
- 🔵 **No history compaction or summarization pass.** Out of scope this phase; the AX-observation and image-skipping changes are what shrink the context, and a summarizer would be a second, independently-failing thing to debug on top of them.
- 🔵 **No cost telemetry, no metrics endpoint, no phone-home.** `spec.md` §7 stands unchanged.
- 🔵 **No element-based bounds-clamp exemption.** An element rect is still checked against the target's `Rect` like any model-supplied coordinate. AX is not a trusted source that bypasses guardrails.

### Protocol (first — per `CLAUDE.md`, fix the contract before implementing)

- 🔵 Add one method to `contracts/sidecar-protocol.md`'s **control-surface** method table, in the existing `Method | Params | Result | Required capability` style:

  | Method | Params | Result | Required capability |
  |---|---|---|---|
  | `enumerateElements` | `{ target: CaptureTarget, refs?: string[], filter?: "interactable"\|"all", maxDepth?: number, maxElements?: number }` | `{ elements: UIElement[], generation: string, truncated: boolean }` | `ui.elements` |

- 🔵 Document `refs` as the **freshness path**, and document why there is no second method: passing `refs` re-reads exactly those elements' current attributes and bounds instead of walking the tree, so `click_element` can re-resolve a ref immediately before acting in one round trip. A separate `resolveElement` method would be the same call with a narrower signature.
- 🔵 Add capability string `ui.elements` to the `describe` capability list, and to the control-surface sentence in §Handshake (which currently enumerates `input.mouse`/`input.keyboard`/`window-control` as the complete control set). Absent on any backend that cannot walk a UI tree — same shape as `window-control: false` under Wayland.
- 🔵 Add error code `AX_ELEMENT_STALE` to the error taxonomy: a supplied `ref` no longer resolves to a live element. **Non-terminal** — the operator re-enumerates and continues; it is not a run-ending condition.
- 🔵 State explicitly in the control-surface section that `enumerateElements` is **capture-free**: it links no ScreenCaptureKit symbol, takes no `~/.windower/capture.lock`, and is servable concurrently by any number of control-surface processes, consistent with `contracts/screen-capture-exclusivity.md`'s "any number of control-surface processes MAY run concurrently."
- 🔵 Add a §Platform notes bullet: `enumerateElements` requires the **same** Accessibility TCC grant `performInput` and `resizeWindow` already require and already report via `getPermissions`. **No new permission kind, no `PermissionReport` schema change** — the same conclusion §Platform notes already records for `CGEventPost`.
- 🔵 `contracts/operator-loop-protocol.md`: add `enumerateElements` to the child→daemon method list and to the proxied-subset list. Per that document's §No capability negotiation ("No method in this document may be optional"), it is **mandatory on the wire**; per-platform availability surfaces to the model only as an `UNSUPPORTED_CAPABILITY` tool result from the native surface. Not servable outside an open step (`NO_OPEN_STEP`). It is an **observation, not an action**, and therefore does **not** increment `actionsInStep` — the same rule `captureFrame`/`enumerateTargets` already follow.
- 🔵 `research.md` §2: new `enumerateElements (Phase 22)` row. macOS — full, `AXUIElementCopyAttributeValue(kAXChildrenAttribute)` plus `kAXRoleAttribute`/`kAXSubroleAttribute`/`kAXTitleAttribute`/`kAXValueAttribute`/`kAXEnabledAttribute`/`kAXPositionAttribute`/`kAXSizeAttribute`, same Accessibility TCC grant as `performInput`. Windows — full, UI Automation (`IUIAutomationElement`, `TreeWalker`, `ElementFromPoint`), which the `resizeWindow` row already names as the modern-app path. Linux — full under X11 via **AT-SPI2** (`libatspi`, the same bus screen readers use); **gap under native Wayland**, where AT-SPI is not universally reachable and there is no portal equivalent → capability flag `ui.elements: false`, exactly the shape of the existing `window-control`/`eventTimeline`/`input.*` Wayland gaps in that table.
- 🔵 `spec.md` §5: add the acceptance rows this phase's exit criteria trace to (see Exit criteria), so they can use the standard `Matches spec.md acceptance item: … (Phase 22)` form.

### Core schemas (`packages/core`)

- 🔵 New `UIElement` in `data-model.md` and a matching Zod schema in `packages/core/src/schemas/`:

  ```ts
  type UIElement = {
    ref: string;          // opaque, stable within one `generation`; never a memory address
    role: string;         // normalized cross-platform role, e.g. "button" | "textfield" | "link" | "menuitem" | "row" | "checkbox"
    subrole?: string;     // platform-native refinement when it disambiguates, e.g. macOS "AXSearchField"
    label?: string;       // accessible name — title, label, or description, whichever the platform exposes
    value?: string;       // current value for fields/toggles, truncated to a documented max length
    bounds: Rect;         // PIXELS, global top-left-origin Quartz space — same space InputAction uses
    enabled: boolean;
    focused?: boolean;
    actions?: string[];   // advertised, informational only — Windower never invokes them (see YAGNI)
    parentRef?: string;   // flat list + parent pointer, NOT nesting
  };
  ```

- 🔵 Document why the list is **flat with `parentRef`** rather than nested: it serializes smaller, it is stable to truncate (a nested tree cut at a depth limit produces orphaned subtrees), and the model reconstructs hierarchy only if it needs to.
- 🔵 `role` is a **normalized** vocabulary, not raw `AXRole` strings — the same reason every other cross-platform value in `data-model.md` is normalized. The macOS mapping (`AXButton` → `button`, `AXTextField`/`AXTextArea` → `textfield`, and so on) lives in the sidecar, below the stdio line. Unmapped roles pass through as `"other"` with the native role in `subrole`.
- 🔵 `bounds` in **pixels**, per `CLAUDE.md`'s units rule. AX reports points; the sidecar converts using the same per-display scale math `InputCoordinateSpace` already implements for `performInput` (`native/macos/Sources/WindowerControlCore/InputSynthesis.swift:266-339`) — reuse it, do not re-derive it. A points-vs-pixels bug here would land clicks at half-coordinates on Retina.
- 🔵 New `ObservationRef` in `data-model.md`, replacing `OperatorStep.observationRef: string` with `OperatorStep.observations: ObservationRef[]`:

  ```ts
  type ObservationRef =
    | { kind: "frame"; ref: string }      // content-addressed PNG in <runId>/frames/
    | { kind: "elements"; ref: string };  // content-addressed JSON in <runId>/observations/
  ```

  Record this as a **breaking transcript-schema change**, documented deliberately rather than worked around with a parallel field — the same way Phase 21 documented removing standalone mode. A reader of an older transcript sees a bare string; state that older transcripts are read-only artifacts and are not migrated.
- 🔵 Element snapshots are content-addressed next to frames: `~/.windower/operator-runs/<runId>/observations/<sha256-prefix>.json`. Same convention, same reason (`transcript.json` stays small and diffable).
- 🔵 `WindowerConfig.operator` gains `defaultPlannerModel?` and `defaultExecutorModel?` alongside the existing `defaultModel?`. Resolution order for each tier: explicit flag → tier-specific config default → `defaultModel` → error. While editing this block, close the pre-existing drift noted in `contracts/operator.md`: `guardrailDefaults` is missing `maxBatchActions`, which the guardrail table has had since Phase 21.
- 🔵 New guardrail `maxReplans`, default **3**, in `data-model.md`, `OperatorRunOptions.guardrails`, and the `contracts/operator.md` guardrail table. Bounds planner escalations per run. Exceeding it ends the run with `state: "failed"` and code `OPERATOR_MAX_REPLANS_EXCEEDED` — a run that has replanned four times is not converging, and the current failure mode is that it silently eats the whole step budget instead.
- 🔵 Zod schemas plus method-table rows for `enumerateElements` in `packages/core/src/protocol/methods.ts` (`SIDECAR_METHODS`, `SIDECAR_METHOD_SCHEMAS`, `CapabilitySchema`), and the client method on `SidecarClient` (`packages/core/src/protocol/sidecar-client.ts`).
- 🔵 `packages/core/src/protocol/fake-sidecar.ts`: serve `enumerateElements` from an injectable fixture element list, and make `ui.elements` removable from `DEFAULT_CAPABILITIES` so the vision-fallback path is testable in CI without TCC.
- 🔵 `OperatorDeps` (`packages/core/src/operator/types.ts:27`) gains a fifth member, `enumerateElements`. Update `contracts/operator.md`'s "the same four sidecar-facing methods" sentence to five.

### Native macOS (`native/macos`)

- 🔵 New `native/macos/Sources/WindowerControlCore/ElementQuery.swift`, sitting alongside `WindowControl.swift` on the control surface. It imports `ApplicationServices` only — **it must not import, link, or transitively pull in ScreenCaptureKit**, and the existing `otool -L` build check is what proves that after this file lands.
- 🔵 Reuse `WindowControl.swift`'s existing app→window resolution (`AXUIElementCreateApplication` + `kAXWindowsAttribute` + the geometry-based `bestMatchIndex` correlation at `WindowControl.swift:192-220`) to find the AX window for a `CaptureTarget`. Do not write a second correlation strategy; if the existing one needs to be shared, extract it rather than copy it.
- 🔵 Walk `kAXChildrenAttribute` breadth-first from the resolved window, bounded by `maxDepth` (default 12) and `maxElements` (default 200, hard cap 500). Set `truncated: true` when either bound cut the walk — never truncate silently. Breadth-first, not depth-first, so a truncated walk keeps the shallow, usually-more-actionable elements.
- 🔵 `filter: "interactable"` (the default) keeps elements that are either actionable (advertise a non-empty `AXActions`, or carry an interactable role) or carry a non-empty accessible name; `filter: "all"` disables the filter but is still subject to `maxDepth`/`maxElements`. Purely-decorative groups, splitters, and unlabeled static text are what the default filter is for.
- 🔵 Ref generation and staleness: a `generation` token is minted per full walk, and each `ref` is `<generation>:<index>` backed by a process-local table of retained `AXUIElement` handles for that generation. A `refs` request against a stale or unknown generation, or against an element whose handle no longer resolves, returns `AX_ELEMENT_STALE`. Retain at most the two most recent generations, so a long run does not accumulate handles.
- 🔵 Fail fast with `PERMISSION_DENIED` when `AXIsProcessTrusted()` is false, exactly as `InputSynthesis.perform` already does (`InputSynthesis.swift:387-399`).
- 🔵 Advertise `ui.elements` in `windower-control-macos`'s static capability list (`native/macos/Sources/windower-control-macos/main.swift:39-43`) and dispatch the new method (`main.swift:94-144`).
- 🔵 XCTest coverage in `WindowerControlCoreTests`: role normalization, points→pixels conversion on a scale-2 display, `maxDepth`/`maxElements` truncation flags, stale-ref behavior across generations, and the interactable filter.

### `packages/operator`

- 🔵 **Observation policy**, replacing the unconditional `captureFrame` at `run.ts:276`. Each step observes via `enumerateElements` by default. A PNG is captured only when at least one of these holds:
  - the model called `screenshot` on the previous turn (existing `nextFrameMaxWidth` mechanism, `executor.ts:95`);
  - `enumerateElements` returned an empty list, or fewer than a documented threshold of elements, or `UNSUPPORTED_CAPABILITY`;
  - the current plan step or the model's declared checkpoint is **visual** (see the `checkpoint` change below);
  - the run was started with `--observe vision`.

  The two observations are not mutually exclusive: a step may carry both an element list and a frame, and `OperatorStep` therefore records the observation(s) it actually reasoned over.
- 🔵 New `--observe auto|ax|vision` run option, default `auto` (the policy above). `ax` never captures a frame — used by the exit criterion that counts frames — and `vision` restores exactly today's behavior, which is what the parity test compares against.
- 🔵 The element list enters the model context as **text**, in a compact, stable, line-oriented rendering (one line per element: ref, role, label, value, rect, disabled/focused markers), not as pretty-printed JSON. Cap the rendered length and state the cap in the prompt. Prune old element observations from history the same way images are pruned today (`pruneObservationImages`, `run.ts:296`), replacing them with a stub — an element list from six steps ago is as useless as a screenshot from six steps ago, and generalizing the existing function is the right shape.
- 🔵 Five new tools, added to `OPERATOR_TOOL_NAMES` (`tools.ts:13`) and the contract's tool table:
  - `observe_elements { role?: string, labelContains?: string, maxElements?: number }` — shapes the **next** observation, returns no payload inline. Mirrors exactly how `screenshot` works today, so there is one mechanism, not two.
  - `click_element { ref: string, button?: "left"|"right"|"other" }`
  - `double_click_element { ref: string }`
  - `type_into_element { ref: string, text: string }` — click the element, then `type_text`; secret substitution happens in the same one place it does today (`executor.ts:167`), not a second one.
  - `scroll_element { ref: string, deltaX: number, deltaY: number }`
- 🔵 Element-tool execution path, in order, with no shortcuts: re-resolve the ref via `enumerateElements({ refs: [ref] })` → take the rect's center → run the existing `assertWithinBounds` clamp (`guardrails.ts:33`) → issue `performInput`. On `AX_ELEMENT_STALE`, return the error as the tool result and let the next step re-observe; it is non-terminal. `INPUT_OUT_OF_BOUNDS` stays terminal. Element tools **do** consume `maxBatchActions`; the re-resolve does not.
- 🔵 **All existing pixel tools stay**, unchanged, as the fallback path for canvas, WebGL, Electron chrome, and web content. This is a hybrid, not a migration.
- 🔵 **Model tiers.** `OperatorRunOptions.model: ModelConfig` becomes `models: { planner: ModelConfig; executor?: ModelConfig }`; `executor` defaults to `planner`. Keep accepting the single-model shape at the CLI/MCP boundary and normalize it inward, so an unchanged caller is unaffected.
  - **Plan stage.** One observation — element list *and* one grounding frame, since the plan is written once and is worth an image — then the planner model produces the plan. Plan steps stay natural-language intent; the prompt asks the planner to name the expected element role/label and the expected observable outcome per step, because that is what makes the executor's checkpoint answerable.
  - **Execute stage.** The executor model receives a trimmed system prompt, the current plan and which step it is on, and the current observation. It has the action tools, `observe_elements`, `screenshot`, `checkpoint`, `done`, and `fail` — and **not** `plan`.
  - **Escalation.** `failed-plan-sound` → the executor retries within the current plan (once per plan step; a second consecutive `failed-plan-sound` on the same step escalates). `failed-plan-invalid`, or the retry rule above, → the planner re-enters with a compact run summary plus a fresh frame, and emits a new plan revision through the existing `reportPlan` path. Escalations are bounded by `maxReplans`.
  - Both tiers resolve through the existing provider registry (`providers.ts:32`) — adding a tier is a config shape change, not a provider change, and `openai-compatible` works for either tier so a fully-local two-tier run is possible.
- 🔵 **Prompt caching.** Attach `cache_control` to the stable system prompt and tool-schema prefix via `providerOptions` in `providers.ts`, for providers that support it. Requirements: it is applied only where the content is genuinely stable for the whole run (`prompt.ts` is built once at `run.ts:210`, so it qualifies); it is skipped silently for providers that do not support it; and a test asserts identical loop behavior with caching disabled. Nothing about planning, checkpoints, or escalation may depend on a cache hit.
- 🔵 `checkpoint`'s params gain `visual?: boolean` — the model declaring that verifying this expectation needs to *see* the screen, which is what makes the observation policy's visual branch reachable. It is model-stated, like `outcome`; the runtime never infers it (`contracts/operator.md` §Execution model is explicit that outcomes are never runtime-derived, and the same reasoning applies here).
- 🔵 Rewrite `prompt.ts` for the new percept. `prompt.ts:62`'s "Everything you know about the screen comes from that image" is now false and must go. The prompt states: elements are the default percept and carry exact rects; prefer `click_element` over `click` whenever a ref exists; screenshots are for when elements are absent or the check is visual; refs are valid only for the current observation.
- 🔵 Tests: element-tool resolution and clamping against a fake sidecar; the observation-policy decision table; stale-ref recovery; escalation and `maxReplans`; single-`--model` parity; caching-disabled parity; and an `ui.elements`-absent fake proving vision-only degradation with no platform branch above the stdio line.

### Daemon (`apps/daemon`, `packages/engine`)

- 🔵 `packages/engine/src/control-engine.ts`: `enumerateElements` passthrough with the existing per-call `requireCapability` gate (`control-engine.ts:114-124`) — it is a control-surface method and goes through the control client, **never** the capture client, and **never** takes the capture lock.
- 🔵 `packages/engine/src/operator-loop-host.ts`: serve the new loop-protocol method. Requires an open step (`NO_OPEN_STEP`), does not increment `actionsInStep`, and persists the element snapshot daemon-side under `observations/` exactly as `serveCaptureFrame` persists frames today (`operator-loop-host.ts:600-614`) — the child still writes nothing to disk.
- 🔵 `packages/engine/src/operator-run-engine.ts`: build the fifth `OperatorDeps` member in `createDeps` (`operator-run-engine.ts:441-505`), resolve both model tiers, and enforce `maxReplans` daemon-side. Guardrails are daemon-authoritative; the loop-side copy is deliberate duplication, per `contracts/operator-loop-protocol.md`.
- 🔵 `GuardrailState` (`packages/core/src/operator/loop-protocol.ts`) gains `replansUsed` / `maxReplans`, alongside the existing `planRevision`.

### CLI / MCP / plugin skill

- 🔵 `windower operate`: add `--planner-model <provider:model>`, `--executor-model <provider:model>`, `--observe auto|ax|vision`, and `--max-replans <n>`. `--model` keeps working and sets both tiers. Reuse the existing shared-flag helpers in `packages/cli/src/commands/operate-params.ts`; do not redefine flags.
- 🔵 API keys still come from the environment only, never a flag — unchanged, and now true for both tiers (a two-provider run needs both env vars present).
- 🔵 `run_operator`'s MCP params mirror the CLI exactly, same schemas (`contracts/mcp-tools.md`).
- 🔵 `plugins/claude-code/SKILL.md`: state that the operator now observes accessibility elements by default and falls back to screenshots, and that a cheap executor model is worth configuring. The `start_recording → run_operator → stop_recording` recipe is unchanged — this phase adds no orchestration and none may be added here.

### Docs

- 🔵 `contracts/operator.md`: the tool table (15 → 20), a new §Observation policy, a new §Model tiers, the amended §Provider independence caching sentence, `maxReplans` in the guardrail table, "four sidecar-facing methods" → five, and the `ObservationRef` change in §Transcript format.
- 🔵 `contracts/sidecar-protocol.md`, `contracts/operator-loop-protocol.md`, `data-model.md`, `research.md` §2, `spec.md` §5 — per the Protocol and Core schemas sections above.
- 🔵 `CLAUDE.md`: extend the Operator bullet to state that the operator observes on the **control** surface by default and that AX is a sensor, never an actuator.
- 🔵 `~/Documents/Development/windower-site` — per `CLAUDE.md`'s standing instruction. The audited surface: the `windower operate` usage/flag list needs the four new flags; the operator feature copy should say accessibility-first observation with vision fallback; any "how it sees the screen" explanation that says screenshots-only is now wrong.
- 🔵 `STATUS.md`.

### Explicitly out of scope for this phase

- Token/cost accounting on `OperatorStep` or `OperatorRun`, and any per-run cost surface (settled decision 5).
- History compaction or summarization of old steps.
- Windows/Linux `enumerateElements` implementations. The protocol must be expressible on both (`research.md` §2 row above) but only macOS implements it here, exactly as Phase 19 handled `performInput`.
- Any change to `EventTimeline`, `OutputManifest`, or the capture surface. This phase touches the capture surface only by calling it **less**.
- Post-processing (Phase 15) remains untouched; `OperatorStep.observations` replaces `observationRef` before Phase 15 ever consumes it, so Phase 15 reads the new shape and never has to handle both.

### Exit criteria

- `windower-control-macos` still links no ScreenCaptureKit after `ElementQuery.swift` lands — verified by the existing `otool -L` build check, not by code review.
- A run against a native macOS app with `--observe ax` completes with **zero** frames captured — verified by counting `kind: "elements"` vs `kind: "frame"` observation refs in the transcript and by asserting the `observations/` directory is non-empty while `frames/` is absent, not by reading logs.
- The waroom.co task from `spec.md`'s acceptance list completes in materially fewer steps and model calls than the Phase 21 baseline of 29/30/29 at `--max-steps 30` — both numbers measured from real transcripts and recorded in `STATUS.md` next to the baseline, so the comparison survives this session.
- A run configured with a single `--model` and no tier flags is behaviorally identical to a single-tier run: same tool surface per turn except that both stages resolve to one model — verified by test against a mock language model, not by review.
- Loop behavior is identical with prompt caching disabled or unsupported — verified by running the same scripted mock-model run against a caching and a non-caching provider config and asserting identical transcripts.
- A sidecar that does not advertise `ui.elements` degrades to vision-only, completes a scripted run, and produces no error — verified with `fake-sidecar.ts` capabilities minus `ui.elements`. `rg 'platform === "macos"'` over `packages/` and `apps/` still returns nothing.
- Element rects land correct clicks on a scale-2 display — verified by the Swift points→pixels test plus one live click on a Retina display, since this is the exact class of bug `CLAUDE.md`'s units rule exists to prevent.
- `AX_ELEMENT_STALE` is non-terminal: a run whose target window moves between observation and action recovers and continues — verified by test and by the live item below.
- `maxReplans` terminates a non-converging run with `OPERATOR_MAX_REPLANS_EXCEEDED` rather than exhausting `maxSteps` — verified by test with a mock model that always replans.
- Recording-independence tests and the loop-child dependency-graph test (`packages/operator/src/loop/loop-entry.deps.test.ts`) pass unchanged — the child still constructs no `SidecarClient` and now proxies five methods instead of four.
- Matches `spec.md` acceptance item: an operator run observes the screen through the accessibility surface by default and falls back to screenshots when the accessibility surface is insufficient, with the fallback observable in the transcript (Phase 22).
- Matches `spec.md` acceptance item: an operator run's planning and execution models are configurable independently, and a run configured with one model behaves identically to today (Phase 22).
- Full Swift + TS suites green with no regressions.

### Live verification (final task — do this last, after everything above, manual/TCC-gated per `e2e/README.md` convention)

- 🔵 **The motivating run.** `windower operate` on the waroom.co task — open Safari, navigate, declare an incident — with a strong planner and a cheap executor, real TCC grants, real models. Record steps, model calls, and frames-captured, and compare against the 29/30/29 baseline.
- 🔵 **Recording-independence parity.** The same run bare and wrapped in a caller-issued `start_recording`/`stop_recording` pair. Identical transcript shape, identical observation kinds, no `SCREEN_CAPTURE_BUSY`, and — the point of this phase — the AX-observed steps make no capture calls at all in either case.
- 🔵 **Vision fallback engages.** A target dominated by web or canvas content. Confirm the transcript shows the policy switching to frames and the run still completing.
- 🔵 **Stale-ref recovery.** Move or resize the target window between an observation and the action against it. Confirm `AX_ELEMENT_STALE` appears as a tool result and the run recovers rather than ending.
- 🔵 **Single-model parity, live.** One run with only `--model` set, confirming a caller who never learns about tiers sees no change.
