#!/usr/bin/env bash
# Wraps the plain SPM executable in a minimal .app bundle.
#
# Why: native/macos's window enumeration
# (Sources/WindowerSidecarCore/Enumeration.swift) filters out any window
# whose owning app has an empty bundleIdentifier (see bugs.spec.md #1 — it
# also filters windower's own window for the same reason). A bare `swift
# build` executable launched directly has no bundle, so NSRunningApplication
# reports an empty bundleIdentifier and the demo-app's window never appears
# in `list_targets`. Running the same executable from inside a `.app/Contents/MacOS/`
# structure next to an Info.plist gives it a real CFBundleIdentifier without
# requiring Launch Services registration or `open` (which would detach
# stdio) — the e2e harness still spawns the executable directly, just at its
# new path inside the bundle.
set -euo pipefail

CONFIG="${1:-release}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

swift build -c "$CONFIG" --package-path "$DIR"

BUILD_BIN="$DIR/.build/$CONFIG/windower-demo-app"
APP_DIR="$DIR/.build/$CONFIG/WindowerDemoApp.app"
MACOS_DIR="$APP_DIR/Contents/MacOS"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$BUILD_BIN" "$MACOS_DIR/windower-demo-app"
cp "$DIR/Info.plist" "$APP_DIR/Contents/Info.plist"

echo "Bundled app: $APP_DIR"
echo "Executable:  $MACOS_DIR/windower-demo-app"
