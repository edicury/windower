## Phase 14 — Packaging

**Goal:** Ship an installable artifact — codesigned/notarized sidecar binary, npm package, plugin install — that works on a clean machine through to a first successful recording.

- 🔵 Apple Developer ID codesigning + notarization for `windower-sidecar-macos` (required for Gatekeeper to allow execution without a manual override on a clean machine).
- 🔵 Binary resolution strategy for the published npm package: bundle the signed binary directly in a platform-specific optional-dependency package (`@windower/sidecar-macos-arm64`/`-x64`) resolved via npm's `optionalDependencies` + `os`/`cpu` fields, following the pattern used by esbuild/swc-style native binaries — avoids a separate download step.
- 🔵 `@windower/cli` npm package — depends on `packages/core`, resolves the platform sidecar package, ships the `windower` bin entry.
- 🔵 `@windower/mcp-server` npm package.
- 🔵 `plugins/claude-code` packaged per the current Claude Code plugin distribution mechanism (marketplace entry or direct install path — confirm current mechanism at implementation time).
- 🔵 First-run onboarding: `windower doctor` on a totally fresh install produces clear, actionable output (not a stack trace) pointing at `windower permission request ...` for each missing grant.
- 🔵 Version compatibility check: daemon/CLI/sidecar all report a version; a mismatched sidecar (e.g. stale binary from a prior install) is detected and surfaced clearly rather than causing confusing protocol errors.

## Publish status (2026-08-09)

Published to npm under `@windower` (public access): `@windower/core@0.1.1`, `@windower/cli@0.1.1`, `@windower/mcp-server@0.1.1`, `@windower/daemon@0.1.0`. `npm install -g @windower/cli` now resolves and installs cleanly.

**Bug found and fixed during smoke testing, not caught before publish**: `packages/core/src/daemon/connect.ts`'s `resolveDaemonEntryPath()` called `findRepoRoot()` uncaught — fine inside the monorepo, but a fresh `npm install -g @windower/cli` has no `pnpm-workspace.yaml` to walk up to, so `windower doctor` (or any daemon-talking command) crashed with `Could not locate repo root (pnpm-workspace.yaml)` instead of running. Fixed by wrapping the dev-relative lookup in try/catch (mirroring `resolveSidecarBinaryPath`'s existing pattern) and adding a `require.resolve("@windower/daemon/dist/bin.js")` fallback; `apps/daemon` was made a real (non-optional) publishable package and added as a real dependency of both `@windower/cli` and `@windower/mcp-server` (previously `apps/daemon` was never published at all — the daemon only ever ran from a monorepo checkout). Verified via a real isolated `npm install -g --prefix <tmp> @windower/cli` + `windower doctor` round trip after the fix — the repo-root crash is gone.

`windower doctor` on this fresh install now fails with the correct, already-documented, human-readable error instead of a stack trace: `No sidecar available for platform "darwin"/arch "arm64" yet ... Set WINDOWER_SIDECAR_BINARY_PATH to point at a binary explicitly` — this is the expected behavior for the still-open gap below (sidecar packages unpublished), not a bug.

**NOT published yet, by deliberate decision**: `@windower/sidecar-macos-arm64` and `@windower/sidecar-macos-x64` (package shape/`package.json`/`os`+`cpu` fields exist under `packages/sidecar-macos-{arm64,x64}/`, but their `bin/` dirs are empty placeholders — no compiled binary inside). Publishing them now would make `npm install -g @windower/cli` *succeed* while `windower doctor`/any recording command fails at runtime with a missing-sidecar error, which is worse than a normal npm 404. Do not publish these two until the gap below is closed.

**Remaining work before all 5 packages can ship together** (i.e. before this phase's exit criteria — a genuinely clean-machine install-to-first-recording — can be met):

1. **Real codesigning/notarization.** Resolved by reference to Phase 23 (`specs/001-windower-mvp/tasks/phase-23-ci-release-automation.md`): `native/macos/scripts/ci-build-and-sign.sh` now wraps `codesign-notarize.sh` and runs it as Job 1 of `.github/workflows/release.yml`, sourcing real secrets (`DEVELOPER_ID_CERT_P12`, `DEVELOPER_ID_CERT_PASSWORD`, `NOTARY_API_KEY_P8`, etc. — see `CODESIGNING.md`'s secrets table). Automation now exists; **no real CI run against production Apple credentials has happened yet**, so this item is wired-not-yet-verified, not closed.
2. **A release build step that populates the sidecar packages.** Resolved by reference to Phase 23: `ci-build-and-sign.sh` builds arm64 natively and attempts an x64 cross-compile via `swift build --arch x86_64` (with `file`/`lipo` arch verification, `macos-13` as a documented fallback if cross-compilation doesn't pan out), then copies the signed+notarized binaries into `packages/sidecar-macos-{arm64,x64}/bin/`. Automation now exists; first real run still pending.
3. **Publish the two sidecar packages.** Resolved by reference to Phase 23: `scripts/release/release.mjs publish` publishes the full 9-package dependency graph in strict order, ending with `sidecar-macos-arm64`/`sidecar-macos-x64`, authenticated via an npm Automation token (`NPM_TOKEN`) rather than interactive OTP. Automation now exists; first real run still pending.
4. **Re-verify `packages/core/src/process/sidecar-path.ts`'s `require.resolve` fallback** against a real installed `@windower/sidecar-macos-{arm64,x64}` package. Resolved by reference to Phase 23's Job 2 permissions regression check (`scripts/release/check-sidecar-permissions.sh`), which also caught and led to fixing a real bug: both sidecar `package.json` files were missing an npm `"bin"` field, which meant `pnpm pack` stripped the executable bit from the shipped binaries. Fixed by adding `"bin"` fields to both `package.json`s; `sidecar-path.ts`'s runtime chmod self-heal remains as defense-in-depth. Automation now exists to prevent a regression; a real installed-package `require.resolve` verification still needs the first real publish to run against.
5. **Clean-machine / fresh-VM verification** (spec's actual acceptance item) — still open, still genuinely untested end-to-end. This is the one item Phase 23 explicitly does not automate; it needs a real fresh macOS user account or VM once a real CI-driven publish (items 1–4) has actually happened.

**Exit criteria**

- Matches `spec.md` acceptance item: sidecar binary is codesigned + notarized; install works from a clean machine through first successful recording — verified on a fresh macOS user account / clean VM, not just the dev machine.
- `npm install -g @windower/cli` → `windower doctor` → grant permissions → `windower start`/`stop` produces a valid recording with zero manual binary placement or path configuration.
- This is the **MVP ship gate** — once this phase's exit criteria are met, `spec.md`'s acceptance checklist should be fully green.
