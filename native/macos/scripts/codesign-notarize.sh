#!/usr/bin/env bash
#
# codesign-notarize.sh — codesign + notarize the windower-sidecar-macos binary.
#
# Usage:
#   ./scripts/codesign-notarize.sh [path/to/windower-sidecar-macos]
#
# Default binary path is the swift build (release) output:
#   .build/release/windower-sidecar-macos
#
# Required environment variables:
#   DEVELOPER_ID_APPLICATION  - Codesigning identity, e.g.
#                               "Developer ID Application: Example Inc (TEAMID1234)"
#   NOTARY_API_KEY_ID         - App Store Connect API key ID
#   NOTARY_API_ISSUER_ID      - App Store Connect API issuer ID (UUID)
#   NOTARY_API_KEY_PATH       - Path to the .p8 private key file for the API key
#
# See ../CODESIGNING.md for how to obtain these.
#
# NOTE: this script has not been exercised end-to-end against a real
# Developer ID certificate or App Store Connect API key in this repo.
# It is scaffolding for Phase 14 (packaging) — see CODESIGNING.md.

set -euo pipefail

BINARY_PATH="${1:-.build/release/windower-sidecar-macos}"

fail() {
  echo "error: $1" >&2
  exit 1
}

if [[ ! -f "$BINARY_PATH" ]]; then
  fail "binary not found at '$BINARY_PATH'. Build it first with: swift build -c release"
fi

if [[ -z "${DEVELOPER_ID_APPLICATION:-}" ]]; then
  fail "DEVELOPER_ID_APPLICATION is not set. Export it to the exact identity string from 'security find-identity -v -p codesigning', e.g. \"Developer ID Application: Example Inc (TEAMID1234)\"."
fi

if [[ -z "${NOTARY_API_KEY_ID:-}" ]]; then
  fail "NOTARY_API_KEY_ID is not set. See CODESIGNING.md for how to create an App Store Connect API key."
fi

if [[ -z "${NOTARY_API_ISSUER_ID:-}" ]]; then
  fail "NOTARY_API_ISSUER_ID is not set. See CODESIGNING.md for how to find your issuer ID."
fi

if [[ -z "${NOTARY_API_KEY_PATH:-}" ]]; then
  fail "NOTARY_API_KEY_PATH is not set. It must point at the downloaded .p8 API key file."
fi

if [[ ! -f "$NOTARY_API_KEY_PATH" ]]; then
  fail "NOTARY_API_KEY_PATH points at a file that does not exist: '$NOTARY_API_KEY_PATH'"
fi

echo "==> Codesigning $BINARY_PATH"
codesign --sign "$DEVELOPER_ID_APPLICATION" --options runtime --timestamp "$BINARY_PATH"

echo "==> Verifying codesign"
codesign --verify --verbose "$BINARY_PATH"

# notarytool needs a zip/dmg/pkg to submit, not a bare executable.
NOTARIZE_ZIP="$(mktemp -d)/windower-sidecar-macos.zip"
echo "==> Zipping $BINARY_PATH for notarization submission -> $NOTARIZE_ZIP"
ditto -c -k --keepParent "$BINARY_PATH" "$NOTARIZE_ZIP"

echo "==> Submitting for notarization (this can take a few minutes)"
xcrun notarytool submit "$NOTARIZE_ZIP" \
  --key "$NOTARY_API_KEY_PATH" \
  --key-id "$NOTARY_API_KEY_ID" \
  --issuer "$NOTARY_API_ISSUER_ID" \
  --wait

echo "==> Stapling notarization ticket"
# Note: stapler cannot staple a ticket directly onto a bare, unbundled Mach-O
# executable (there is no resource fork / bundle to attach it to) — this is
# expected to work once the sidecar is shipped inside an app bundle or
# installer package (.pkg/.dmg). For a bare CLI-style binary, Gatekeeper's
# online notarization check at launch time (which consults Apple's servers)
# is what actually matters; stapling is best-effort so it also works offline.
if xcrun stapler staple "$BINARY_PATH" 2>/dev/null; then
  echo "    stapled successfully"
else
  echo "    stapler staple skipped/failed for bare binary (expected for non-bundle targets); notarization ticket is still valid online"
fi

echo "==> Final verification"
if codesign --verify --verbose "$BINARY_PATH"; then
  echo "PASS: codesign --verify"
else
  fail "codesign --verify failed"
fi

if spctl --assess --type execute --verbose "$BINARY_PATH"; then
  echo "PASS: spctl --assess"
else
  echo "WARN: spctl --assess did not pass (may be expected for a bare non-bundled binary; Gatekeeper policy for loose executables differs from .app bundles)" >&2
fi

echo "==> Done: $BINARY_PATH is signed and submitted for notarization"
