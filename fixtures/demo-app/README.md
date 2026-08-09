# windower-demo-app

A tiny, deterministic-geometry macOS app used as an e2e test fixture for
Windower (`specs/001-windower-mvp/tasks/phase-13-testing-hardening.md`). It is
a plain AppKit `NSApplication` + `NSWindow` app built with Swift Package
Manager — **not** part of the pnpm/turbo workspace and **not** wired into CI**.
CI cannot grant Screen Recording/Accessibility/Microphone non-interactively,
so e2e tests against this fixture are run locally per Phase 13.

The window has a fixed frame and exactly 3 buttons at known coordinates so an
e2e harness can assert exact click coordinates against the event timeline and
exact resize behavior, without any fuzzy geometry inference.

## Build

```sh
fixtures/demo-app/package-app.sh
```

Builds via `swift build -c release --package-path fixtures/demo-app` and then
wraps the resulting executable in a minimal `.app` bundle (with an
`Info.plist` giving it `CFBundleIdentifier` `com.windower.demo-app`).
**Do not launch the raw `swift build` output directly** — `native/macos`'s
window enumeration (`Sources/WindowerSidecarCore/Enumeration.swift`) filters
out any window whose owning app has an empty `bundleIdentifier`, which a
bare unbundled executable always has; its window will never show up in
`list_targets` if launched that way.

Produces:

```
fixtures/demo-app/.build/release/WindowerDemoApp.app/Contents/MacOS/windower-demo-app
```

(Pass `debug` as the first arg to build a debug configuration instead:
`fixtures/demo-app/package-app.sh debug`.)

## Run

```sh
fixtures/demo-app/.build/release/WindowerDemoApp.app/Contents/MacOS/windower-demo-app
```

Optionally set `WINDOWER_DEMO_LOG` to control where click events are logged
(see below). Kill the process (e.g. `kill <pid>` or Cmd+Q) when done; there is
no auto-exit.

## Window geometry contract

- **Title:** exactly `"Windower Demo App"`.
- **Initial frame** (screen coordinates, points, set explicitly via
  `setFrame(_:display:)` immediately after window creation — never left to
  AppKit's auto-positioning): origin `(200, 200)`, size `900x700`.
- **styleMask:** `.titled, .closable, .resizable, .miniaturizable` — the
  window is resizable so Windower's AX-driven resize calls work; the harness
  should not need to drag the window to resize it.
- The app calls `NSApp.setActivationPolicy(.regular)` and
  `NSApp.activate(ignoringOtherApps: true)` after showing the window, so it
  appears in the on-screen window list for ScreenCaptureKit/AX enumeration
  and has focus.

## Buttons

The content view holds exactly 3 `NSButton`s, each `100x50` points:

| Title         | Center (content-view pt) | Frame origin (content-view pt) |
|---------------|---------------------------|----------------------------------|
| `demo-btn-1`  | `(150, 150)`               | `(100, 125)`                     |
| `demo-btn-2`  | `(450, 150)`               | `(400, 125)`                     |
| `demo-btn-3`  | `(750, 150)`               | `(700, 125)`                     |

Frame origin = center − (width/2, height/2) = center − (50, 25).

### Coordinate-space note (read this before writing e2e assertions)

These coordinates are measured in the **content view's own coordinate
space**, using AppKit's standard (non-flipped) convention: origin at the
content view's **bottom-left** corner, Y increasing **upward**. This is *not*
flipped — `NSView.isFlipped` is left at its default (`false`) for the content
view.

Windower's own public API (CLI/MCP/daemon surfaces, per `CLAUDE.md`) uses
**pixels**, with an origin/axis convention decided by the sidecar protocol
(top-left, Retina-scaled). Converting from "content-view points, bottom-left
origin" to "windower pixels, top-left origin" — including scale-factor and
title-bar-height math — is **the e2e harness's job**, not this app's. This
app deliberately does the simplest possible thing (fixed AppKit geometry) so
that conversion is a single well-defined function the harness owns and tests
once, rather than logic duplicated/hidden inside the fixture.

## Click log (JSONL)

Every button click appends exactly one JSON object, one per line, to a log
file:

```json
{"button":"demo-btn-1","seq":1,"clickedAt":"2026-01-01T12:00:00Z"}
```

- `button`: the clicked button's title (`demo-btn-1` / `demo-btn-2` /
  `demo-btn-3`).
- `seq`: a single **global** counter incremented once per click, shared
  across all three buttons (not a per-button counter) — use it to assert
  click ordering across buttons.
- `clickedAt`: `ISO8601DateFormatter().string(from: Date())` at the moment
  the click handler ran.

The file is opened in **append** mode and flushed after every write, so a
test harness can safely tail it while the app is running.

**Log file path:** the `WINDOWER_DEMO_LOG` environment variable if set,
otherwise `./demo-app-clicks.jsonl` relative to the process's working
directory at launch.

## Startup signal

After the window has been created, framed, shown (`makeKeyAndOrderFront`),
and activated, the app prints exactly one line to stdout:

```
WINDOW_READY pid=<pid> title="Windower Demo App"
```

stdout is flushed immediately after printing. An e2e harness should poll
stdout for this line before it starts enumerating windows via Windower —
window enumeration attempted before this line is not guaranteed to see the
window.
