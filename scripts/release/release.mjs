#!/usr/bin/env node
// Single entry point for release tooling, with bump and publish kept as
// separable steps (CI runs bump, commits/tags, THEN publishes as distinct
// workflow steps — see phase-23-ci-release-automation.md).
//
// Usage:
//   node scripts/release/release.mjs bump [--dry-run]
//   node scripts/release/release.mjs publish [--dry-run]
//
// Equivalent to running scripts/release/bump.mjs / publish.mjs directly.

const [, , subcommand, ...rest] = process.argv;

if (subcommand === "bump") {
  const { main } = await import("./bump.mjs");
  main(rest);
} else if (subcommand === "publish") {
  const { main } = await import("./publish.mjs");
  await main(rest);
} else {
  console.error(
    `Usage: node scripts/release/release.mjs <bump|publish> [--dry-run]\n` +
      `Got subcommand: ${subcommand ?? "(none)"}`,
  );
  process.exitCode = 1;
}
