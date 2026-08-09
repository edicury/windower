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
| 6 | Daemon & Session Lifecycle | `phase-6-daemon-session-lifecycle.md` |
| 7 | CLI ✅ | `phase-7-cli.md` |
| 8 | MCP Server | `phase-8-mcp-server.md` |
| 9 | Claude Code Plugin + Skill | `phase-9-claude-code-plugin-skill.md` |
| 10 | Event Timeline | `phase-10-event-timeline.md` |
| 11 | Narration Hook | `phase-11-narration-hook.md` |
| 12 | Output Management | `phase-12-output-management.md` |
| 13 | Testing & Hardening | `phase-13-testing-hardening.md` |
| 14 | Packaging | `phase-14-packaging.md` |

## v1.1

| Phase | Title | File |
|---|---|---|
| 15 | Post-Processing (trim, auto-zoom, ripples, gif/webm) | `phase-15-post-processing.md` |

## v1.2

| Phase | Title | File |
|---|---|---|
| 19 | Operator (guided agent: perceive, input, record) | `phase-19-operator.md` |

## v1.3

| Phase | Title | File |
|---|---|---|
| 20 | Daemon-Optional (`npx windower record` with zero daemon management) | `phase-20-daemon-optional.md` |

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
