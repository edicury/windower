#!/usr/bin/env bash
#
# ci-build-and-sign.sh — CI-only orchestrator for Phase 23 Job 1
# ("build + sign + notarize"). Intended to be invoked from
# .github/workflows/release.yml on a macos-14 (arm64) runner.
#
# This script does NOT reimplement signing/notarization — it composes:
#   swift build (per architecture)
#   -> temporary-keychain identity import (decision 8, standard GH Actions pattern)
#   -> native/macos/scripts/codesign-notarize.sh (called once per binary, per arch;
#      NEVER modified by this script)
#   -> copy signed binaries into packages/sidecar-macos-<arch>/bin/
#
# It is scaffolding, same as codesign-notarize.sh itself: it has never been
# run against real Apple/CI credentials or hardware from this environment.
# Believed correct per the documented GitHub Actions codesigning pattern;
# needs a first real run on macos-14 CI before this is more than "believed
# correct". See native/macos/CODESIGNING.md for the same caveat on the
# script this one wraps.
#
# Usage:
#   ./scripts/ci-build-and-sign.sh [arm64|x64|both]
#
# Default: both (native arm64 build + best-effort x64 cross-compile attempt).
#
# ── Architectures ────────────────────────────────────────────────────────
#
# arm64: native `swift build -c release` on a macos-14 (Apple Silicon) runner.
#        Known-good — no cross-compilation involved.
#
# x64:   ATTEMPTS `swift build -c release --arch x86_64` cross-compilation
#        from the arm64 runner. This is Phase 23 decision 9 — explicitly
#        flagged UNVERIFIED in specs/001-windower-mvp/tasks/phase-23-ci-release-automation.md.
#        `--arch` is the standard SPM flag for `swift build`/`swift test`
#        to cross-compile for another Apple-platform architecture (it has
#        shipped since Swift 5.x's cross-compilation support for Apple
#        platforms), but this repo has never exercised it against
#        ScreenCaptureKit/AppKit-linked binaries, which is exactly the kind
#        of dependency that can make cross-compilation fail even though the
#        flag itself is real and documented.
#
#        This script does NOT trust `swift build`'s exit code alone to mean
#        "produced a real x86_64 binary" — SPM cross-compile failures can
#        sometimes surface as a build that "succeeds" but silently falls
#        back to the host architecture, or a build that produces a
#        Mach-O with the wrong slice. After the build, this script runs
#        `file` AND `lipo -info` against each produced binary and greps for
#        "x86_64" / "executable x86_64" — if either check doesn't confirm a
#        genuine x86_64 Mach-O, the script exits non-zero with a clear
#        message so the *workflow* (not this script) can fall back to a
#        second `macos-13` (Intel) job leg.
#
#        ── WORKFLOW-LEVEL FALLBACK (TODO for the workflow-assembly task) ──
#        If this script exits non-zero for the x64 leg (or is invoked with
#        `arm64` only and the workflow decides not to attempt cross-compile
#        at all), .github/workflows/release.yml needs a second job/matrix
#        leg along these lines (not implemented here — this is scaffolding
#        for that task):
#
#          build-x64-fallback:
#            runs-on: macos-13   # Intel runner — native x86_64, no cross-compile
#            if: needs.build-arm64-and-attempt-x64.outputs.x64_cross_compile_ok != 'true'
#            steps:
#              - uses: actions/checkout@v4
#              - run: native/macos/scripts/ci-build-and-sign.sh x64
#                env: { ...same secrets... }
#
#        The two legs are mutually exclusive for x64 (cross-compiled OR
#        macos-13-native, never both) but Job 2 (permissions check) and
#        Job 3 (publish) don't need to know which one ran — they just need
#        packages/sidecar-macos-x64/bin/windower-{capture,control}-macos to
#        exist and be correctly architected by the time they run.
#
# ── Required environment variables ──────────────────────────────────────
#
# Codesigning identity import (temporary CI keychain, decision 8):
#   DEVELOPER_ID_CERT_P12       - base64-encoded .p12 (cert + private key)
#   DEVELOPER_ID_CERT_PASSWORD  - the .p12's own export password
#
# Passed straight through to codesign-notarize.sh (see CODESIGNING.md):
#   DEVELOPER_ID_APPLICATION    - exact codesigning identity string
#   NOTARY_API_KEY_ID
#   NOTARY_API_ISSUER_ID
#   NOTARY_API_KEY_P8           - base64-encoded .p8 notarization key
#                                  (this script decodes it to a tempfile and
#                                  exports NOTARY_API_KEY_PATH for you —
#                                  codesign-notarize.sh itself only knows
#                                  about NOTARY_API_KEY_PATH, a file path)
#
# NOT required here: NPM_TOKEN (Job 3's concern, not this script's).
#
# ── Exit code contract ──────────────────────────────────────────────────
# 0   = requested architecture(s) built, signed, notarized (staple failure
#       on the bare binaries is expected and non-fatal — see
#       codesign-notarize.sh), and copied into their sidecar package's bin/.
# !=0 = something in the above failed, INCLUDING "x64 cross-compile did not
#       produce a genuine x86_64 binary" — treat that specific failure as
#       "fall back to macos-13", not as "the whole release is broken".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$NATIVE_MACOS_DIR/../.." && pwd)"

