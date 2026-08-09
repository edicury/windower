# Windower e2e / soak suite (Phase 13)

Real daemon (`apps/daemon`) talking to the real macOS sidecar (`native/macos`)
through the real unix-socket JSON-RPC protocol, recording the real
`fixtures/demo-app` fixture — no fake sidecar anywhere in this package. Every
call this suite makes goes through `@windower/core`'s `DaemonClient`, exactly
the way `packages/cli` and `packages/mcp-server` talk to the daemon; nothing
here branches on macOS-specific behavior above that boundary (per
`CLAUDE.md`'s "protocol before platform" rule) except the test *harness*
itself (finding a real sidecar OS pid for the crash test, synthesizing clicks
via `osascript`), which is explicitly test infrastructure, not
`packages/core`/`apps/daemon`/`packages/cli` code.

## Why this is not part of CI

GitHub Actions macOS runners cannot interactively grant Screen
Recording/Accessibility/Microphone TCC permissions. `.github/workflows/ci.yml`
runs `pnpm turbo run test`, which exercises the fake-sidecar unit/integration
suite across every package (protocol schemas, CLI arg parsing, daemon
lifecycle) — that suite is a complete, real substitute for anything gated on
TCC. This package's scripts are named `test:e2e` / `test:soak` (not `test`),
so `pnpm turbo run test` never discovers or runs them; they only run via the
explicit `pnpm test:e2e` / `pnpm test:soak` root scripts (or
`pnpm --filter @windower/e2e run test:e2e` directly).

**This is a required manual pre-merge check for any change touching
`apps/daemon`, `packages/core`'s protocol/daemon layers, or `native/macos`** —
run it locally before merging, per `specs/001-windower-mvp/tasks/phase-13-testing-hardening.md`'s
CI-strategy note.

## Prerequisites

1. **macOS** (this suite hard-skips on any other platform).
2. **Grant TCC permissions to the terminal (or Node binary) that will run
   these tests.** These cannot be granted non-interactively; do this once per
   machine:
   - **Screen Recording**: System Settings → Privacy & Security → Screen
     Recording → enable your terminal app (Terminal.app / iTerm / etc., or
     the specific `node` binary if you've pinned one). You'll need to
     relaunch the terminal after toggling this.
   - **Accessibility**: System Settings → Privacy & Security →
     Accessibility → enable the same terminal app. Required for window
     resize (AX) and for `osascript`'s `System Events` clicks.
   - **Microphone**: System Settings → Privacy & Security → Microphone →
     enable the same terminal app.
   - To reset and re-trigger the prompts from scratch (e.g. after revoking
     by mistake), you can use `tccutil`, e.g.:
     ```sh
     tccutil reset ScreenCapture com.apple.Terminal
     tccutil reset Accessibility com.apple.Terminal
     tccutil reset Microphone com.apple.Terminal
     ```
     (swap the bundle id for whatever terminal you actually use — check
     `osascript -e 'id of app "Terminal"'` or your terminal's About panel).
   - If any of these three is not `granted`, the suite fails fast in
     `beforeAll` with a clear message listing exactly what's missing — it
     will not hang waiting on a permission prompt.
3. **Build everything the suite needs**, in order:
   ```sh
   pnpm install
   pnpm turbo run build          # apps/daemon, packages/core, native/macos sidecar
   fixtures/demo-app/package-app.sh   # builds + wraps demo-app in a .app bundle
   ```
   The demo-app fixture must be launched from inside its `.app` bundle, not
   as a bare `swift build` executable — see `fixtures/demo-app/README.md`
   ("Build") for why (unbundled executables have no `bundleIdentifier` and
   are filtered out of `list_targets`).
   The suite checks for all of these at module-load time (see
   `src/lib/preflight.ts`) and skips (rather than hangs/crashes) an entire
   `describe` block with a clear reason if something's missing.

## Running

```sh
# from repo root
pnpm test:e2e     # golden path + both crash-injection tests, a few minutes
pnpm test:soak    # 30-minute continuous recording, ~35-40 min wall clock

# or directly against this package
pnpm --filter @windower/e2e run test:e2e
pnpm --filter @windower/e2e run test:soak
```

Each e2e/soak run spins up its own daemon process against an isolated
temporary `WINDOWER_HOME` (via `WINDOWER_HOME` env var, see
`src/lib/daemon-harness.ts`) — it never touches your real
`~/.windower/daemon.sock` or session files, and cleans up the temp dir on
teardown.

For a fast smoke run of the soak test's *mechanics* (not a real 30-minute
soak — too short for the memory-growth assertion to mean anything, which is
skipped below 10 samples) without waiting half an hour:

```sh
WINDOWER_SOAK_DURATION_MS=60000 pnpm test:soak
```

## What's covered

- **`src/golden-path.e2e.test.ts`**: enumerate the demo-app window via
  `list_targets`, resize it, `start_recording` with system+mic audio, click
  all 3 known buttons, `stop_recording`, then assert:
  - `manifest.json` validates against `OutputManifestSchema` (imported from
    `@windower/core`, not redefined here).
  - The video file exists and its resolution/fps roughly match what was
    requested (via `ffprobe`, `ffprobe-static`'s bundled binary — see
    `src/lib/ffprobe.ts`; `ffmpeg-static` only bundles `ffmpeg`, not
    `ffprobe`, hence the separate package, following the same
    `createRequire` CJS-interop pattern `apps/daemon/src/narration-mux.ts`
    already uses for `ffmpeg-static`).
  - The `.events.json` timeline's click-derived events line up with the
    demo-app's own independent click-log JSONL ground truth
    (`WINDOWER_DEMO_LOG`) — cross-checking windower's own recorded output
    against a source it doesn't control, not just trusting itself.
- **`src/crash-sidecar.e2e.test.ts`**: `kill -9` the real sidecar child
  process mid-recording (pid found via the process table, filtered by real
  parent pid — see `src/lib/find-child-pid.ts`), asserts the session reaches
  `failed` with no hung state. Real-process complement to
  `apps/daemon/src/session-manager.test.ts`'s existing fake-sidecar test for
  `handleSidecarExit` — does not duplicate or modify it.
- **`src/crash-daemon-restart.e2e.test.ts`**: kills the daemon process
  itself mid-recording, restarts it against the same `WINDOWER_HOME`,
  asserts Phase 6's `recoverCrashedSessions` marks the orphaned session
  `failed`. Real-process complement to
  `apps/daemon/src/session-manager.test.ts`'s existing fake-sidecar test for
  `recoverCrashedSessions` — does not duplicate or modify it.
- **`soak/soak.soak.test.ts`**: 30-minute continuous recording (video +
  system audio + mic audio + event timeline) against a display target,
  asserting: no audio/video drift (per-stream `ffprobe` duration compared,
  tolerance 1s), no unbounded RSS growth in either the daemon or sidecar
  process (`ps`-sampled at ~180 points across the run, head-vs-tail mean
  ratio check — see `src/lib/process-rss.ts`), and the file finalizes
  correctly (manifest + playable video).

## Design choices worth knowing about

- **Clicking the demo-app's buttons: synthetic `osascript`/System Events
  clicks, not a human clicking during a time window.** Both were viable per
  the phase-13 task; synthetic clicks were chosen because they're strictly
  more deterministic (no dependency on a person's timing/attention) and
  fully scriptable with zero additional dependencies (`osascript` ships
  with macOS; no Homebrew tool like `cliclick` needed). `System Events`
  requires the same Accessibility grant this suite already needs for window
  resize, so it's not an additional TCC prerequisite. See
  `src/lib/demo-app.ts`'s `synthesizeClick`/`buttonCenterToScreenPixel` for
  the full reasoning and the one deliberate approximation this involves
  (standard 28pt title-bar height — buttons are large enough, 100x50pt,
  that a few points of error can't miss them).
- **Getting a session's real sidecar OS pid for the crash test**: the daemon
  protocol has no RPC for this (and shouldn't — it's test-harness-only
  process-table introspection, not something `contracts/sidecar-protocol.md`
  needs to expose). `src/lib/find-child-pid.ts` finds it by filtering
  `ps -eo pid,ppid,command` to children of the daemon's own pid, avoiding
  false positives from any other windower dev processes on the machine.
- **Isolated daemon per run**: `src/lib/daemon-harness.ts` spawns
  `apps/daemon/dist/bin.js` directly with a per-run `WINDOWER_HOME` (a temp
  dir), rather than using `@windower/core`'s `ensureDaemonRunning` (which
  always targets the real `~/.windower`) — this suite must never interfere
  with a daemon a developer might already have running for normal use.

## Permission-denied path tests

Per-capability permission-denied assertions (resize, screen capture, mic)
that don't require a full recording are covered by the fake-sidecar unit
suite already (see `apps/daemon`'s and `packages/core`'s test files for
`PERMISSION_DENIED` handling) — CI-covered, not duplicated here. This
package's `assertPermissionsGrantedOrThrow` (`src/lib/preflight.ts`) instead
guards the *positive* path: it fails fast with a clear message if a
required grant is missing, so a misconfigured local run doesn't hang on an
OS permission prompt.
