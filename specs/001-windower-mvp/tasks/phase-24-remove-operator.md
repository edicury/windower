## Phase 24 — Remove Operator; Adopt Computer-Use & Chrome Skills (v1.7)

**Goal:** Delete the Operator (`packages/operator`, its daemon RPCs, CLI/MCP surface, schemas, and the AX/input-synthesis native methods that existed only to serve it) and replace its role in the recording recipe with guidance to use the calling agent's own driving tools — Claude's computer-use tool for native/desktop UI and the `claude-in-chrome` skill for browser UI. Windower goes back to being exactly what `CLAUDE.md` already says it should be: a peer capability that records, never one that drives.

### Context / why now

The Operator (Phase 19, extended by Phase 22) was Windower's own observe → decide → act loop: an AI-SDK-backed LLM that looked at a screenshot or an accessibility-element list and issued clicks/keystrokes via `performInput`. It existed because, at the time, a calling agent had no first-party way to drive a UI it was recording — Windower had to ship one.

That's no longer true. Two capabilities now exist that a calling agent can bring itself:

- **Claude's computer-use tool** — native OS-level control (screenshots + coordinate-based clicks/keys), usable against any on-screen UI, browser or not.
- **The `claude-in-chrome` skill** — browser-specific automation (`navigate`, `computer`, `find`, `read_page`, `form_input`, …) via the Chrome extension, DOM-aware rather than pixel-guessing for the browser case.

Both are exactly the shape `CLAUDE.md` already asks for: "the calling agent is the orchestrator; Windower ships capabilities, not workflows." The Operator was the one place that principle was violated by necessity, not by design — `spec.md` §7 even carries a bullet called out explicitly as "the Phase 19 exception" to the no-network-calls rule. Removing the Operator doesn't just delete a feature, it deletes the exception: after this phase, "no network calls anywhere in Windower" is true without a footnote.

