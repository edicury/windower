# Spec Status

Current phase: **2 — macOS Sidecar: Enumeration & Permissions** (not started)
Active phase file: `tasks/phase-2-macos-enumeration-permissions.md`
Previous: Phase 1 (Sidecar Protocol & Capability Model) — complete, protocol frozen, see below.

Blocked: none

Planned (MVP, in order): Phase 0 (Foundation) → Phase 1 (Sidecar Protocol) → Phase 2 (macOS Enumeration & Permissions) → Phase 3 (Window Control) → Phase 4 (Video Capture) → Phase 5 (Audio) → Phase 6 (Daemon & Sessions) → Phase 7 (CLI) → Phase 8 (MCP Server) → Phase 9 (Claude Code Plugin + Skill) → Phase 10 (Event Timeline) → Phase 11 (Narration Hook) → Phase 12 (Output Management) → Phase 13 (Testing & Hardening) → Phase 14 (Packaging)

Planned (v1.1): Phase 15 (Post-Processing: trim, auto-zoom, ripples, gif/webm)

Planned (post-MVP): Phase 16 (Windows backend), Phase 17 (Linux backend)

Completed: Phase 0 (Foundation), Phase 1 (Sidecar Protocol & Capability Model)

## Recently completed

- **Phase 1 — Sidecar Protocol & Capability Model** (2026-08-09): protocol frozen.
  - `packages/core/src/schemas/` — Zod schemas + inferred types for every data-model.md type (Rect, CaptureTarget, VideoSettings, AudioTrackConfig/AudioSettings, SessionState/RecordingSession, OutputManifest, TimelineEvent/EventTimeline, PermissionStatus/PermissionReport), 31 unit tests.
  - `packages/core/src/protocol/` — JSON-RPC 2.0 envelope schemas, full method table (`describe`, `enumerateTargets`, `getPermissions`, `requestPermission`, `resizeWindow`, `startCapture`, `stopCapture`, `cancelCapture`), error taxonomy (`SidecarError`/`SidecarErrorCode`), `SidecarClient` (transport-agnostic over any `Duplex`, newline-delimited JSON), notification API (`event`/`log`/`captureEnded`).
  - `packages/core/src/protocol/fake-sidecar.ts` — in-memory TS echo sidecar for testing the client without macOS/real capture; 14 round-trip tests including error-taxonomy propagation and streamed `event` notifications during an active capture.
  - Contract fix: `contracts/sidecar-protocol.md`'s `enumerateTargets.kinds` listed `"app"` as a filterable kind, but `CaptureTarget.kind` only has `display`/`window`/`region`. Corrected to `("display"|"window")[]` (region has no independent ID, never independently enumerated per data-model.md) and updated the implementation to match — no other drift found.
  - Verified: `pnpm --filter @windower/core build/typecheck/test` all pass, 45/45 tests, zero `any`.

- **Phase 0 — Foundation** (2026-08-09): monorepo scaffolding stood up, no functional capability yet.
  - pnpm workspace (`apps/*`, `packages/*`, `plugins/*`, `native/*`) + root `package.json` + `turbo.json`.
  - `packages/config` — shared `biome.json` + base `tsconfig.base.json`.
  - Empty-but-wired TS packages: `packages/core`, `packages/cli`, `packages/mcp-server`, `apps/daemon`, `plugins/claude-code` — each builds via `tsc --build` and is driven by `turbo run build`/`test`/`typecheck`.
  - `plugins/claude-code` — `.claude-plugin/plugin.json` + placeholder `SKILL.md` (real authoring is Phase 9).
  - `native/macos` — Swift Package (`Package.swift`, macOS 12.3+ floor), executable target `windower-sidecar-macos` that hand-rolls a `describe` JSON-RPC-ish response over stdio (proves plumbing only — real protocol is Phase 1), plus an XCTest placeholder target. Wired into turbo via a thin `native/macos/package.json` (`build` → `swift build`, `test` → `swift test`).
  - `.gitignore`, root `README.md`, `.github/workflows/ci.yml` (macOS runner: install → lint → typecheck → build → test).
  - Verified locally: `pnpm install`, `pnpm build`, `pnpm turbo run test` (12/12 tasks, TS + Swift), `pnpm turbo run lint`/`typecheck` all exit 0.
  - Deviations from phase file: added `native/*` to the pnpm workspace globs (not explicitly listed in the phase file's workspace bullet, but required so turbo can drive `swift build`/`swift test` as a workspace task); TS `test`/`typecheck` scripts use `vitest run --passWithNoTests` / `tsc --build --noEmit` since no real source exists yet.

---
_Update this file at the end of each work session._
