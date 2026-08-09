# Status

## Current phase
Phase 12 — Output Management: **done**.

## Done
- Phases 0–11 (foundation, sidecar protocol, macOS enumeration/permissions, window control, video capture, audio, daemon/session lifecycle, CLI, MCP server, plugin/skill, event timeline, narration hook).
- Phase 12 — Output Management:
  - `apps/daemon/src/output-resolver.ts`: `resolveFilenameTemplate` (`{target}`/`{sessionId}`/`{timestamp}`/`{date}`/`{time}`, sanitized), `ensureWritableOutputDir` (mkdir -p + write-probe, throws `DaemonError("OUTPUT_DIR_NOT_WRITABLE", ...)`), `resolveUniqueOutputPath` (never overwrites, `-2`/`-3`... suffixing).
  - New `OUTPUT_DIR_NOT_WRITABLE` daemon error code (`packages/core/src/daemon/methods.ts`) + CLI exit code mapping (`packages/cli/src/exit-codes.ts`).
  - `apps/daemon/src/session-manager.ts` `startRecording` now reads `~/.windower/config.json` (`readConfig`), merges `defaultVideo`/`defaultAudio` under per-call `params`, resolves `outputDir`, does the writable pre-flight check *before* any session/sidecar state exists, and resolves the final collision-safe output path via the template — all before spawning the sidecar.
  - `stopRecording` now `rename()`s the sidecar's temp output file into the resolved final path (real failure surfaces as a hard error, not swallowed).
  - `packages/core/src/protocol/fake-sidecar.ts`'s `stopCapture` now writes a real (small) temp file so the daemon's real `rename()` has something to move in tests.
  - `manifest.json` writer (already existed pre–Phase 12 work) verified against `OutputManifestSchema` via a Zod-validation test — matches `data-model.md`.
  - `windower config get|set` (Phase 7) already read/wrote `~/.windower/config.json` correctly — no changes needed there.
  - Exit criteria met: writes to configured output folder, manifest matches schema (Zod-validated in test), filename collisions never overwrite, non-writable `outputDir` fails at `start` not `stop`.
- Full monorepo build+test green: `@windower/core` 61/61, `@windower/daemon` 56/56, `@windower/cli` 65/65, `@windower/mcp-server` 15/15.

## Blocked / not started
- Phase 13 — Testing & Hardening (e2e, TCC-gated, local-only per CLAUDE.md).
- Phase 14 — Packaging.
- Phase 15+ — v1.1 post-processing, post-MVP Windows/Linux backends.
