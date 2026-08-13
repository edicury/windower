// Explicit dependency-graph ordering for release-order publishing.
//
// This is NOT derived from scanning `workspace:*` — that would tell us "X
// depends on Y" but not "X must be live on the registry before Y publishes,
// strictly in this stage order." pnpm rewrites `workspace:*` to the exact
// currently-published version at publish time, so a dependency must already
// be resolvable on the registry before anything that points at it publishes.
//
// STAGES is an ordered array of stages; each stage is an array of package
// entries that may publish in either order relative to each other, but only
// after every earlier stage has fully succeeded and before any later stage
// starts. See specs/001-windower-mvp/tasks/phase-23-ci-release-automation.md
// settled decision 2.

/**
 * @typedef {{ name: string, dir: string, pkgName: string }} ReleaseEntry
 */

/** @type {ReleaseEntry[][]} */
export const STAGES = [
  [{ name: "core", dir: "packages/core", pkgName: "@windower/core" }],
  [
    { name: "engine", dir: "packages/engine", pkgName: "@windower/engine" },
    {
      name: "engine-narration",
      dir: "packages/engine-narration",
      pkgName: "@windower/engine-narration",
    },
  ],
  [{ name: "daemon", dir: "apps/daemon", pkgName: "@windower/daemon" }],
  [{ name: "cli", dir: "packages/cli", pkgName: "@windower/cli" }],
  [{ name: "mcp-server", dir: "packages/mcp-server", pkgName: "@windower/mcp-server" }],
  [
    {
      name: "sidecar-macos-arm64",
      dir: "packages/sidecar-macos-arm64",
      pkgName: "@windower/sidecar-macos-arm64",
    },
    {
      name: "sidecar-macos-x64",
      dir: "packages/sidecar-macos-x64",
      pkgName: "@windower/sidecar-macos-x64",
    },
  ],
];

/** @returns {ReleaseEntry[]} every package entry, in strict publish order (stage order, then within-stage declaration order) */
export function flattenGraph(stages = STAGES) {
  return stages.flat();
}