TARGET="${1:-both}"

BINARIES=(windower-capture-macos windower-control-macos)

fail() {
  echo "error: $1" >&2
  exit 1
}

log() {
  echo "==> $1"
}

case "$TARGET" in
  arm64|x64|both) ;;
  *) fail "usage: $0 [arm64|x64|both] (got '$TARGET')" ;;
esac

# ── 1. Temporary keychain identity import (decision 8) ─────────────────
#
# Standard GitHub Actions macOS codesigning pattern:
#   create-keychain (random password) -> import .p12 -> set-key-partition-list
#   -> add to search list -> (later) delete-keychain
#
# Only runs once regardless of how many architectures we build, since both
# binaries for both architectures sign with the same Developer ID identity.

KEYCHAIN_NAME="windower-ci-signing.keychain-db"
KEYCHAIN_PATH="$HOME/Library/Keychains/$KEYCHAIN_NAME"
KEYCHAIN_PASSWORD="$(openssl rand -base64 32)"
CLEANUP_TEMP_KEY_PATH=""

cleanup() {
  local status=$?
  log "Cleaning up"
  if [[ -n "$CLEANUP_TEMP_KEY_PATH" && -f "$CLEANUP_TEMP_KEY_PATH" ]]; then
    rm -f "$CLEANUP_TEMP_KEY_PATH"
  fi
  if security list-keychains -d user | grep -q "$KEYCHAIN_NAME"; then
    security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

import_signing_identity() {
  [[ -z "${DEVELOPER_ID_CERT_P12:-}" ]] && fail "DEVELOPER_ID_CERT_P12 is not set (base64-encoded .p12)."
  [[ -z "${DEVELOPER_ID_CERT_PASSWORD:-}" ]] && fail "DEVELOPER_ID_CERT_PASSWORD is not set (.p12 export password)."

  log "Creating temporary keychain: $KEYCHAIN_NAME"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

  local p12_path
  p12_path="$(mktemp -t windower-signing-cert).p12"
  echo "$DEVELOPER_ID_CERT_P12" | base64 --decode > "$p12_path"

  log "Importing Developer ID Application certificate"
  security import "$p12_path" \
    -k "$KEYCHAIN_PATH" \
    -P "$DEVELOPER_ID_CERT_PASSWORD" \
    -T /usr/bin/codesign \
    -T /usr/bin/security
  rm -f "$p12_path"

  # Allow codesign to use the imported key without a GUI prompt.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

  # Add to the search list ahead of the default keychains so codesign finds it.
  local existing_keychains
  existing_keychains="$(security list-keychains -d user | sed 's/[[:space:]]*"\(.*\)"[[:space:]]*/\1/')"
  security list-keychains -d user -s "$KEYCHAIN_PATH" $existing_keychains

  log "Signing identity imported into $KEYCHAIN_NAME"
}

# ── 2. Notarization API key: decode base64 -> tempfile ─────────────────
#
# codesign-notarize.sh wants NOTARY_API_KEY_PATH (a file path). CI secrets
# store the .p8 content as base64 in NOTARY_API_KEY_P8. Decode once, export
# the path, and let the existing script do the rest — untouched.

prepare_notary_key() {
  [[ -z "${NOTARY_API_KEY_P8:-}" ]] && fail "NOTARY_API_KEY_P8 is not set (base64-encoded .p8 notarization key)."
  [[ -z "${NOTARY_API_KEY_ID:-}" ]] && fail "NOTARY_API_KEY_ID is not set."
  [[ -z "${NOTARY_API_ISSUER_ID:-}" ]] && fail "NOTARY_API_ISSUER_ID is not set."
  [[ -z "${DEVELOPER_ID_APPLICATION:-}" ]] && fail "DEVELOPER_ID_APPLICATION is not set."

  local key_path
  key_path="$(mktemp -t windower-notary-key).p8"
  echo "$NOTARY_API_KEY_P8" | base64 --decode > "$key_path"
  chmod 600 "$key_path"
  CLEANUP_TEMP_KEY_PATH="$key_path"
  export NOTARY_API_KEY_PATH="$key_path"

  log "Notarization API key decoded to tempfile"
}

# ── 3. Build ─────────────────────────────────────────────────────────────

build_arch() {
  local arch="$1" # "arm64" | "x64"
  local swift_arch_flag=""
  local build_dir_arch=""

  case "$arch" in
    arm64)
      # Native build on a macos-14 (Apple Silicon) runner; no --arch needed,
      # but pass it explicitly anyway so the build output path is
      # predictable and this script doesn't rely on host-arch defaults.
      swift_arch_flag="arm64"
      ;;
    x64)
      swift_arch_flag="x86_64"
      ;;
    *)
      fail "build_arch: unknown arch '$arch'"
      ;;
  esac

  log "Building native/macos for --arch $swift_arch_flag"
  (
    cd "$NATIVE_MACOS_DIR"
    swift build -c release --arch "$swift_arch_flag"
  )

  # SPM's release output path is arch-qualified when --arch is passed
  # explicitly (.build/<arch>-apple-macosx/release/), not the bare
  # .build/release/ used by an unqualified `swift build -c release`.
  build_dir_arch="$NATIVE_MACOS_DIR/.build/${swift_arch_flag}-apple-macosx/release"

  if [[ ! -d "$build_dir_arch" ]]; then
    # Fallback: some SPM versions/toolchains still place a single-arch
    # explicit --arch build under the unqualified release dir. Check there
    # before failing, but prefer the arch-qualified path when it exists.
    if [[ -d "$NATIVE_MACOS_DIR/.build/release" ]]; then
      build_dir_arch="$NATIVE_MACOS_DIR/.build/release"
    else
      fail "build_arch: expected build output directory not found (checked .build/${swift_arch_flag}-apple-macosx/release and .build/release)"
    fi
  fi

  echo "$build_dir_arch"
}

