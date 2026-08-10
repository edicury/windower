# Windower — Agent Instructions

AI-native screen recorder: TS orchestration (daemon/CLI/MCP/skill) + a native per-OS sidecar (Swift on macOS first). Spec lives in `specs/001-windower-mvp/` — **read `spec.md`, `plan.md`, and `contracts/sidecar-protocol.md` before writing any code**, they are the source of truth, not this file.

## Execution process (mandatory)

Every phase/task from `specs/001-windower-mvp/tasks/` is executed by a subagent — decompose, dispatch (in parallel where independent), integrate. Skip delegation only for a task genuinely too small to bother with (one-line fix, mechanical rename). When in doubt, delegate.

Work phase-by-phase in the order in `tasks/INDEX.md`. Before starting a phase, read its file in `tasks/phase-N-*.md` for the exact task list and exit criteria. Update `STATUS.md` at the end of each work session — current phase, what's done, what's blocked.

New features or user-facing changes here must be reflected in `~/Documents/Development/windower-site` (the marketing/docs site) as well — check it for anything that needs updating (feature list, docs, screenshots, install instructions) before considering a phase done.

## The one rule that matters most: protocol before platform

`contracts/sidecar-protocol.md` (frozen in Phase 1) is the contract between OS-agnostic TS and the native sidecar. **Never let macOS-specific reasoning leak above the stdio line.** Concretely:

- Code in `packages/core`, `apps/daemon`, `packages/cli`, `packages/mcp-server`, `plugins/claude-code` must never branch on `platform === "macos"`. It only ever checks `describe().capabilities` and reacts to `UNSUPPORTED_CAPABILITY`/`RESIZE_UNSUPPORTED`/etc.
- If implementing a macOS feature reveals the protocol can't express something, **fix `contracts/sidecar-protocol.md` and `data-model.md` first**, then implement — don't bolt on a macOS-only escape hatch in the TS layer.
- `research.md` §2 has the per-method Windows/Linux feasibility matrix. Before adding a new sidecar method or param, sanity-check it against that table — if it only makes sense on macOS, it probably belongs behind a capability flag, not as an unconditional method.

## Repo layout cheat sheet

```
apps/daemon/          long-running session manager, unix socket JSON-RPC server
packages/core/         Zod schemas (data-model.md), sidecar protocol client, daemon client — shared by CLI+MCP+plugin
packages/cli/          `windower` binary — thin wrapper over packages/core
packages/mcp-server/   MCP tools — thin wrapper over packages/core, same schemas as CLI --json
plugins/claude-code/   plugin manifest + SKILL.md
native/macos/          one Swift Package, two binaries (Phase 21):
                         windower-capture-macos  ScreenCaptureKit + AVFoundation — the ONLY process that touches SCK
                         windower-control-macos  CGEvent + AX input/window control — cannot link ScreenCaptureKit, even transitively
native/windows/        post-MVP, same protocol
native/linux/          post-MVP, same protocol
fixtures/demo-app/     deterministic-geometry app for e2e tests (Phase 13)
specs/001-windower-mvp/ spec, plan, contracts, phased task breakdown — READ FIRST
```

## Non-obvious conventions

