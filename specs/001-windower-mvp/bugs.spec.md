# Known Bugs / Live Testing Findings

Tracked during manual live testing (Phase 7 CLI). Not spec — a running log to fix later.

## 1. `windower targets` lists many phantom "Desktop" window entries

**Found:** Phase 7 live test, macOS sidecar, `windower targets --json`.

**Symptom:** Output includes dozens of `kind: "window"` entries with `title: "Desktop"`, empty `appName`/`appBundleId`, and `bounds` matching a full external-display resolution (e.g. `7680x2160`) — far more than the number of real on-screen windows. Likely one phantom entry per virtual desktop/Space (or per display arrangement) rather than actual user windows.

**Impact:** Noisy `targets` output; agents/users must filter these out manually to find real windows. Not currently blocking (real windows still resolve correctly), but hurts target discovery UX.

**Suspected source:** `native/macos` window enumeration (Phase 2, `CGWindowListCopyWindowInfo` or similar) likely picking up desktop/wallpaper layer windows per Space that aren't real app windows.

**Fix:** `native/macos/Sources/WindowerSidecarCore/Enumeration.swift` `mapWindow` now also skips windows whose `owningApplication` has an empty `applicationName` or `bundleIdentifier` — the phantom entries had a title but no real app identity. Real Finder desktop window (one instance, `appName: "Finder"`) still surfaces correctly.

**Verified:** live-tested with `windower targets --json` after `swift build` — window count on this machine dropped from ~65 (many empty-app "Desktop" duplicates) to 27 real windows, all with non-empty `appName`. `swift test` — 100/100 pass.

**Status:** Closed.
