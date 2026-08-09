## Phase 2 — macOS Sidecar: Enumeration & Permissions

**Goal:** First real macOS implementation: bring up the Swift sidecar's JSON-RPC loop for real against the frozen Phase 1 protocol, and implement `enumerateTargets`, `getPermissions`, `requestPermission`.

- 🔵 `native/macos/Sources/` — JSON-RPC stdio loop in Swift (newline-delimited, matching Phase 1's envelope exactly), `describe` returns the real capability list for this backend (see `contracts/sidecar-protocol.md`).
- 🔵 `enumerateTargets` — `SCShareableContent.current` for displays/windows/apps; map to `CaptureTarget` (`data-model.md`); stable IDs from `CGWindowID`/`CGDirectDisplayID`.
- 🔵 `getPermissions` — query Screen Recording (`CGPreflightScreenCaptureAccess`), Accessibility (`AXIsProcessTrusted`), Microphone (`AVCaptureDevice.authorizationStatus`) without prompting.
- 🔵 `requestPermission` — trigger the OS prompt for one kind (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])`, `AVCaptureDevice.requestAccess`).
- 🔵 `packages/core` wires a real `SidecarProcess` spawner (child_process, resolves the sidecar binary path — see Phase 14 for the packaged-binary resolution strategy; dev builds resolve `native/macos/.build/debug/windower-sidecar-macos`).
- 🔵 Window identity stability test: enumerate, note IDs, enumerate again 5s later with no window changes, confirm IDs match.

**Exit criteria**

- On a real Mac, with permissions not yet granted: `getPermissions` correctly reports `not_determined`/`denied` per kind.
- `requestPermission("screenRecording")` triggers the real macOS prompt; after granting, `getPermissions` reports `granted`.
- `enumerateTargets` lists at least: all connected displays, all visible windows with non-empty titles, matching what's actually on screen (spot-checked manually).
- Matches `spec.md` acceptance item: "`windower targets --json` lists displays, windows, and apps with stable IDs" (CLI itself lands in Phase 7, but the sidecar capability is proven here first via a throwaway test harness).