- **Units:** every public API (CLI flags, MCP tool params, daemon RPC) is in **pixels**. AXUIElement/Retina math converts to points only inside `native/macos` — never let a points-vs-pixels bug leak past the sidecar boundary (see `research.md` §3).
- **Two-call recording pattern:** `start_recording`/`windower start` returns a `sessionId` immediately and does not block. The agent performs the actions being demoed *between* `start` and `stop`. This is the single most important semantic to get right in the CLI, MCP tool descriptions, and `SKILL.md` — a blocking `record --duration` command exists too, but it's sugar, not the primary flow.
- **Exactly one process on the machine may hold ScreenCaptureKit state at a time** (Phase 21, supersedes the older "one sidecar process per active session" note — same instinct, stated as the real invariant). Live `SCShareableContent`/`SCStream`/`SCScreenshotManager` state in a second process can make `replayd` kill an unrelated healthy stream, which is how recordings silently truncated (`bugs.spec.md` #6). Inside the daemon this is ordinary bookkeeping — it owns one capture sidecar and never starts a second. Across processes (daemon-optional operation) it's the **ScreenCaptureKit exclusivity mutex**, `~/.windower/capture.lock`: acquire, or wait briefly and fail with `SCREEN_CAPTURE_BUSY`. A caller is **never** routed to the lock holder — there is no discovery, no routing layer, no capture IPC socket, and no such thing may be added (`contracts/screen-capture-exclusivity.md`). Control (`performInput`/`resizeWindow`) never takes the lock and is never serialized against capture. Crash isolation is unchanged: a capture crash is isolated to its session.
- **The Operator is recording-unaware.** `packages/operator` must never know whether a recording exists, start/stop/look one up, route frames through a session, or carry a session id — and the same `OperatorRun` must behave identically with or without a recording. Symmetrically, a `RecordingSession` must not know what is driving the screen (human, Windower Operator, Claude Code, Playwright, or nothing). Frames are addressed by **target**, never by recording. Enforced by dependency-graph tests, not review (`contracts/operator.md` §Recording independence).
- **The Operator observes on the control surface, and AX is a sensor — never an actuator** (Phase 22). Its default percept is `enumerateElements` (accessibility elements, exact pixel rects, capture-free, no `capture.lock`), with `captureFrame` as the fallback for accessibility-opaque targets and visual checkpoints. It **never** calls a platform accessibility *action* (`AXPress`/`AXSetValue`/equivalents) — every interaction is synthesized input at the element's rect, because a recording of a UI that changes with no cursor and no keystrokes is not a demo. There is no flag to change that; an input mechanism that depended on whether the run was being recorded would break recording independence outright.
- **The calling agent is the orchestrator; Windower ships capabilities, not workflows.** Capture, Operator, and Control are three peers, and none owns another's lifecycle. Windower ships no code, type, or RPC that performs `start_recording → run_operator → wait → stop_recording` — that sequence is a recipe for the caller and lives in `plugins/claude-code/SKILL.md` and nowhere else. Do not introduce a `DemoRun`, `WorkflowRun`, `RecordingAgent`, or any Windower-side orchestration layer; Codex, a CI job, a shell script, or a human must be able to compose the same primitives in a different order.
- **Session state is disk-persisted** (`~/.windower/sessions/<id>.json`) on every transition, not just in daemon memory — required for crash recovery and `windower status` after a daemon restart.
- **Manifest/timeline paths are always written next to the video file**, not to a separate DB — `manifest.json` and `<recording>.events.json` are the durable record of a recording.
- **No network calls anywhere in MVP.** Daemon and sidecar are local-only; don't introduce telemetry, update-checkers, or cloud calls without discussing it first — it's a stated design property, not an oversight. The **one** scoped exception is `packages/operator` (Phase 19), which calls the user-configured LLM endpoint while a run is active — see `specs/001-windower-mvp/spec.md` §7 for its exact boundaries. Everything outside that package stays local-only.
- **TCC permissions gate CI.** Screen Recording/Accessibility/Microphone can't be granted non-interactively on a GitHub Actions macOS runner. CI covers everything below that line (protocol, schemas, CLI parsing, daemon logic against a fake sidecar); anything that needs a real grant is e2e-gated and run locally per Phase 13 — don't assume "tests pass in CI" means "e2e passes," check the phase file.
- **Post-processing (zoom, ripples, trim, gif/webm) is v1.1** (`tasks/phase-15-post-processing.md`), intentionally out of MVP. Don't implement it early even if it looks small — the point of the MVP is that `EventTimeline`/`OutputManifest` are stable enough for Phase 15 to consume without a schema break.

## Stack quick reference

pnpm + Turborepo · TypeScript + Zod everywhere in TS land · Swift/SPM for the macOS sidecar · JSON-RPC 2.0 over stdio (sidecar) and over a unix socket (daemon) · Vitest (TS) / XCTest (Swift) · Biome (TS) / swift-format (Swift) · `@modelcontextprotocol/sdk` for the MCP server. Full rationale in `specs/001-windower-mvp/plan.md` §2.

## Before you write code

1. Confirm which phase you're in (`STATUS.md`) and read that phase's file in full.
2. Confirm the relevant contract (`contracts/sidecar-protocol.md`, `contracts/cli.md`, or `contracts/mcp-tools.md`) already covers what you're building — extend it deliberately, don't drift from it silently.
3. Check `data-model.md` for the exact Zod shape before inventing a new type — reuse, don't re-derive.
