## Phase 2 — macOS Sidecar: Enumeration & Permissions

**Goal:** First real macOS implementation: bring up the Swift sidecar's JSON-RPC loop for real against the frozen Phase 1 protocol, and implement `enumerateTargets`, `getPermissions`, `requestPermission`.

- ✅ `native/macos/Sources/` — JSON-RPC stdio loop in Swift (newline-delimited, matching Phase 1's envelope exactly), `describe` returns the real capability list for this backend (see `contracts/sidecar-protocol.md`).
- ✅ `enumerateTargets` — `SCShareableContent.current` for displays/windows/apps; map to `CaptureTarget` (`data-model.md`); stable IDs from `CGWindowID`/`CGDirectDisplayID`.
- ✅ `getPermissions` — query Screen Recording (`CGPreflightScreenCaptureAccess`), Accessibility (`AXIsProcessTrusted`), Microphone (`AVCaptureDevice.authorizationStatus`) without prompting.
- ✅ `requestPermission` — trigger the OS prompt for one kind (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])`, `AVCaptureDevice.requestAccess`).
- ✅ `packages/core` wires a real `SidecarProcess` spawner (child_process, resolves the sidecar binary path — see Phase 14 for the packaged-binary resolution strategy; dev builds resolve `native/macos/.build/debug/windower-sidecar-macos`).
- ✅ Window identity stability test: enumerate, note IDs, enumerate again 5s later with no window changes, confirm IDs match.

**Exit criteria**

- On a real Mac, with permissions not yet granted: `getPermissions` correctly reports `not_determined`/`denied` per kind.
- `requestPermission("screenRecording")` triggers the real macOS prompt; after granting, `getPermissions` reports `granted`.
- `enumerateTargets` lists at least: all connected displays, all visible windows with non-empty titles, matching what's actually on screen (spot-checked manually).
- Matches `spec.md` acceptance item: "`windower targets --json` lists displays, windows, and apps with stable IDs" (CLI itself lands in Phase 7, but the sidecar capability is proven here first via a throwaway test harness).

---

**Phase 2 done — sidecar enumeration/permissions live, Phase 3 may begin.** (2026-08-09)

- `native/macos/`: real newline-delimited JSON-RPC 2.0 stdio loop (split into `WindowerSidecarCore` library target + thin executable, required for `@testable` linking under SwiftPM). `describe` advertises exactly `enumerate.displays`/`enumerate.windows`/`enumerate.apps` (capture/window-control/eventTimeline correctly withheld — later phases). `enumerateTargets` via `SCShareableContent`, converts points→pixels via `backingScaleFactor` before crossing the sidecar boundary. `getPermissions`/`requestPermission` wired to real `CGPreflightScreenCaptureAccess`/`AXIsProcessTrusted`/`AVCaptureDevice` APIs. Unknown methods and TCC denials map to the correct taxonomy codes (`UNSUPPORTED_CAPABILITY`, `PERMISSION_DENIED`). 11/11 XCTest passing, including one integration test piping real requests through the compiled binary.
- `packages/core/src/process/`: `resolveSidecarBinaryPath()` (env override → dev `.build/debug` path, repo root found by walking up to `pnpm-workspace.yaml`) and `SidecarProcess`/`spawnSidecar()` wrapping `child_process.spawn`, wiring stdio into `SidecarClient`, clean SIGTERM→SIGKILL teardown, in-flight request rejection on crash/kill. 10 new tests (9 against a fake Node fixture, 1 integration test against the real Swift binary — skips gracefully if absent). 55/55 `@windower/core` tests passing.
- Full `pnpm build` + `turbo run test` verified clean across both TS and Swift after integrating both agents' work.
- Not verified (needs interactive GUI/TCC on a real Mac, can't be automated per CLAUDE.md's CI note): actual permission-prompt dialogs appearing, and `enumerateTargets` output against a granted-permissions real screen. API calls are correct per Apple's docs; flagging per exit criteria rather than claiming full verification.
