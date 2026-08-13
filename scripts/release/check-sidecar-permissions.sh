#!/usr/bin/env bash
#
# check-sidecar-permissions.sh — Phase 23 "Job 2" permissions regression check.
#
# Context (specs/001-windower-mvp/tasks/phase-23-ci-release-automation.md):
# packages/sidecar-macos-{arm64,x64} ship their compiled sidecar binaries
# under a plain `"files": ["bin"]` package.json field, not npm's own `"bin"`
# field (packages/core/src/process/sidecar-path.ts resolves them by exact
# filename via require.resolve, not npm's PATH-shimming bin mechanism). Both
# npm and pnpm only force-preserve the Unix executable bit for files declared
# via a package's own `bin` field; a `files`-only entry is packed with
# whatever mode the packer feels like giving it. sidecar-path.ts carries a
# *runtime* chmodSync workaround that self-heals this after install, but
# nothing before today asserted anything about the packed tarball itself —
# so a real regression here would ship silently until someone happened to
# `npm install` the package by hand and looked at file permissions.
#
# This script packs each sidecar package for real (pnpm pack — the same
# packer the release workflow's publish step uses, see decision 6 in the
# phase doc), extracts the resulting tarball, and asserts that every
# bin/windower-*-macos entry it contains is executable. It is designed to be
# run as a single CI step with a clear pass/fail exit code (Job 2 of
# .github/workflows/release.yml, built by a separate task).
#
# Usage: scripts/release/check-sidecar-permissions.sh [package-dir ...]
#   With no arguments, checks the default set of sidecar packages below.
#
# Exit codes:
#   0 — every binary present in every checked package's tarball is
#       executable (a package with no binary yet, e.g. sidecar-macos-x64
#       before its cross-compiled build lands, is a "nothing to check" pass,
#       not a failure).
#   1 — at least one binary in at least one package's tarball lacks the
#       executable bit (or a hard error, e.g. `pnpm pack` itself failed).

set -u -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Default packages to check when none are passed on the command line. Kept as
# an explicit list (not a glob over packages/sidecar-*) so a future
# non-sidecar package under packages/ never gets silently swept in.
DEFAULT_PACKAGES=(
  "packages/sidecar-macos-arm64"
  "packages/sidecar-macos-x64"
)

# Binaries this check cares about. Matches sidecar-path.ts's
# SIDECAR_BINARY_FILENAME_BY_PLATFORM table (windower-capture-macos,
# windower-control-macos) via a glob rather than hardcoding both names, so a
# third macOS-surface binary added later is covered without editing this
# script.
BIN_PATTERN="windower-*-macos"

if [ "$#" -gt 0 ]; then
  PACKAGE_DIRS=("$@")
else
  PACKAGE_DIRS=("${DEFAULT_PACKAGES[@]}")
fi

FAILURES=()
CHECKED_ANY=0
WORKDIRS=()

cleanup() {
  for d in "${WORKDIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
}
trap cleanup EXIT

echo "== windower: sidecar permissions regression check =="

for pkg_rel in "${PACKAGE_DIRS[@]}"; do
  case "$pkg_rel" in
    /*) pkg_dir="$pkg_rel" ;;
    *) pkg_dir="$REPO_ROOT/$pkg_rel" ;;
  esac
  pkg_name="$(basename "$pkg_rel")"

  if [ ! -d "$pkg_dir" ]; then
    echo "[$pkg_name] SKIP — no such package directory: $pkg_rel"
    continue
  fi
  if [ ! -f "$pkg_dir/package.json" ]; then
    echo "[$pkg_name] SKIP — no package.json in $pkg_rel"
    continue
  fi

  bin_dir="$pkg_dir/bin"
  if [ ! -d "$bin_dir" ] || [ -z "$(ls -A "$bin_dir" 2>/dev/null)" ]; then
    echo "[$pkg_name] WARN — bin/ is missing or empty, nothing to check (binary not shipped yet); skipping"
    continue
  fi

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/windower-sidecar-perm-check.XXXXXX")"
  WORKDIRS+=("$work_dir")
  pack_dir="$work_dir/pack"
  extract_dir="$work_dir/extract"
  mkdir -p "$pack_dir" "$extract_dir"

  echo "[$pkg_name] packing with pnpm pack..."
  if ! pack_output="$(cd "$pkg_dir" && pnpm pack --pack-destination "$pack_dir" 2>&1)"; then
    echo "$pack_output"
    echo "[$pkg_name] FAIL — pnpm pack failed"
    FAILURES+=("$pkg_name: pnpm pack failed")
    continue
  fi

  tarball="$(find "$pack_dir" -maxdepth 1 -name '*.tgz' -print -quit)"
  if [ -z "$tarball" ]; then
    echo "$pack_output"
    echo "[$pkg_name] FAIL — pnpm pack produced no tarball"
    FAILURES+=("$pkg_name: pnpm pack produced no tarball")
    continue
  fi

  if ! tar xzf "$tarball" -C "$extract_dir"; then
    echo "[$pkg_name] FAIL — could not extract $tarball"
    FAILURES+=("$pkg_name: tarball extraction failed")
    continue
  fi

  # npm/pnpm tarballs always root their contents under package/.
  extracted_bin_dir="$extract_dir/package/bin"
  if [ ! -d "$extracted_bin_dir" ]; then
    echo "[$pkg_name] WARN — tarball has no bin/ directory; nothing to check"
    continue
  fi

  shopt -s nullglob
  extracted_bins=("$extracted_bin_dir"/$BIN_PATTERN)
  shopt -u nullglob

  if [ "${#extracted_bins[@]}" -eq 0 ]; then
    echo "[$pkg_name] WARN — tarball's bin/ has no $BIN_PATTERN entries; nothing to check"
    continue
  fi

  CHECKED_ANY=1
  for bin_path in "${extracted_bins[@]}"; do
    bin_name="$(basename "$bin_path")"
    if [ -x "$bin_path" ]; then
      echo "[$pkg_name] PASS — bin/$bin_name is executable"
    else
      echo "[$pkg_name] FAIL — bin/$bin_name lost its executable bit in the packed tarball"
      FAILURES+=("$pkg_name: bin/$bin_name is not executable in the packed tarball ($tarball)")
    fi
  done
done

echo "======================================================"
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "SIDECAR PERMISSIONS CHECK: FAILED"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

if [ "$CHECKED_ANY" -eq 0 ]; then
  echo "SIDECAR PERMISSIONS CHECK: PASSED (nothing to check — no packages had a binary to inspect)"
else
  echo "SIDECAR PERMISSIONS CHECK: PASSED"
fi
exit 0
