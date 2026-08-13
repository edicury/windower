# Windower — AI-Native Screen Recorder (MVP)

**Spec:** 001
**Status:** Draft
**Owner:** edicury
**Last updated:** 2026-08-09

## Execution process (mandatory)

**Every phase and task in this spec must be executed by a subagent** — the main thread delegates the work rather than doing it inline. The main thread's job is to decompose the phase, dispatch subagents (in parallel where the work is independent), and integrate their results.

The only exception is a task that is **too straightforward to warrant delegation** — a trivial one-line edit, a mechanical rename, a config tweak, or a quick lookup the main thread can finish in a single step. When in doubt, delegate: a subagent keeps the main context lean and forces a clean task boundary.

## 1. Overview

Windower is a Screen Studio / Loom-style screen recorder built **for AI agents as the primary operator**, not for humans clicking a record button. An agent — running in Claude Code, Claude Desktop, or any MCP-capable harness — uses Windower to:

1. Enumerate what's on screen (displays, windows, running apps)
2. Position and size a target window deterministically
3. Configure video/audio settings
4. Start a recording, perform the demo (click through a UI, run a CLI, narrate), then stop
5. Receive back a video file plus structured metadata (dimensions, duration, target, event timeline) it can reason about or hand to the user

Windower ships the same way chrome-skills does: as an installable **plugin + skill set** (CLI binary, MCP server, `SKILL.md`) that teaches an agent the recording workflow, rather than as a GUI app a person operates.

### 1.1 Architecture — two peer capabilities

Windower provides **capabilities, not a workflow.** There are two, and they are peers — neither owns, references, or sequences the other:

- **Capture** — target enumeration, recording, the event timeline. On macOS it is the only capability permitted to hold ScreenCaptureKit state.
- **Control** — window activation, resize, focus. Zero ScreenCaptureKit dependency on macOS.

**Orchestration is the caller's, not Windower's.** The coding agent using Windower — Claude Code, Codex, a shell script, a CI job, a human at a terminal — already has orchestration capabilities, and it owns the workflow, including driving the UI (via its own computer-use tool, a browser skill, or manual scripting):

```
             Coding Agent
             (orchestrator, drives the UI with its own tools)
            /              \
           /                \
      Capture             Control
         |
    native capture
```

Windower deliberately introduces **no** `DemoRun`, `WorkflowRun`, `RecordingAgent`, or equivalent orchestration abstraction, and no "orchestration plane" of its own. Duplicating orchestration the caller already provides would buy nothing and would lock every caller into one workflow. Claude Code MAY use subagents internally for concurrency or isolation — that is a Claude Code implementation detail, not a Windower domain concept.

### 1.2 The usage recipe (caller-side, not a Windower workflow)

The intended pattern is a **recipe for the calling agent**, documented in the Claude Code skill (`plugins/claude-code/SKILL.md`). Other agents are free to compose the same primitives differently:

```
start_recording(target)
# the caller drives the UI in between, using its own tools —
# computer-use for native/desktop UI, a browser skill for web UI
stop_recording(session)
```

The two-call `start_recording`/`stop_recording` pattern is the entire recipe: `start_recording` returns immediately with a `sessionId`, the caller performs whatever on-screen actions it wants demoed using tools it already has, then `stop_recording` finalizes the video. Windower never drives the screen itself and never observes it for decision-making — it only records, reports targets, and resizes windows.

