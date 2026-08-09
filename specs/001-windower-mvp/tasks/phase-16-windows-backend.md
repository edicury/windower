## Phase 16 — Windows Backend (post-MVP)

**Goal:** Implement `native/windows` against the exact Phase 1 sidecar protocol — no changes to `packages/core`, `packages/cli`, `packages/mcp-server`, `apps/daemon`, or `plugins/claude-code`. This phase is the test of the "no rewrite" architectural bet.

- 🔵 `native/windows` — Rust or C# sidecar (decide at implementation time; C# has the most direct WGC bindings via WinRT projections, Rust via `windows-rs`) implementing the same JSON-RPC-over-stdio protocol.
- 🔵 `enumerateTargets` via `GraphicsCaptureItem` enumeration (monitors always; windows via `HWND` enumeration + `IsWindowVisible`/title filtering).
- 🔵 `resizeWindow` via `SetWindowPos`/Win32.
- 🔵 `startCapture`/`stopCapture` via `Direct3D11CaptureFramePool` → Media Foundation encoder (H.264 hardware encode via Media Foundation Transform).
- 🔵 Audio: WASAPI loopback for system audio; per capability matrix (`research.md` §2), advertise `audio.system.perApp: false` pre-Win11, `true` on Win11+ where `AudioCaptureContext`-per-app is available.
- 🔵 Event timeline via `SetWindowsHookEx` low-level mouse/keyboard hooks.
- 🔵 Packaging: signed Windows binary, `@windower/sidecar-win32-x64` optional-dependency package following the same pattern as Phase 14's macOS packaging.

**Exit criteria**

- Full `spec.md` MVP acceptance checklist re-run against Windows and green, modulo capability gaps explicitly documented in `research.md` §2 (e.g. pre-Win11 per-app audio).
- Zero changes to any TS package outside `native/windows` and its packaging glue — if this isn't true, the protocol had a gap Phase 1 missed and that gap should be retrofitted into `contracts/sidecar-protocol.md` as a lesson for Phase 17.
