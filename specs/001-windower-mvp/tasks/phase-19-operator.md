**Superseded by Phase 24 — the Operator was removed.** Kept for historical record only.

## Phase 19 — Operator (v1.2)

**Goal:** Ship a guided "operator" agent that takes one natural-language instruction (e.g. "Open waroom.co, log in with these creds, create an incident to showcase. Record in 1080p, save to Desktop.") and performs it end-to-end — perceiving the screen, driving mouse/keyboard, recording as it goes — by freezing new sidecar protocol methods first (protocol before platform, this repo's core rule), then implementing on top of them.

**Context / why now:** Today Windower only records; every user story in `spec.md` (US-06) and `quickstart.md` (line ~56) assumes the *calling* agent drives the UI with its own tools — inside Claude Code that means the browser tool, which is browser-only. The event-tap input surface is deliberately `.listenOnly` (`native/macos/Sources/WindowerSidecarCore/EventTapCapture.swift`) — nothing today calls `CGEventPost`. Operator needs synthetic input, a screenshot method, and an LLM call, three things currently unspecified anywhere in the contracts. This phase specs and builds all three without letting macOS-specific reasoning leak above the stdio line, per `CLAUDE.md`'s "protocol before platform" rule.

### Protocol

- 🔵 Freeze `performInput` and `captureFrame` methods in `contracts/sidecar-protocol.md`'s method table, alongside the existing `startCapture`/`resizeWindow` rows — same style (Method | Params | Result | Required capability).
- 🔵 Add capability strings `input.mouse`, `input.keyboard`, `screenshot` to the `describe` capability list.
- 🔵 Add error codes `INPUT_UNSUPPORTED` and `INPUT_OUT_OF_BOUNDS` to the error taxonomy table.
- 🔵 Add a `source` discriminator (`"user" | "operator"`) to `TimelineEvent` in `data-model.md` so recorded events can be attributed to a human vs. the operator loop.

### macOS sidecar

- 🔵 New `native/macos/Sources/WindowerSidecarCore/InputSynthesis.swift` — synthesizes mouse/keyboard events via `CGEventPost` using a private `CGEventSource`, stamping every synthetic event's `.eventSourceUserData` with a Windower magic constant so operator-generated events are distinguishable from real user input downstream.
- 🔵 New `native/macos/Sources/WindowerSidecarCore/FrameCapture.swift` — one-shot `SCScreenshotManager` grab of a target, PNG/JPEG encode, optional downscale to a `maxWidth`, backing `captureFrame`.
- 🔵 `EventTapCapture.swift` reads the `eventSourceUserData` tag CGEventPost'd events carry and stamps `source: "operator"` on the resulting `TimelineEvent`; everything else defaults to `source: "user"`.

### Core schemas

- 🔵 New Zod schemas in `packages/core/src/schemas/`: `OperatorRun`, `OperatorStep`, `InputAction` (discriminated union: `mouse_move`, `mouse_down`, `mouse_up`, `mouse_click`, `mouse_drag`, `scroll`, `type_text`, `key_press`, `wait`), `SecretRef`, `ModelConfig`.
- 🔵 New sidecar methods added to `packages/core/src/protocol/methods.ts` (`performInput`, `captureFrame`), matching the frozen contract exactly.
- 🔵 New daemon methods added to `packages/core/src/daemon/methods.ts` and dispatched in `apps/daemon/src/server.ts`: `run_operator`, `get_operator_run`, `abort_operator_run`, `list_operator_runs`.

### packages/operator

- 🔵 New package, `packages/operator` — an observe → decide → act loop built on the Vercel AI SDK (`ai` + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/openai-compatible`, etc.), model selected by a `provider:model` config string so the user can point at any supported model, including local ones.
- 🔵 Tool definitions matching the closed tool surface documented in `contracts/operator.md`: `screenshot`, `move_mouse`, `click`, `double_click`, `drag`, `scroll`, `type_text`, `press_key`, `wait`, `list_targets`, `resize_window`, `done`, `fail` — explicitly no shell, filesystem, or raw network tool.
- 🔵 Secret-ref substitution: the model and its tool-call arguments only ever see `{{name}}` placeholders; the real value is substituted immediately before the `performInput` RPC call, never sent to the model.
- 🔵 Redaction filter applied over the transcript, step records, and any logs before they're written or persisted.
- 🔵 Guardrail enforcement in the runtime (not the prompt): `maxSteps` (default 40), wall-clock `timeoutMs` (default 300000), target-bounds clamp on every coordinate against the recorded target's `Rect` unless `--unbounded`, and a kill switch (abort).
- 🔵 Transcript writer producing `<recording>.operator.json` next to the video file, per `contracts/operator.md`'s shape.

### Daemon

- 🔵 New `OperatorRunManager` alongside `SessionManager`, persisted at `~/.windower/operator-runs/<runId>.json` on every state transition (mirrors `apps/daemon/src/session-manager.ts`'s disk-persistence convention for `RecordingSession`).
- 🔵 Crash recovery marks any in-flight run `failed` on daemon restart, mirroring `session-manager.ts`'s `recoverCrashedSessions()` behavior for `RecordingSession`.

### CLI / MCP / plugin skill

- 🔵 `windower operate "<task>" [recording flags] --model <provider:model> [--base-url <url>] [--secret <name>=<source>:<ref>]... [--max-steps <n>] [--timeout <s>] [--unbounded] [--no-record] [--json]`. Reuses `addSharedRecordingFlags` from `packages/cli/src/commands/record-params.ts` for the recording flags — does not redefine them.
- 🔵 `windower operate status <runId>`, `windower operate abort <runId>`, `windower operate list`, following the same `--json` convention as every other command in `contracts/cli.md`.
- 🔵 Three new MCP tools — `run_operator`, `get_operator_run`, `abort_operator_run` — documented in `contracts/mcp-tools.md` (a sibling task; this phase only references that file, doesn't edit it here).
- 🔵 `plugins/claude-code/SKILL.md` gets guidance on when to delegate to the operator vs. drive the browser tool itself directly.

### Docs

- 🔵 Mirror the new feature into `~/Documents/Development/windower-site` per `CLAUDE.md`'s standing instruction — feature list, a docs page for `windower operate`, and install notes if the operator package changes install steps. (Referenced here as a required task; not performed as part of writing this spec.)
- 🔵 Extend `research.md` §2's per-method feasibility matrix with `performInput`/`captureFrame` rows: macOS via `CGEventPost`/`SCScreenshotManager` (full), Windows via `SendInput`/`PrintWindow`+DXGI (full), Linux via X11 `XTEST` (full under X11/XWayland), with an honest Wayland gap noted — no standard synthetic-input API, needs `libei` or the XDG `RemoteDesktop`/`ScreenCast` portals, upgraded per-compositor later same as the existing `eventTimeline`/`window-control` Wayland gaps.

**Explicitly out of scope for this phase**

- No browser engine or DOM automation shipped by Windower itself — operator only performs pixel/AX-level input, it is not a Playwright replacement.
- No credential storage or vault — secrets are refs to an existing OS keychain or environment variable, resolved at call time only, never persisted by Windower.
- No Windows/Linux operator implementation — the protocol must allow it (see the `research.md` extension above), but Phase 16/17 implement the actual backends.
- No multi-agent or multi-step planning UI.
- No approval-per-step UI beyond a CLI flag (`--unbounded`/guardrail flags); no interactive step-by-step confirmation surface.

**Exit criteria**

- `performInput`/`captureFrame` are frozen in `contracts/sidecar-protocol.md` with capability gating (`input.mouse`, `input.keyboard`, `screenshot`) exactly like every other capability-gated method.
- Matches `spec.md` acceptance item: an agent can issue one natural-language instruction and Windower drives the UI and records the result end-to-end, demonstrated by the waroom.co motivating example running start-to-finish via `windower operate` (Phase 19).
- Matches `spec.md` acceptance item: secrets referenced via `--secret` never appear in the operator transcript, daemon/sidecar logs, or the event timeline — verified by redaction tests (Phase 19).
- Matches `spec.md` acceptance item: input synthesized by the operator is distinguishable from real user input in the recorded event timeline via `source: "operator"` (Phase 19).
- Matches `spec.md` acceptance item: guardrails (step cap, wall-clock timeout, target-bounds clamp, abort) are enforced by the runtime, not merely requested in the model's prompt (Phase 19).
- Matches `spec.md` acceptance item: the model backing an operator run is swappable via `--model <provider:model>` config with zero code change, using the AI SDK's provider abstraction (Phase 19).
