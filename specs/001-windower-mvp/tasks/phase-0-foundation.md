## Phase 0 — Foundation

**Goal:** Stand up the monorepo skeleton so every later phase has a place to land, including the cross-language (TS + Swift) build pipeline.

- ✅ `pnpm-workspace.yaml` + root `package.json` + `turbo.json`. Workspaces: `apps/*`, `packages/*`, `plugins/*`.
- ✅ `packages/config` — shared `biome.json`, base `tsconfig.json`.
- ✅ Empty-but-wired packages: `packages/core`, `packages/cli`, `packages/mcp-server`, `apps/daemon`, `plugins/claude-code`. Each has a `package.json`, builds via `turbo run build`, and exports nothing yet beyond a placeholder.
- ✅ `native/macos/` — Swift Package Manager package (`Package.swift`) targeting macOS 12.3+, empty executable target `windower-sidecar-macos` that responds to `describe` over stdio (hand-rolled, no protocol lib yet — proves the plumbing).
- ✅ Turbo task wiring so `turbo run build` builds both the TS workspace and runs `swift build` for the sidecar, and `turbo run test` runs Vitest + `swift test`.
- ✅ `.gitignore` for `node_modules`, `.build/` (Swift), `dist/`, `~/.windower` references N/A (that's a runtime dir, not repo).
- ✅ Root `README.md` — one-paragraph project description + link to `specs/001-windower-mvp/`.
- ✅ GitHub Actions CI skeleton: lint + typecheck + unit test job on macOS runners (needed because Swift target requires macOS to build).

**Exit criteria**

- `pnpm install && pnpm build` succeeds from a clean checkout on macOS.
- `turbo run test` runs (even if trivially) across both TS and Swift.
- CI is green on a no-op PR.
- No functional capability yet — this phase is pure scaffolding.
