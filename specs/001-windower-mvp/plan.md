# Windower MVP — Technical Plan

**Spec:** 001
**Companion to:** [`spec.md`](./spec.md)

## 1. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                              Agent surfaces                            │
│   ┌────────────┐   ┌──────────────┐   ┌─────────────────────────────┐  │
│   │  CLI        │   │ MCP server   │   │ Claude Code plugin + skill  │  │
│   │  windower    │   │ (stdio/SSE)  │   │ SKILL.md + manifest.json    │  │
│   └──────┬──────┘   └──────┬───────┘   └──────────────┬──────────────┘  │
│          │                 │                          │                │
│          └─────────────────┴───────────┬──────────────┘                │
│                                        ▼                                │
│                          packages/core (TS)                             │
│                   session mgr · daemon RPC client · types               │
└──────────────────────────────────┬──────────────────────────────────────┘
                                    │ unix socket (JSON-RPC)
                                    ▼
                        apps/daemon (TS, long-running)
              session registry · lifecycle · output/manifest writer
                                    │ stdio (JSON-RPC, framed)
                                    ▼
                    native/macos sidecar (Swift binary)
   ScreenCaptureKit (video+system audio) · AVCaptureDevice (mic)
   AXUIElement (window control) · TCC permission queries
                                    │
                                    ▼
                    native/windows, native/linux — post-MVP,
                    same JSON-RPC contract (Phase 16/17)
```

**Layering rule:** everything above the unix-socket line is OS-agnostic TypeScript. Everything below the stdio line is a native sidecar. The daemon never contains `#if os(macOS)`-equivalent branches — it only ever asks a sidecar what it can do (`describe`) and calls capability-gated methods. This is the mechanism behind the "no rewrite for Windows/Linux" requirement in `spec.md` §2.3.

## 2. Stack decisions

