## Phase 17 — Linux Backend (post-MVP)

**Goal:** Implement `native/linux` against the Phase 1 protocol, with explicit, documented capability gaps for Wayland's stricter security model rather than protocol changes.

- 🔵 `native/linux` — Rust sidecar using `pipewire-rs` + `ashpd` (xdg-desktop-portal Rust bindings) implementing the JSON-RPC-over-stdio protocol.
- 🔵 `startCapture` via `org.freedesktop.portal.ScreenCast` — note this flow is inherently interactive (portal shows the OS's own picker UI for display/window/region selection), which is a meaningfully different UX from macOS/Windows's programmatic `enumerateTargets` → `startCapture` — document how the daemon/CLI/MCP layer surfaces this (e.g. `enumerateTargets` returns an empty/partial list with a capability flag telling callers to expect a portal picker on `startCapture` instead).
- 🔵 `enumerateTargets` for windows: capability-gated per compositor per `research.md` §2 — full support only where `wlr-foreign-toplevel-management` is available (wlroots-based compositors: Sway, etc.), `enumerate.windows: false` elsewhere (GNOME, KDE) with display-only enumeration as the fallback.
- 🔵 `resizeWindow`: capability-gated similarly — supported under X11/XWayland via EWMH (`_NET_MOVERESIZE_WINDOW`), `window-control: false` under native Wayland.
- 🔵 Audio via PipeWire's audio graph (separate integration from the ScreenCast video path, per `research.md` §2).
- 🔵 Event timeline: `eventTimeline: false` by default per `research.md` §2's noted gap (no standard global input API on Wayland for security reasons); revisit per-compositor input-capture portals as they mature.
- 🔵 Packaging: `@windower/sidecar-linux-x64` optional-dependency package.

**Exit criteria**

- Core recording flow (portal-driven target selection → capture → finalized file + manifest) works end-to-end on at least one X11 and one Wayland (wlroots-based) desktop.
- Every capability gap is surfaced via `describe()`'s capability list and produces a clear `UNSUPPORTED_CAPABILITY` error when a caller attempts a gated operation — never a silent no-op or crash.
- Zero changes to any TS package outside `native/linux` and its packaging glue, same bar as Phase 16.
