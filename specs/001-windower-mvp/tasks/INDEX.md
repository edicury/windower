# Phase Index

## MVP

| Phase | Title | File |
|---|---|---|
| 0 | Foundation ✅ | `phase-0-foundation.md` |
| 1 | Sidecar Protocol & Capability Model ✅ | `phase-1-sidecar-protocol.md` |
| 2 | macOS Sidecar: Enumeration & Permissions ✅ | `phase-2-macos-enumeration-permissions.md` |
| 3 | Window Control ✅ | `phase-3-window-control.md` |
| 4 | Video Capture ✅ | `phase-4-video-capture.md` |
| 5 | Audio ✅ | `phase-5-audio.md` |
| 6 | Daemon & Session Lifecycle ✅ | `phase-6-daemon-session-lifecycle.md` |
| 7 | CLI ✅ | `phase-7-cli.md` |
| 8 | MCP Server ✅ | `phase-8-mcp-server.md` |
| 9 | Claude Code Plugin + Skill ✅ | `phase-9-claude-code-plugin-skill.md` |
| 10 | Event Timeline ✅ | `phase-10-event-timeline.md` |
| 11 | Narration Hook ✅ | `phase-11-narration-hook.md` |
| 12 | Output Management ✅ | `phase-12-output-management.md` |
| 13 | Testing & Hardening ✅ | `phase-13-testing-hardening.md` |
| 14 | Packaging | `phase-14-packaging.md` |

## v1.1

| Phase | Title | File |
|---|---|---|
| 15 | Post-Processing (trim, auto-zoom, ripples, gif/webm) | `phase-15-post-processing.md` |

## v1.2

| Phase | Title | File |
|---|---|---|
| 19 | Operator (guided agent: perceive, input, record) ✅ | `phase-19-operator.md` |

## v1.3

| Phase | Title | File |
|---|---|---|
| 20 | Daemon-Optional (`npx windower record` with zero daemon management) ✅ | `phase-20-daemon-optional.md` |

## v1.4

| Phase | Title | File |
|---|---|---|
| 21 | Capture/Control Split (single-writer ScreenCaptureKit architecture) ✅ | `phase-21-capture-control-broker.md` |

## v1.5

| Phase | Title | File |
|---|---|---|
| 22 | Operator: AX-First Observation and the Planner/Executor Split | `phase-22-operator-ax-first.md` |

## v1.6

| Phase | Title | File |
|---|---|---|
| 23 | CI Release Automation | `phase-23-ci-release-automation.md` |

## Post-MVP

| Phase | Title | File |
|---|---|---|
| 16 | Windows Backend | `phase-16-windows-backend.md` |
| 17 | Linux Backend | `phase-17-linux-backend.md` |

## Ancillary (unordered, non-blocking)

| Phase | Title | File |
|---|---|---|
| 18 | Marketing Media (dogfood recordings for windower-site) ✅ | `phase-18-marketing-media.md` |

Phase 18 has no dependency on 15/16/17 and no phase depends on it — it's dogfooding work to fill a real media gap on `windower-site` while Phase 14 is blocked on Apple Developer ID provisioning. Complete (2026-08-09) — see STATUS.md. Surfaced two real capture bugs along the way (bugs.spec.md #4-6), worth picking up before/alongside Phase 14.

Ordering is mostly sequential (0 → 14) since each phase's sidecar/daemon surface builds on the last, but 7/8/9 (interfaces) can be parallelized once 6 (daemon) lands, and 10/11/12 can be parallelized once 4/5 (capture) land.

Phase 20 came out of Phase 19's live testing, where the daemon's frozen-at-spawn environment broke `windower operate` from a shell that *had* the API key. It depends on **Phase 19** (it changes `operate`'s blocking semantics and routes its secret/env resolution) and on **Phase 12** (output management — the engine extraction moves `output-resolver.ts`), and it carries Phase 19's unmet live-verification exit criteria as its own final task. It should land before **Phase 14**'s clean-machine install verification, since "install to first recording" is exactly the path Phase 20 rewrites.

Phase 19 depends on **Phase 10** (event timeline — needed for the `TimelineEvent.source` tag) and **Phase 12** (output management — needed for path conventions its `OperatorRun`/manifest fields reuse), but is otherwise independent of 15/16/17 and can be built in parallel with them. If Phase 19 lands before Phase 15 (Post-Processing), Phase 15 should consume Phase 19's `source` tag directly — e.g. zooming specifically on operator-driven clicks, distinct from human ones — rather than treating all clicks uniformly.

Phase 22 depends on **Phase 19** (operator) and **Phase 21** (the capture/control split — it adds a method to the *control* surface, and the whole point of putting it there is that a control-surface process is capture-free and lock-free, which only became true in Phase 21). It comes out of Phase 21's live testing, where real runs cost several dollars and consumed 29–30 of 30 steps for a task a human does in four clicks: the operator's only percept is a screenshot, so every coordinate is an estimate and every misestimate costs round trips. It is independent of Phases 14/15/16/17 and can be built in parallel with them, but it should **not** be scheduled ahead of Phase 21's six carried-over live-verification items — those still gate `bugs.spec.md` #6, and Phase 22 changes the operator loop those harnesses drive. If Phase 15 (Post-Processing) lands after it, note that `OperatorStep.observations` replaces `observationRef`, so Phase 15 consumes the new shape rather than the Phase 19 one.

Phase 23 depends on **Phase 14** (Packaging) — it automates Phase 14's manual publish path and its task list traces directly to bugs and open items recorded in `phase-14-packaging.md`'s "Publish status" log (the chmod/executable-bit bug, dependency-graph publish ordering, the never-compiled `sidecar-macos-x64` binary). It is independent of Phases 15–22 and can be built in parallel with any of them, but its own live verification (a genuinely clean-machine install) is also the last unmet piece of Phase 14's exit criteria, so landing it is what finally closes Phase 14 out.

Phase 21 depends on **Phase 19** (operator) and **Phase 20** (the `@windower/engine` extraction and daemon lifecycle hardening it builds on directly — the broker lock and `ControlEngine` are new peers of `RecordingEngine` inside that package). It is the architectural follow-up to `bugs.spec.md` #6, found during Phase 20's live verification and chased across several follow-up sessions before this phase was written — see the phase file's "Context / why now" for the full evidence chain (OS-level `log stream` tracing, external research on ScreenCaptureKit's `replayd` behavior, and a file:line map of which native calls do and don't touch ScreenCaptureKit). It supersedes bug #6's stopgap fix (operator reusing the recording's sidecar as a special case) with a general, construction-enforced invariant. Should land before Phase 14 (Packaging) if at all possible — it changes `native/macos`'s binary topology, and packaging/notarization work is cheaper to do once against the final shape than twice.