| Layer | Choice | Rationale |
|---|---|---|
| Package manager | **pnpm** | Workspace support, fast, disk-efficient |
| Monorepo | **Turborepo** | Task pipeline/caching; also drives the Swift build via a `swift build` task |
| Language (orchestration) | **TypeScript** | Single language across daemon, CLI, MCP, skill tooling |
| Native sidecar (macOS) | **Swift** + Swift Package Manager | Only realistic way to get ScreenCaptureKit, AVFoundation, and AXUIElement with full fidelity |
| Sidecar transport | **JSON-RPC 2.0 over stdio**, newline-delimited frames | Simple, debuggable (can pipe by hand), no port/socket management, works identically for a future Rust/C# sidecar |
| Daemon transport | **JSON-RPC 2.0 over a unix domain socket** (`~/.windower/daemon.sock`) | Local-only, low overhead, lets multiple client processes (CLI, MCP server) talk to one daemon |
| Video encode | **H.264** (default) / **HEVC** (opt-in) via ScreenCaptureKit + AVAssetWriter | Hardware-accelerated on macOS; HEVC opt-in for smaller files where quality matters more than compatibility |
| Container | **mp4** (default), **mov** | mp4 for portability, mov for lossless-adjacent intermediate use |
| CLI framework | **citty** or **commander** (decide in Phase 7) | Both fine; final pick documented in `research.md` |
| MCP server | **`@modelcontextprotocol/sdk`** | Reference SDK, stdio + SSE transport |
| Validation | **Zod** | Single schema source shared by daemon RPC, CLI arg parsing, and MCP tool input schemas |
| Tests | **Vitest** (TS unit/integration), **XCTest** (Swift sidecar), Playwright-free e2e via a **fixture Electron/SwiftUI app** with deterministic geometry | See Phase 13 |
| Linting/formatting | **Biome** (TS), **swift-format** (Swift) | |
| Packaging | **npm package** wrapping a codesigned/notarized sidecar binary, resolved via `postinstall` or first-run download | See Phase 14 |
| Observability | Structured JSON logs to `~/.windower/logs/`, no telemetry/network calls in MVP (one scoped exception: `packages/operator`'s LLM endpoint, spec §7) | Local-first tool; nothing phones home |

## 3. Monorepo layout

```
windower/
├── apps/
│   └── daemon/                 # long-running session/lifecycle manager
├── packages/
│   ├── core/                   # types, session manager client, Zod schemas (shared contract)
│   ├── cli/                    # `windower` binary
│   ├── mcp-server/             # MCP tool definitions, wraps core
│   └── config/                 # shared biome/tsconfig
├── plugins/
│   └── claude-code/             # plugin manifest + SKILL.md + recipes
├── native/
│   ├── macos/                  # Swift Package: ScreenCaptureKit + AX + AVFoundation sidecar
│   ├── windows/                 # post-MVP (Phase 16)
│   └── linux/                   # post-MVP (Phase 17)
├── fixtures/
│   └── demo-app/                # deterministic-geometry test app for e2e (Phase 13)
├── specs/                       # ← THIS folder
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
└── README.md
```

## 4. Sidecar protocol (summary — full spec in `contracts/sidecar-protocol.md`)

- Transport: JSON-RPC 2.0, one JSON object per line, over the sidecar process's stdin/stdout. stderr is reserved for logs.
- Handshake: daemon spawns the sidecar and immediately calls `describe`, which returns `{ platform, version, capabilities[] }`. Capabilities gate every other call — e.g. `resizeWindow` is only invoked if `describe` advertised `"window-control"`.
- Core methods (MVP, macOS implements all): `describe`, `enumerateTargets`, `getPermissions`, `requestPermission`, `resizeWindow`, `startCapture`, `stopCapture`, `cancelCapture`.
- Streaming: the sidecar pushes `event` notifications (JSON-RPC notifications, no response expected) for cursor/click events during an active capture, which the daemon appends to the session's event-timeline file.
- Errors: a fixed taxonomy (`PERMISSION_DENIED`, `TARGET_NOT_FOUND`, `RESIZE_UNSUPPORTED`, `CAPTURE_FAILED`, `UNSUPPORTED_CAPABILITY`, ...) so the daemon/CLI/MCP layers can react programmatically instead of string-matching.
- Designed against three backends up front (documented per-method in `research.md`): macOS/ScreenCaptureKit (full support), Windows/Windows.Graphics.Capture (no arbitrary-window audio pre-Win11, called out as a capability gap not a protocol change), Linux/PipeWire+xdg-desktop-portal (enumeration and window control require portal user-consent per session — protocol supports an `interactive-consent-required` capability flag for this from day one).

## 5. Daemon & session model

- Single long-running `apps/daemon` process per user session, started lazily on first CLI/MCP call (`windower` auto-spawns it if not running; `windower daemon status|stop` for explicit control) and kept alive across calls.
- One sidecar process per active recording (not one sidecar for the whole daemon lifetime) — isolates a capture crash to one session and keeps ScreenCaptureKit stream state simple.
- Session states: `pending` → `recording` → `stopping` → `finalized` | `canceled` | `failed`. Persisted to `~/.windower/sessions/<id>.json` so `status` and crash-recovery work even if the CLI process that started it has exited.
- Concurrency: multiple sessions allowed simultaneously as long as they target different windows/displays/regions; the daemon rejects a second session on the exact same target to avoid double-writing the same pixels confusingly.
- Idle shutdown: daemon exits after N minutes (configurable) with zero active sessions, to avoid a permanently-resident background process on a dev machine.

## 6. Permissions & security model

- macOS requires three TCC grants: **Screen Recording** (capture), **Accessibility** (window move/resize), **Microphone** (optional, mic capture only). Windower requests each lazily, only when a feature needing it is first used, and `windower doctor` / `check_permissions` reports current grant state without triggering a prompt.
- No network calls from the daemon or sidecar in MVP — everything is local file I/O. (Phase 19's operator adds one scoped exception: `packages/operator` calls the user-configured LLM endpoint while a run is active, and only then — see `spec.md` §7. The daemon/sidecar request paths themselves stay local-only, so a caller that never invokes `run_operator` sees no change.) This keeps the security review scope small: the main risks are (a) an agent recording something sensitive on screen, mitigated by the agent/user choosing the target explicitly, and (b) output files landing in a predictable, permission-appropriate folder (`~/Movies/Windower` default, user-configurable, never auto-uploaded).
- The unix socket for daemon RPC is created with `0600` permissions, user-only.

## 7. Interfaces overview

- **CLI** (`packages/cli`) is the thinnest layer over `packages/core` — every subcommand maps 1:1 to a core session-manager method. Full reference in `contracts/cli.md`.
- **MCP server** (`packages/mcp-server`) exposes the same operations as typed tools with Zod-derived JSON schemas, so tool inputs/outputs are guaranteed to match the CLI's `--json` output shape. Full reference in `contracts/mcp-tools.md`.
- **Claude Code plugin** (`plugins/claude-code`) bundles the CLI/MCP server and a `SKILL.md` describing the record-a-demo workflow end to end (enumerate → size → start → perform actions → stop → report file path + manifest to the user). No new capability beyond CLI/MCP — it's a packaging and instruction layer.

## 8. v1.1 / post-MVP hooks already reserved in the data model

- `EventTimeline` (Phase 10) is the direct input to Phase 15's auto-zoom/ripple renderer — no schema change needed when v1.1 lands.
- `manifest.json`'s `target` object carries enough info (capability set, native target ID) that Phase 16/17 backends produce structurally identical manifests.
- `AudioSettings` already models tracks as a list, so multi-track composition beyond system+mic+narration doesn't require a breaking change.
