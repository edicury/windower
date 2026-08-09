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

## 2. Narration mux failures are silently swallowed with no logging

**Found:** Phase 11 live test, real macOS sidecar recording + real `say`-generated AIFF narration muxed via `stop_recording({ narration })`.

**Symptom:** On the first live-test attempt, `stop_recording` returned a normal-looking success result: `outputPath`, `manifestPath`, and a full `manifest`. But `manifest.narration` was completely absent (both in the RPC result and in `manifest.json` on disk), and `ffmpeg -i <outputPath>` showed only the original video stream — no narration audio track had been muxed in at all. No error was thrown or surfaced anywhere in the MCP tool result.

**Root cause (this occurrence):** environmental, not a logic bug in `narration-mux.ts` itself — the long-lived daemon process had been started ~11 minutes *before* `apps/daemon/dist/session-manager.js`/`narration-mux.js` were rebuilt with the narration feature, so it was serving stale in-memory code. Killing the stale daemon (and the two stale MCP-server stdio processes whose memoized `DaemonClient` connections died with it) and letting them respawn against the current build fixed it; a clean rerun produced a correct mux (1 video + 1 AAC audio stream, video untouched, `manifest.narration` present with `trackIndex`).

**Real gap exposed:** `apps/daemon/src/session-manager.ts` (`stopRecording`, ~lines 281-300) deliberately swallows any `muxNarration` failure with an empty `catch {}` so a mux problem doesn't fail an otherwise-good recording — that's a reasonable product choice, documented in `narration-mux.ts`'s file-header comment. But nothing is logged when it happens. Any future mux failure (bad ffmpeg-static binary, disk full, permissions, a real regression) will look identical to "narration wasn't requested" from the caller's point of view — a video with no narration and no `manifest.narration`, no diagnostic. Same pattern also applies to the adjacent `EventTimelineWriter.finalize()` swallow a few lines above.

**Suggested fix:** log the caught error (daemon's logger, whatever that is) before continuing, in both swallow sites, so silent failures are at least debuggable. Not yet fixed — not addressed by this test.

**Status:** Fixed. `apps/daemon/src/session-manager.ts`'s `stopRecording` now logs both swallowed errors via `console.error` (the only logging convention present in `apps/daemon`, matching `bin.ts`) before continuing: `[SessionManager] event timeline finalize failed for session <id>: <error>` and `[SessionManager] narration mux failed for session <id>: <error>`. Swallow-and-continue behavior is unchanged; only logging was added.

## 3. MCP server's memoized `DaemonClient` doesn't self-heal after the daemon dies mid-session

**Found:** Same Phase 11 live test, while investigating bug #2 above — after killing the stale daemon process to force a fresh respawn.

**Symptom:** Once the daemon process was killed, the next `mcp__windower__*` tool call failed with `[DAEMON_UNREACHABLE] DaemonClient is disposed`, and every subsequent call kept failing the same way — it never recovered on its own.

**Root cause:** `packages/mcp-server/src/daemon-client.ts`'s `getDaemonClient()` memoizes one `DaemonClient` promise for the process's whole lifetime, and only clears that memoized promise (`clientPromise = undefined`) in the `.catch()` of the *initial connect* — i.e. if `ensureDaemonRunning()` itself rejects. It has no path to recover once a previously-successful connection later gets disposed (e.g. the underlying daemon process dies): the disposed client just keeps getting returned and erroring forever, for the life of the MCP server process.

**Impact:** Any daemon crash/restart while an MCP server (Claude Code plugin, dev server, etc.) is connected permanently breaks that MCP server's ability to reach the daemon until the MCP server process itself is restarted. In this test, restarting the MCP server process (killing `packages/mcp-server/dist/index.js`) let the host respawn it and reconnect cleanly — no code fix required to work around it, but nothing in the code does this automatically.

**Suggested fix:** in `getDaemonClient()`, detect a disposed/unreachable client at call time (or catch `DAEMON_UNREACHABLE`-style errors from `client.call`) and clear `clientPromise` so the next call reconnects, mirroring the existing initial-connect retry behavior.

**Status:** Fixed. `DaemonClient` (`packages/core/src/daemon/client.ts`) now exposes a public `isDisposed` getter over its existing private `disposed` flag. `packages/mcp-server/src/daemon-client.ts`'s `getDaemonClient()` checks `isDisposed` on the resolved client; if the memoized connection has died, it drops `clientPromise` and reconnects (recursively, so the same call transparently gets a fresh client instead of only healing on the *next* call). Covered by a new test in `packages/mcp-server/src/daemon-client.test.ts`.