# Verify a built binary is genuinely the architecture we asked for.
# Does NOT trust the build command's exit code alone (see header comment) —
# checks both `file` and `lipo -info` output.
verify_arch() {
  local binary_path="$1"
  local expected="$2" # "arm64" | "x86_64"

  [[ -f "$binary_path" ]] || fail "verify_arch: binary not found at '$binary_path'"

  local file_out lipo_out
  file_out="$(file "$binary_path")"
  lipo_out="$(lipo -info "$binary_path" 2>&1 || true)"

  echo "    file:      $file_out"
  echo "    lipo -info: $lipo_out"

  if ! grep -q "$expected" <<<"$file_out"; then
    return 1
  fi
  if ! grep -q "$expected" <<<"$lipo_out"; then
    return 1
  fi
  return 0
}

# ── 4. Sign + notarize + copy into the sidecar package ──────────────────

sign_and_place() {
  local build_dir="$1"
  local arch_pkg_suffix="$2" # "arm64" | "x64" -> packages/sidecar-macos-<suffix>

  local dest_dir="$REPO_ROOT/packages/sidecar-macos-${arch_pkg_suffix}/bin"
  mkdir -p "$dest_dir"

  for binary in "${BINARIES[@]}"; do
    local binary_path="$build_dir/$binary"
    [[ -f "$binary_path" ]] || fail "sign_and_place: expected build output '$binary_path' not found"

    log "codesign-notarize.sh -> $binary ($arch_pkg_suffix)"
    # codesign-notarize.sh is called exactly as-is, per binary, per
    # architecture — never modified. Staple failure ("Error 73" on bare
    # Mach-O executables) is expected and handled as non-fatal INSIDE that
    # script already (see its own step 5); this wrapper does not need to
    # special-case it. What we assert on here is only the wrapper's own
    # exit code, which is non-zero only if codesign-notarize.sh's final
    # `codesign --verify` (its real pass/fail gate — see its step 6) fails.
    "$SCRIPT_DIR/codesign-notarize.sh" "$binary_path"

    log "Copying signed $binary -> $dest_dir/"
    cp "$binary_path" "$dest_dir/$binary"
    chmod +x "$dest_dir/$binary"
  done
}

