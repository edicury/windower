## Phase 1 — Sidecar Protocol & Capability Model

**Goal:** Freeze the JSON-RPC contract between the daemon and any native sidecar *before* writing macOS-specific code, so Windows/Linux backends never force a protocol change. This is the phase that delivers the "no rewrite later" guarantee from `spec.md` §2.3.

- 🔵 `packages/core/src/schemas/` — Zod schemas for every type in `data-model.md` (`CaptureTarget`, `VideoSettings`, `AudioSettings`, `RecordingSession`, `OutputManifest`, `TimelineEvent`, `PermissionReport`, `Rect`).
- 🔵 `packages/core/src/protocol/` — JSON-RPC 2.0 request/response/notification envelope types, the method table from `contracts/sidecar-protocol.md`, and the error taxonomy as a discriminated union / enum.
- 🔵 `packages/core/src/protocol/sidecar-client.ts` — a transport-agnostic client (newline-delimited JSON over any `Duplex` stream) that speaks the protocol: `describe()`, `enumerateTargets()`, `resizeWindow()`, `startCapture()`/`stopCapture()`/`cancelCapture()`, plus a notification emitter for `event`/`log`/`captureEnded`.
- 🔵 A trivial in-memory / echo test sidecar (TypeScript, not Swift) implementing the protocol against a fake backend, used purely to unit-test `sidecar-client.ts` without needing macOS or real capture.
- 🔵 Write `research.md` §2's cross-platform feasibility matrix (already drafted in the spec — verify/refine here if implementation reveals a gap) and confirm every method still holds for Windows/Linux with only capability-flag differences.
- 🔵 Document the capability-gating rule as a lint-enforceable pattern: every sidecar-client call site in `packages/core` must check `describe().capabilities` before invoking a gated method, surfaced as a code review checklist item (not necessarily an automated lint in MVP).

**Exit criteria**

- `packages/core`'s protocol types compile and are consumed with zero `any`.
- Unit tests: `sidecar-client.ts` round-trips every method against the fake echo sidecar, including error-taxonomy propagation and streamed `event` notifications.
- `contracts/sidecar-protocol.md` is up to date with the actual shipped types (no drift between spec and code).
- Explicit sign-off note in this file once done: "protocol frozen — Phase 2 may begin."

---

**protocol frozen — Phase 2 may begin.** (2026-08-09)

Implemented in `packages/core/src/schemas/` (data-model.md Zod types) and `packages/core/src/protocol/` (JSON-RPC envelope, method table, error taxonomy, `SidecarClient`, in-memory `FakeSidecar`). 45/45 tests passing, zero `any`. One contract fix made during implementation: `enumerateTargets`'s `kinds` filter listed `"app"` as a valid kind, but `CaptureTarget.kind` (data-model.md) only has `display`/`window`/`region` — corrected `contracts/sidecar-protocol.md` to `("display"|"window")[]` (region has no independent ID per data-model.md, never independently enumerated) and updated the implementation to match. No other drift between contract and code.