A recording must not know what is driving the screen — Claude Code directly, another agent, Playwright, a human, or nothing at all — and does not care (see `data-model.md`'s `RecordingSession` invariant).

## 2. Goals & non-goals

### 2.1 Goals (MVP)

- Runs on **macOS** (12.3+, ScreenCaptureKit availability floor).
- An agent can **enumerate** displays, windows, and running applications with stable identifiers.
- An agent can **resize and reposition** a target window to exact pixel dimensions before recording, via the Accessibility API.
- An agent can **start a recording** of a display, a window, or an arbitrary screen region, and the call returns immediately with a `sessionId` — recording runs in a background **daemon** while the agent continues acting (clicking, typing, running commands) to perform the demo.
- An agent can **stop** a recording by `sessionId` and receive a finalized video file path plus a JSON **manifest** (resolution, fps, codec, duration, target, audio tracks, event-timeline path).
- Video settings are configurable: resolution, fps, codec (H.264/HEVC), container (mp4/mov), bitrate/quality.
- Audio is configurable: system audio and/or microphone, captured as **separate tracks**.
- An agent can supply a **narration track** (a pre-generated audio file, e.g. TTS output) with a time offset to be muxed into the final recording.
- The real cursor is recorded in the video, and a **click/keystroke event timeline** (timestamped JSON) is written alongside it — the substrate for v1.1 visual effects and for agents that want to reason about what happened when.
- Recordings save to a **configurable output folder** with a predictable naming scheme.
- All of the above is reachable via three interfaces: a **CLI**, an **MCP server**, and a **Claude Code plugin + skill** that teaches the workflow. All three sit on the same underlying daemon/session contract.
- Permission state (Screen Recording, Accessibility, Microphone TCC grants) is inspectable (`doctor`/`check_permissions`) so an agent can detect and explain a blocked recording instead of failing silently.

### 2.2 Non-goals (MVP)

Explicitly out of scope for v1, called out because the architecture must not preclude them later:

- **Windows and Linux support.** MVP is macOS-only. The sidecar protocol (§ plan.md) is designed against Windows.Graphics.Capture and PipeWire/xdg-desktop-portal constraints so these can land as additional sidecar implementations without changing the CLI/MCP/skill/daemon layers. See Phase 16/17.
- **Post-processing.** Trim, background/padding, rounded corners, gif/webm export, and — critically — **click ripples, cursor highlight, and auto-zoom-on-click** are v1.1 (Phase 15), built on top of the MVP's event timeline.
- **GUI app for human operators.** No windowed app, no menu bar UI in MVP. A human can use the CLI directly, but nothing is designed around that experience.
- **Cloud upload / sharing / hosted playback.** Purely local: record → save to a folder. No accounts, no sync.
- **Editing timeline / NLE.** No cut/splice UI. An agent could re-encode with ffmpeg itself if needed; Windower doesn't do editing.
- **Multi-monitor simultaneous capture** (recording 2+ displays into one output). Single target per session in MVP; multiple concurrent *sessions* on different targets are allowed (see Phase 6).
- **Live streaming / low-latency preview.** Recording is file-based, not a real-time stream to a viewer.
- **Non-Claude agent harnesses as first-class citizens.** The MCP server and CLI are harness-agnostic by construction, but the "plugin + skill" packaging targets Claude Code specifically in MVP.
- **Windower does not drive UI** — that is the calling agent's responsibility, via its own tools (computer-use, browser skills, or manual scripting).

### 2.3 Future-facing design constraints

Not built in MVP, but the architecture must not preclude them:

- **Windows/Linux backends.** The `CaptureBackend` sidecar contract (JSON-RPC over stdio, capability-negotiated) must be implementable by a non-Swift, non-macOS process without protocol changes.
- **Real-time overlay rendering** (click ripples, zoom) could eventually move from post-process to live compositing during capture. The event-timeline data model must support both consumption modes.
- **Pluggable narration sources.** MVP accepts a pre-rendered audio file; a future TTS-provider abstraction could generate it inline. The narration-mux mechanism must not assume a specific audio source.
- **Multi-track / multi-target composition** (e.g., picture-in-picture of a window over a full display) is not built, but the manifest's target/track model should not have to be redesigned to add it.

## 3. Personas

| Persona | Description | Primary use cases |
|---|---|---|
| **AI Agent (primary)** | An LLM-driven agent (Claude Code, Claude Desktop, custom MCP client) operating a computer to complete a task | Enumerate targets, size a window, record a demo of its own actions, narrate, stop, hand off the file |
| **Agent Author / Developer** | Person building an agent or skill that uses Windower | Install the plugin, read `SKILL.md`, call CLI/MCP in scripts or CI |
| **Human Operator (secondary)** | Person running the CLI directly for a quick manual recording | `windower record --window Safari --out ~/demo.mp4` |

## 4. User stories

### 4.1 Discovery

- **US-01.** As an agent, I can list all displays, windows, and running applications with stable IDs, titles, app names, bounds, and current focus state, so I can pick a recording target.
- **US-02.** As an agent, I can check permission status (Screen Recording, Accessibility, Microphone) before attempting to record, so I can surface a clear "grant this permission" message instead of a cryptic failure.

### 4.2 Target preparation

- **US-03.** As an agent, I can resize and reposition a specific window to exact width/height/x/y before recording, so the output video has deterministic, agent-specified dimensions.
- **US-04.** As an agent, if a target window refuses to resize (e.g., a fixed-size dialog), I receive a clear error/capability response instead of a silently wrong recording.

### 4.3 Recording

- **US-05.** As an agent, I can start a recording of a window, a display, or a rectangular region, specifying resolution, fps, codec, container, and quality, and get back a `sessionId` immediately without blocking.
- **US-06.** As an agent, I can perform UI actions (clicks, typing, running shell commands) while a recording is in progress, because recording happens in a background daemon, not in my own execution thread.
- **US-07.** As an agent, I can enable system audio and/or microphone capture as separate tracks when starting a recording.
- **US-08.** As an agent, I can query a recording session's status (running, elapsed time, target) mid-recording.
- **US-09.** As an agent, I can stop a recording by `sessionId` and receive the final file path plus a manifest describing exactly what was captured.
- **US-10.** As an agent, I can cancel/discard an in-progress recording without producing a final file.

### 4.4 Narration & timeline

- **US-11.** As an agent, I can supply a pre-generated audio file plus an offset to be muxed into the recording as a narration track when I stop the session.
- **US-12.** As an agent, I receive a timestamped JSON event timeline of cursor position and clicks (and, where available, keystrokes) alongside the video, so I — or a v1.1 post-processor — can reason about what happened when.

### 4.5 Output

- **US-13.** As an agent, I can configure an output folder and a filename template, and every recording lands there with a companion `manifest.json`.
- **US-14.** As an agent or human operator, I can run `windower doctor` to see permission state, daemon health, and sidecar availability in one call.

### 4.6 Interfaces

- **US-15.** As an agent running in an MCP-capable harness, I can call `list_targets`, `start_recording`, `stop_recording`, `get_session`, and `check_permissions` as MCP tools with the same semantics as the CLI.
- **US-16.** As an agent running in Claude Code, installing the Windower plugin gives me a `SKILL.md` that teaches the full record-a-demo workflow (frame → size → start → act → stop → report) without me having to discover the CLI flags myself.
- **US-17.** As a human operator, I can run the CLI directly for a one-off recording without touching MCP or Claude Code at all.

## 5. Acceptance checklist (MVP exit criteria)

Traces to phase exit criteria in `tasks/`. All must be green for MVP to ship.

- [ ] `windower targets --json` lists displays, windows, and apps with stable IDs on a real macOS machine. (Phase 2)
- [ ] `windower doctor` correctly reports Screen Recording / Accessibility / Microphone permission state, before and after granting. (Phase 2)
- [ ] `windower resize --window <id> --width 1280 --height 720` moves and resizes a real window to those exact dimensions (verified post-resize). (Phase 3)
- [ ] A window, display, and region recording each produce a valid, playable video file at the requested resolution/fps/codec. (Phase 4)
- [ ] System audio and mic record as separate, correctly-synced tracks. (Phase 5)
- [ ] `start` returns a `sessionId` in under 1s and does not block the caller; `stop <id>` finalizes a valid file; two concurrent sessions on different targets both complete correctly. (Phase 6)
- [ ] CLI (`targets|record|start|stop|status|doctor|config`) works end-to-end with both human-readable and `--json` output. (Phase 7)
- [ ] MCP server exposes all five tools and a real MCP client (Claude Desktop/Code) can drive a full record-a-demo loop through it. (Phase 8)
- [ ] Installing the Claude Code plugin gives Claude a `SKILL.md`-driven workflow that records a real demo end-to-end without the operator specifying CLI flags manually. (Phase 9)
- [ ] Every recording produces a cursor/click event-timeline JSON alongside the video. (Phase 10)
- [ ] A supplied narration audio file is muxed into the output at the correct offset. (Phase 11)
- [ ] Every recording writes to the configured output folder with a `manifest.json` matching the documented schema. (Phase 12)
- [ ] Fixture-app e2e suite is green in CI (or documented as locally-gated if CI cannot hold TCC permissions); soak test: 30-minute recording completes without drift or crash. (Phase 13)
- [ ] Sidecar binary is codesigned + notarized; `npm install`/plugin install works from a clean machine through first successful recording. (Phase 14)

## 6. Design references

None yet — Windower is CLI/MCP/skill-first with no GUI in MVP. Revisit if a companion human-facing app is ever built.

## 7. Network policy

No network calls anywhere in Windower: the daemon and sidecar are local-only, with no telemetry, no update-checker, and no cloud call of any kind.
