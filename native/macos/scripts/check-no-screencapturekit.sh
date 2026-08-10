#!/usr/bin/env bash
#
# check-no-screencapturekit.sh — enforce phase 21's hard structural invariant:
# `windower-control-macos` must not link ScreenCaptureKit, not even
# transitively.
#
# Phase 21 exists because more than one process holding ScreenCaptureKit state
# at once destabilizes `replayd` and silently truncates recordings
# (specs/001-windower-mvp/tasks/phase-21-capture-control-broker.md,
# bugs.spec.md #6). The control binary's guarantee that it can never be a
# second ScreenCaptureKit consumer comes from its dependency graph in
# Package.swift — but a graph is only a promise until something checks the
# artifact. This is that check: it reads the real Mach-O load commands of the
# built binary, so adding `import ScreenCaptureKit` anywhere under
# WindowerControlCore/ or WindowerSidecarShared/ fails the build rather than
# quietly re-arming the bug.
#
# It also asserts the positive: the capture binary MUST link ScreenCaptureKit.
# A capture binary that stopped linking it would mean the frameworks migrated
# somewhere unexpected and this check had become vacuous.
#
# Usage:
#   ./scripts/check-no-screencapturekit.sh [debug|release]
#
# Default configuration is `debug`, matching what a bare `swift build` and
# `swift test` produce. Run from native/macos.

set -euo pipefail

CONFIGURATION="${1:-debug}"

cd "$(dirname "$0")/.."

BIN_DIR="$(swift build --configuration "$CONFIGURATION" --show-bin-path)"

CONTROL_BIN="$BIN_DIR/windower-control-macos"
CAPTURE_BIN="$BIN_DIR/windower-capture-macos"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

for binary in "$CONTROL_BIN" "$CAPTURE_BIN"; do
    [ -x "$binary" ] || fail "$binary not found — run 'swift build --configuration $CONFIGURATION' first"
done

# `otool -L` lists the dynamic libraries/frameworks on the binary's link line,
# including anything pulled in transitively by a linked framework, which is
# precisely the "not even transitively" part of the requirement.
CONTROL_LINKAGE="$(otool -L "$CONTROL_BIN")"
CAPTURE_LINKAGE="$(otool -L "$CAPTURE_BIN")"

echo "== otool -L windower-control-macos =="
echo "$CONTROL_LINKAGE"
echo
echo "== otool -L windower-capture-macos =="
echo "$CAPTURE_LINKAGE"
echo

if echo "$CONTROL_LINKAGE" | grep -qi "ScreenCaptureKit"; then
    fail "windower-control-macos links ScreenCaptureKit. The control surface must never be able to
      hold ScreenCaptureKit state (phase 21's governing invariant). Something under
      Sources/WindowerControlCore/ or Sources/WindowerSidecarShared/ gained an
      'import ScreenCaptureKit' — move that code into Sources/WindowerCaptureCore/ instead."
fi

# ReplayKit is `replayd`'s own framework and would be an equally disqualifying
# route to the same shared system singleton.
if echo "$CONTROL_LINKAGE" | grep -qi "ReplayKit"; then
    fail "windower-control-macos links ReplayKit — same invariant as ScreenCaptureKit, same fix."
fi

if ! echo "$CAPTURE_LINKAGE" | grep -qi "ScreenCaptureKit"; then
    fail "windower-capture-macos does NOT link ScreenCaptureKit. Either the capture surface lost its
      implementation, or framework linkage moved somewhere this check no longer observes —
      in which case the control-binary assertion above has silently become vacuous."
fi

echo "OK: windower-control-macos links no ScreenCaptureKit/ReplayKit; windower-capture-macos links ScreenCaptureKit."
