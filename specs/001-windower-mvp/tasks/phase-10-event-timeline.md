## Phase 10 — Event Timeline

**Goal:** Capture cursor position and click events (best-effort keystrokes) into a timestamped JSON file alongside every recording — the substrate for v1.1's auto-zoom/ripple rendering and for agents that want to reason about "what happened when." Per the confirmed MVP/v1.1 split (`spec.md` §2.3), this phase captures only — no visual rendering.

- 🔵 macOS sidecar: `CGEventTap` (requires Accessibility, already granted per Phase 2/3) capturing `mouseMoved`, `leftMouseDown/Up`, `rightMouseDown/Up`, and key events, scoped to the active capture session's time window.
- 🔵 Cursor-move sampling rate cap (default 30Hz) to bound file size on long recordings — implemented as a throttle in the event tap callback, not a protocol-level setting in MVP.
- 🔵 Coordinate translation: event-tap coordinates → the same pixel space used in `CaptureTarget.bounds`, so timeline coordinates are directly usable against the recorded video's frame.
- 🔵 Stream `event` JSON-RPC notifications per `contracts/sidecar-protocol.md` during active capture; daemon appends them to `<recording>.events.json` incrementally (not buffered to the end — a crash mid-recording still leaves a partial, valid-JSON-lines-or-truncatable file).
- 🔵 `capabilities.keystrokes` correctly reflects whether key capture succeeded (e.g., some secure-input contexts block key events) — never silently claim a capability that didn't actually work this session.
- 🔵 `EventTimeline` schema validation (`data-model.md`) on write.

**Exit criteria**

- Matches `spec.md` acceptance item: every recording produces a cursor/click event-timeline JSON alongside the video.
- A recorded click's timestamp in `events.json`, cross-referenced against the video frame at that timestamp, visually lines up (manual spot check with a clap/click-test fixture).
- Long-recording test (10+ min) produces a timeline file of reasonable size (sampling cap working) without measurable capture-loop performance impact.