# ── main ──────────────────────────────────────────────────────────────

import_signing_identity
prepare_notary_key

if [[ "$TARGET" == "arm64" || "$TARGET" == "both" ]]; then
  log "===== arm64 (native) ====="
  arm64_build_dir="$(build_arch arm64)"
  for binary in "${BINARIES[@]}"; do
    log "Verifying architecture: $binary (expect arm64)"
    if ! verify_arch "$arm64_build_dir/$binary" "arm64"; then
      fail "arm64 build of $binary did not produce a genuine arm64 Mach-O binary (unexpected on a native macos-14 build — investigate before continuing)"
    fi
  done
  sign_and_place "$arm64_build_dir" "arm64"
  log "arm64: done"
fi

if [[ "$TARGET" == "x64" || "$TARGET" == "both" ]]; then
  log "===== x64 (cross-compile attempt, decision 9 — UNVERIFIED) ====="
  set +e
  x64_build_dir="$(build_arch x64)"
  build_status=$?
  set -e

  if [[ $build_status -ne 0 ]]; then
    echo "error: swift build --arch x86_64 exited non-zero." >&2
    echo "       This is the expected/anticipated failure mode of decision 9's" >&2
    echo "       cross-compilation attempt. The calling workflow should fall back" >&2
    echo "       to a macos-13 (Intel) job leg — see this script's header comment" >&2
    echo "       for the exact fallback job shape. Not treating this as fatal to" >&2
    echo "       the overall release; exiting non-zero so the workflow can branch." >&2
    exit 2
  fi

  x64_arch_ok=true
  for binary in "${BINARIES[@]}"; do
    log "Verifying architecture: $binary (expect x86_64)"
    if ! verify_arch "$x64_build_dir/$binary" "x86_64"; then
      echo "error: swift build --arch x86_64 exited 0 but '$binary' is NOT a genuine x86_64 Mach-O binary." >&2
      echo "       (checked both 'file' and 'lipo -info' output above)" >&2
      echo "       This is exactly the silent-fallback-to-host-arch failure mode" >&2
      echo "       flagged as a risk in decision 9. Falling back to macos-13 is" >&2
      echo "       required — see this script's header comment for the fallback" >&2
      echo "       job shape." >&2
      x64_arch_ok=false
    fi
  done

  if [[ "$x64_arch_ok" != "true" ]]; then
    exit 3
  fi

  sign_and_place "$x64_build_dir" "x64"
  log "x64 (cross-compiled): done"
fi

log "ci-build-and-sign.sh completed for target: $TARGET"