Keeping the Operator alongside these now means Windower maintains a second, worse copy of something the calling agent already has — a duplicate LLM loop with its own model billing, its own secrets/guardrails/redaction machinery, its own vision-vs-AX perception stack, and the only AI-SDK dependency footprint (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`) anywhere in the monorepo. It is real code to keep green (11 Vitest files, 2 Swift native methods, 4 daemon RPCs, 3 MCP tools, a CLI subcommand with 10 flags) for a job that now has a better answer living one layer up, in the caller.

**Skills researched and considered, for completeness:** the two above are the only ones directly relevant to "drive a UI during a demo." Nothing else in the available skill/tool ecosystem (design/documentation/observability/scheduling skills, etc.) bears on driving or recording a UI, so this phase does not pull in anything beyond computer-use and `claude-in-chrome`. One gap worth documenting rather than papering over: Claude Code itself does not ship a built-in computer-use tool for native macOS UI the way the Claude API/Agent SDK does — a calling agent inside Claude Code driving a **native, non-browser** app during a demo needs either a computer-use-capable environment or its own automation (e.g. `osascript`/System Events via `Bash`). `SKILL.md` should say this plainly instead of assuming computer-use is always present.

### Settled decisions (do not relitigate during implementation)

1. **Full removal, no compatibility shim.** No `@deprecated` re-export layer, no `windower operate` stub that silently no-ops. Windower is pre-1.0 and has taken breaking changes before (Phase 21 broke `run_operator` outright); `windower operate` should fail the same way any removed command does — a clear, one-line error pointing at the new `SKILL.md` guidance, not a working-but-hollow command.
2. **The control primitives go too — `performInput`, `enumerateElements`, and `captureFrame` (with its `fresh` param) are removed from the protocol, not kept as standalone capabilities.** Their only production caller anywhere in the repo was the Operator loop. Computer-use and the Chrome skill each bring their own input mechanism (screenshot+coordinate, and DOM-based, respectively), so Windower doesn't need to keep offering a third. This was evaluated against the alternative (exposing them as direct CLI/MCP capabilities for exact-pixel native control) and rejected: a half-used, no-first-party-caller control surface is exactly the kind of thing `CLAUDE.md`'s "ships capabilities, not workflows" warns against carrying speculatively. It can come back the day a real, non-operator caller wants it — as a new phase with its own justification, not as leftover Operator plumbing.
3. **`resizeWindow`, `describe`, `getPermissions`, `requestPermission`, `enumerateTargets`, `startCapture`/`stopCapture` are untouched.** None of them exist because of the Operator; they're window-geometry and recording primitives every recording flow needs regardless of who drives the UI.
4. **`EventTimeline`'s `source` field collapses to the single literal `"user"`.** The `"operator"` tag existed because Windower itself synthesized input it could mark; once Windower never synthesizes input, there's nothing to distinguish — an agent driving via computer-use or the Chrome skill looks identical to a human, from the capture sidecar's point of view. Treat this as a breaking transcript-schema change like Phase 22's `ObservationRef` change: older `.events.json` files with `"operator"` entries still parse (the schema keeps accepting the value on read) but nothing ever emits it again. Do not redesign the field around "who's really driving" — that information doesn't exist below the stdio line and manufacturing it would be exactly the kind of platform-reasoning leak `CLAUDE.md` forbids.
5. **Historical phase files and bug entries are marked superseded, not deleted.** `tasks/phase-19-operator.md` and `tasks/phase-22-operator-ax-first.md` get a one-line banner at the top ("**Superseded by Phase 24 — the Operator was removed.** Kept for historical record only.") rather than being removed from the repo — they're the record of real completed work, the same way `STATUS.md`'s "historical note" sections are kept rather than scrubbed. Same treatment for `bugs.spec.md` #9 and #10 (both Operator-specific): append "N/A as of Phase 24 — the Operator no longer exists" rather than deleting the entries.

### YAGNI — what this phase must not turn into

- 🔵 **No Windower-side "driving adapter."** No wrapper package, no `ComputerUseAdapter`, no code that calls out to a computer-use API or the Chrome extension on Windower's behalf. Windower ships zero code for driving UI, full stop — that is the entire point of this phase, not a detail of it.
- 🔵 **No new orchestration in `SKILL.md` beyond naming the right tool for the surface.** The existing rule stands: Windower ships no `start_recording → drive → stop_recording` glue code; the recipe stays caller-composed prose in `SKILL.md` only.
- 🔵 **No speculative re-exposure of `performInput`/`enumerateElements` "just in case."** See settled decision 2.

### Protocol first (per `CLAUDE.md` — fix the contract before touching code)

- 🔵 `contracts/sidecar-protocol.md`: remove the control-surface method-table rows for `performInput`, `enumerateElements`, `captureFrame`; remove capability strings `input.mouse`, `input.keyboard`, `ui.elements`; remove the "Element enumeration", "Frame sharing", and "Platform notes: input synthesis and element enumeration" sections (lines ~86–117 as of this session). Remove error codes `AX_ELEMENT_STALE`, `INPUT_UNSUPPORTED`, `INPUT_OUT_OF_BOUNDS` from the taxonomy (confirm each has no non-Operator reference first).
- 🔵 Delete `contracts/operator.md` and `contracts/operator-loop-protocol.md` outright — both are Operator-only contracts with nothing left to describe once the loop is gone.
- 🔵 `contracts/cli.md`: remove the `windower operate` / `operate status|abort|list` sections, the policy-table rows for them, `doctor`'s `activeRuns` field, and the daemon stop/restart run-abort semantics that only existed because operator runs could be in flight.
- 🔵 `contracts/mcp-tools.md`: remove `run_operator`, `get_operator_run`, `abort_operator_run` sections and the backend-routing paragraph describing `run_operator`'s special env-scoped connection. MCP tool count goes from 12 to 9.
- 🔵 `contracts/daemon-rpc.md`: remove the `env`-scoping rules that existed for operator secret/model resolution, `OPERATOR_RUN_NOT_FOUND`, and the graceful-shutdown "abort active operator runs" step.
- 🔵 `contracts/screen-capture-exclusivity.md`: remove the loop-child mention from "what never takes the lock" and replace the operator-run verification criterion with a plain synthetic-input-driven recording (see Live verification below — the exclusivity mutex still needs *some* real driving load to test against).
- 🔵 `research.md` §2: remove the `performInput`, `enumerateElements`, and `captureFrame` rows.
- 🔵 `data-model.md`: remove `OperatorRun`, `OperatorPlan`, `OperatorStep`, `ObservationRef`, `UIElement`, `SecretRef`, `ModelConfig`, `OperatorModels`, `OperatorGuardrails`, `CaptureFrameParams`; collapse `EventTimeline`'s `source` union per settled decision 4; remove `WindowerConfig.operator`; check `RecordingSession`/manifest sections for operator-specific invariant paragraphs and strip them.
- 🔵 `spec.md`: collapse the three-plane (Capture / Operator / Control) framing in §1.1 to two peer capabilities (Capture, Control); remove the operator half of the §1.2 recipe, keeping only the two-call `start_recording`/`stop_recording` pattern with a note that the caller drives in between using its own tools; remove §2.1.1's v1.2 goals; **add** an explicit non-goal to §2.2: "Windower does not drive UI — that is the calling agent's responsibility, via its own tools (computer-use, browser skills, or manual scripting)"; remove §4.7 (US-19..22) and the matching acceptance items; **delete §7's "Network policy — the Phase 19 exception" entirely** — restore the plain, unqualified "no network calls anywhere in Windower" statement.

### `packages/core`

- 🔵 Delete `src/schemas/operator.ts`, `src/schemas/operator-schemas.test.ts`, and the `export * from "./operator.js"` line in `src/schemas/index.ts`.
- 🔵 Delete `src/operator/` (`types.ts`, `loop-protocol.ts` + test, `index.ts`) and the re-export in `src/index.ts`.
- 🔵 `src/daemon/methods.ts`: remove `RunOperatorParams/Result`, `GetOperatorRunParams/Result`, `AbortOperatorRunParams/Result`, `ListOperatorRunsParams/Result`, their 4 `DAEMON_METHODS` entries, and `OPERATOR_RUN_NOT_FOUND`. Update `methods.test.ts`.
- 🔵 `src/daemon/client.ts`: remove the `runOperator` helper. `src/daemon/backend.ts` (+ test), `src/daemon/policy.ts` (+ test): remove the `operate`/`operate status|list|abort` policy-table entries. `src/daemon/connect.ts`, `src/daemon/protocol.ts`: drop operator-specific mentions.
- 🔵 Delete `src/daemon/operator-env.ts` (`buildOperatorHelloEnv`) and its export from `src/daemon/index.ts`.
- 🔵 `src/schemas/config.ts`: remove the `operator` block (`ModelConfigSchema`, `OperatorGuardrailsSchema`) from `WindowerConfig`.
- 🔵 `src/schemas/event-timeline.ts`: `EventSourceSchema` collapses per settled decision 4.
- 🔵 Delete `src/schemas/ui-element.ts`.
- 🔵 `src/protocol/methods.ts`: remove `performInput`, `enumerateElements`, `captureFrame` from `SIDECAR_METHODS`/`SIDECAR_METHOD_SCHEMAS`/`CapabilitySchema`; `src/protocol/sidecar-client.ts`: remove the matching client methods; `src/protocol/fake-sidecar.ts`: remove the fakes and the now-dead capability defaults.
- 🔵 Clean up comment-only mentions in `schemas/session.ts`, `schemas/manifest.ts`, `schemas/input-action.ts`, `fs/atomic-write.ts`, `protocol/jsonrpc.ts`.

### `packages/engine`

- 🔵 Delete `src/operator-run-engine.ts` (+ test), `src/operator-loop-host.ts` (+ test), `src/operator-run-store.ts`, `src/secret-resolver.ts`, `src/test-helpers/fake-loop-child.ts`, and their exports in `src/index.ts`.
- 🔵 `src/local-windower.ts`: remove `OperatorRunEngine`/`OperatorRunStore` construction and the `runOperator`/`getOperatorRun`/`abortOperatorRun`/`listOperatorRuns` methods.
- 🔵 `src/control-engine.ts`: remove the `performInput`/`enumerateElements` passthrough methods (the `resizeWindow` passthrough stays).
- 🔵 `src/request-context.ts` (+ test) existed specifically to thread caller env/cwd to the Operator — before deleting, grep for any other consumer; if none, delete it and its wiring in daemon/CLI/MCP.

### `apps/daemon`

- 🔵 `src/server.ts`: remove the `operatorRunManager` field/constructor param, the `run_operator`/`get_operator_run`/`abort_operator_run`/`list_operator_runs` dispatch cases, and the shutdown path's "abort active operator runs" step (`activeRunCount`, `sigkillActiveSidecars` — confirm these aren't also used for non-operator sidecar cleanup before removing wholesale).
- 🔵 `src/main.ts`: remove `OperatorRunStore`/`OperatorRunEngine` construction and `recoverCrashedRuns()`.
- 🔵 `src/bin.ts`: remove the `daemon.operatorRunManager.sigkillActiveSidecars()` call.
- 🔵 Delete the deprecated re-export shims `src/operator-run-manager.ts`, `src/operator-run-store.ts`, and their re-exports in `src/index.ts`.
- 🔵 Update `src/server.test.ts`.

### `packages/cli`

- 🔵 Delete `src/commands/operate.ts` (+ test), `src/commands/operate-blocking.ts` (+ test), `src/commands/operate-params.ts` (+ test).
- 🔵 `src/program.ts`: remove `registerOperateCommand`.
- 🔵 `src/backend.ts` (+ test): remove the `operate` carve-out and `buildOperatorHelloEnv` usage.
- 🔵 `src/commands/config.ts`: remove the `"operator"` config key and its `ConfigGetView` entry.
- 🔵 `src/commands/doctor.ts` (+ test): remove API-key env-var reporting and active-run count.
- 🔵 `src/exit-codes.ts`: remove Operator failure-mode documentation.
- 🔵 `src/commands/record-params.ts`: keep the shared target-resolution logic (used by `record`/`start`), just confirm nothing there is `operate`-specific.
- 🔵 `src/commands/daemon.ts`, `src/policy.test.ts`: drop operator mentions.
- 🔵 Deciding the exact UX of a removed `windower operate` invocation (hard "unknown command" from commander vs. a registered-but-erroring stub naming the new SKILL.md guidance, the pattern Phase 21 used for removed recording flags) is left to implementation — either satisfies settled decision 1 as long as nothing silently succeeds.

### `packages/mcp-server`

- 🔵 Delete `src/tools/operator.ts` (+ test), `src/operator-env.ts` (+ test).
- 🔵 `src/tools/index.ts`: remove `registerOperatorTools`.
- 🔵 `src/backend.ts` (+ test): remove `run_operator|get_operator_run|abort_operator_run` from `ToolName` and the `connectForOperatorRun` carve-out.
- 🔵 `src/daemon-client.ts` (+ test): remove the dedicated non-memoized env-scoped connection that existed solely for `run_operator`.
- 🔵 `src/shutdown.test.ts`: remove or rewrite the assertion that `list_operator_runs` is never exposed (there's nothing left to prove).

### Native (`native/macos`)

- 🔵 Before deleting anything: `rg` the whole repo (including `e2e/`, scripts, and this phase's own removal list) for `performInput`, `enumerateElements`, and `captureFrame` call sites to confirm the Operator really is the only caller, per settled decision 2 — this is a search-and-confirm task, not an assumption.
- 🔵 Delete `Sources/WindowerControlCore/ElementQuery.swift` + `Tests/WindowerControlCoreTests/ElementQueryTests.swift`.
- 🔵 Delete `Sources/WindowerControlCore/InputSynthesis.swift` + its tests.
- 🔵 Delete or gut `Sources/WindowerCaptureCore/FrameCapture.swift` (headered "Phase 19 — Operator: one-shot frame grab" — confirm no non-operator caller first, same as above).
- 🔵 `Sources/windower-control-macos/main.swift`: remove the `performInput`/`enumerateElements` dispatch cases and their entries in the static capability list.
- 🔵 `Sources/WindowerSidecarShared/EventTag.swift`, `Protocol.swift`, `Sources/WindowerCaptureCore/EventTapCapture.swift`, `Enumeration.swift`: remove the `"operator"` event-source tag value per settled decision 4 — every captured event tags `"user"`.
- 🔵 Re-run the `otool -L` no-ScreenCaptureKit-in-control-binary check after the deletions; it should still pass trivially (fewer symbols, not more).

### Workspace / release

- 🔵 Delete `packages/operator/` entirely (`rm -rf`, not a partial gut).
- 🔵 `packages/cli/package.json`, `packages/engine/package.json`: remove the `"@windower/operator": "workspace:*"` dependency.
- 🔵 `pnpm-lock.yaml`: regenerate (`pnpm install`) — this is what actually removes `ai`/`@ai-sdk/*` from the tree; verify with `pnpm why ai` returning empty.
- 🔵 `scripts/release/graph.mjs`: remove the `operator` publish stage entry and re-check publish ordering (core → engine, no longer core → operator → engine/cli).
- 🔵 `scripts/release/__tests__/release.test.mjs`: update the hard-coded expected publish order to drop `@windower/operator`.
- 🔵 Check `.github/workflows/ci.yml` and `.github/workflows/release.yml` for any Operator-related secrets wiring (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` used for e2e) and remove if present.

### Plugin / skill / docs

- 🔵 `plugins/claude-code/SKILL.md`: rewrite the frontmatter description to drop `run_operator`/`get_operator_run`/`abort_operator_run`. Replace "You are the orchestrator" and "Driving the UI yourself vs. delegating to the operator" with a single "**Driving the UI**" section: the caller always drives, using `claude-in-chrome` (`navigate`/`computer`/`find`/`read_page`/`form_input`, …) for anything in a browser tab, and Claude's computer-use tool for native/desktop UI when the calling environment has it — and an honest note that Claude Code itself does not ship computer-use by default, so a native-app demo may need `osascript`/System Events via `Bash` instead. Remove the "recipe: record around an operator run" section and the `run_operator` usage/model-tiering/secrets/guardrails documentation wholesale. Keep sections 2 (two-call start/stop pattern), 6 (recipes), 7–9 (permissions, status/recovery, reporting) as-is — they're already Operator-free.
- 🔵 `README.md`: remove the TOC entry, feature bullet, daemon-policy line, the "The operator (`windower operate`)" section, "Extra setup for the operator", and the `WINDOWER_OPERATOR_DEBUG`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`apiKeyEnvVar` env-var rows. Add a short paragraph: Windower pairs with `claude-in-chrome` and computer-use for driving; Windower itself only records.
- 🔵 `CLAUDE.md`: the "The Operator is recording-unaware" and "AX is a sensor — never an actuator" bullets are moot once the Operator is gone — replace both with one generalized bullet carrying the durable lesson forward: **"Windower never drives UI itself — driving is always the calling agent's job, via its own tools (computer-use, a browser skill, or manual scripting). Windower ships no code that synthesizes input or perceives the screen for decision-making; it only records, reports targets, and resizes windows."** Keep the "calling agent is the orchestrator; Windower ships capabilities, not workflows" bullet as-is — it's the rule this whole phase is enforcing. Remove the Phase-19 network-policy-exception clause from the "No network calls anywhere in MVP" bullet, restoring it to unqualified.
- 🔵 `native/macos/CODESIGNING.md`: drop the one Operator mention.

### Spec bookkeeping

- 🔵 `tasks/INDEX.md`: add this phase under a new `## v1.7` heading (see the accompanying edit in this same change).
- 🔵 `bugs.spec.md`: mark #9 and #10 "N/A as of Phase 24" per settled decision 5; leave #6 alone (already-fixed bug, its evidence chain is historical and mentions the operator only as the load generator used at the time).
- 🔵 `tasks/phase-19-operator.md`, `tasks/phase-22-operator-ax-first.md`: prepend the superseded banner per settled decision 5.
- 🔵 `tasks/phase-20-daemon-optional.md`: strip Operator-specific content (it was motivated by an Operator env bug) but keep the daemon-lifecycle/hardening work described, since that stands independent of the Operator's existence — note in the file that the bug that motivated it was in `windower operate`'s env handling, now historical.
- 🔵 `tasks/phase-21-capture-control-broker.md`, `phase-21-handoff-prompt.md`, `phase-21-live-verification-prompt.md`: strip Operator-specific content; the capture/control split and exclusivity-mutex architecture stand independent of the Operator, but the six outstanding live-verification items that used `windower operate` as their load generator need a replacement harness — see Live verification below.
- 🔵 `tasks/phase-23-ci-release-automation.md`: update the publish-graph ordering description to drop `@windower/operator`.
- 🔵 `e2e/manual/phase-21/`: rewrite `parity-and-lifecycle.sh`, `crash-loop-child.sh`, `crash-capture.sh`, `crash-control.sh`, `stress-run.sh`, `parity-b.sh`, `core-repro.sh` to drive load via plain synthetic input (`osascript`/System Events, matching Phase 13's e2e fixture approach) instead of `windower operate`; `crash-loop-child.sh` specifically has no equivalent anymore (there's no loop child left to crash) and should be deleted rather than rewritten. Update `metrics.mjs`/`README.md` to match.
- 🔵 Root scratch files `.operate-run*.log` — delete, they're dead artifacts of a removed command.

### `~/Documents/Development/windower-site`

- 🔵 `src/data.ts`: `FEATURES`' "Twelve MCP tools" → nine (line ~31); `DEMO_CHAPTERS` step 03 (currently "Operate" / "The agent takes over Safari…") reframed around the agent using its own driving tools while Windower just records; `FAQS` "Does a human need to be at the keyboard?" rewritten to say the agent drives with its own computer-use/Chrome tools, Windower records around it; `QUICKSTART_STEPS` step 03 copy adjusted to match. `MCP_TOOLS` already lists exactly the 9 non-operator tools — no change needed there, which is worth noting as a pre-existing inconsistency this phase finally resolves.
- 🔵 `src/components/Agents.tsx`: fix the hardcoded "Twelve MCP tools" (line ~11) to nine.
- 🔵 `src/components/Hero.tsx` + `index.html`'s `<meta name="description">`/`og:title`: re-read "they operate your app, Windower captures the session" under the new story (it likely survives verbatim — "they" now means the agent's own computer-use/Chrome tools rather than Windower's operator — but confirm it doesn't read as a Windower-does-the-driving claim once the Operator is gone).
- 🔵 **New:** add an explicit callout (feature bullet or a short section) that Windower is designed to pair with Claude's computer-use tool and the `claude-in-chrome` skill for driving — this is the marketing-facing half of the architecture decision this phase makes, and per `CLAUDE.md`'s standing instruction ("check windower-site for anything that needs updating... before considering a phase done") it belongs here, not just in the repo's own docs.
- 🔵 `README.md`: fix the `DemoSlot.tsx` caption describing an "agent-driven" session if its wording implies Windower's own operator.
- 🔵 Rebuild `dist/` so the committed build output isn't stale.

### Exit criteria

- `rg -i operator` across `packages/`, `apps/`, `native/`, `plugins/`, root `README.md`/`CLAUDE.md`, and `~/Documents/Development/windower-site/src` returns nothing, **except** the deliberately-preserved historical mentions in `STATUS.md`, `bugs.spec.md`'s marked-N/A entries, and the superseded-banner phase files.
- `packages/operator` does not exist on disk; `pnpm why ai` and `pnpm why @ai-sdk/anthropic` (etc.) return empty.
- `pnpm -r build` and `pnpm turbo run test` green with the operator package absent from the workspace graph.
- `swift build`/`swift test` green; `otool -L` on `windower-control-macos` still links no ScreenCaptureKit (should trivially hold — the binary only got smaller).
- `windower operate` is not a working command — verified by invoking it and asserting a non-zero exit, not by code review.
- MCP server exposes exactly 9 tools; none of them are `run_operator`/`get_operator_run`/`abort_operator_run`.
- `plugins/claude-code/SKILL.md` contains no mention of "operator" and documents the computer-use / `claude-in-chrome` split for driving UI, including the Claude-Code-has-no-built-in-computer-use caveat.
- `windower-site` builds (`pnpm build`) and its rendered copy contains no "operate"/"operator" language; the MCP tool count on the site matches the real count (9).
- Full monorepo test suite green end to end (`pnpm turbo run test`), Swift suite green, no regressions in any non-Operator package.

### Live verification (final task, manual/TCC-gated per `e2e/README.md` convention)

- 🔵 A real `start_recording` → (caller drives via `claude-in-chrome` against a real browser target) → `stop_recording` run, confirming the recipe works end to end with no operator involved and no code path references it.
- 🔵 A real `start_recording` → (caller drives a native macOS app via `osascript`/System Events, standing in for computer-use) → `stop_recording` run, confirming the same for a non-browser target.
- 🔵 Re-run Phase 21's six previously-outstanding live-verification items (concurrent-load stress, crash injection ×3, operator-without-recording parity, independent lifecycle) using the rewritten `e2e/manual/phase-21/` scripts now that they no longer depend on `windower operate` — these were blocked on model credits before; they no longer need a model at all.
- 🔵 `windower doctor` on a clean checkout reports no Operator-related fields (no active-run count, no API-key env-var rows) and exits clean.
