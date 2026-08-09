## Phase 14 — Packaging

**Goal:** Ship an installable artifact — codesigned/notarized sidecar binary, npm package, plugin install — that works on a clean machine through to a first successful recording.

- 🔵 Apple Developer ID codesigning + notarization for `windower-sidecar-macos` (required for Gatekeeper to allow execution without a manual override on a clean machine).
- 🔵 Binary resolution strategy for the published npm package: bundle the signed binary directly in a platform-specific optional-dependency package (`@windower/sidecar-macos-arm64`/`-x64`) resolved via npm's `optionalDependencies` + `os`/`cpu` fields, following the pattern used by esbuild/swc-style native binaries — avoids a separate download step.
- 🔵 `@windower/cli` npm package — depends on `packages/core`, resolves the platform sidecar package, ships the `windower` bin entry.
- 🔵 `@windower/mcp-server` npm package.
- 🔵 `plugins/claude-code` packaged per the current Claude Code plugin distribution mechanism (marketplace entry or direct install path — confirm current mechanism at implementation time).
- 🔵 First-run onboarding: `windower doctor` on a totally fresh install produces clear, actionable output (not a stack trace) pointing at `windower permission request ...` for each missing grant.
- 🔵 Version compatibility check: daemon/CLI/sidecar all report a version; a mismatched sidecar (e.g. stale binary from a prior install) is detected and surfaced clearly rather than causing confusing protocol errors.

**Exit criteria**

- Matches `spec.md` acceptance item: sidecar binary is codesigned + notarized; install works from a clean machine through first successful recording — verified on a fresh macOS user account / clean VM, not just the dev machine.
- `npm install -g @windower/cli` → `windower doctor` → grant permissions → `windower start`/`stop` produces a valid recording with zero manual binary placement or path configuration.
- This is the **MVP ship gate** — once this phase's exit criteria are met, `spec.md`'s acceptance checklist should be fully green.
