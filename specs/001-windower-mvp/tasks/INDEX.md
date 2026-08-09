# Phase Index

## MVP

| Phase | Title | File |
|---|---|---|
| 0 | Foundation | `phase-0-foundation.md` |
| 1 | Sidecar Protocol & Capability Model | `phase-1-sidecar-protocol.md` |
| 2 | macOS Sidecar: Enumeration & Permissions | `phase-2-macos-enumeration-permissions.md` |
| 3 | Window Control | `phase-3-window-control.md` |
| 4 | Video Capture | `phase-4-video-capture.md` |
| 5 | Audio | `phase-5-audio.md` |
| 6 | Daemon & Session Lifecycle | `phase-6-daemon-session-lifecycle.md` |
| 7 | CLI | `phase-7-cli.md` |
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

## Post-MVP

| Phase | Title | File |
|---|---|---|
| 16 | Windows Backend | `phase-16-windows-backend.md` |
| 17 | Linux Backend | `phase-17-linux-backend.md` |

Ordering is mostly sequential (0 → 14) since each phase's sidecar/daemon surface builds on the last, but 7/8/9 (interfaces) can be parallelized once 6 (daemon) lands, and 10/11/12 can be parallelized once 4/5 (capture) land.
