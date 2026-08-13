#!/usr/bin/env node
// Bumps every package in the release graph's version field by one patch,
// together, in one shot. Does NOT touch workspace:* dependency ranges —
// pnpm rewrites those to the exact published version at `pnpm publish` time,
// not at bump time, so nothing here needs to touch dependents' package.json
// dependency entries.
//
// Usage:
//   node scripts/release/bump.mjs           # bump every package in the graph
//   node scripts/release/bump.mjs --dry-run # log the plan, write nothing

import { flattenGraph, STAGES } from "./graph.mjs";
import { bumpPatch, readPackageJson, writePackageJson } from "./lib.mjs";

/**
 * Pure core: computes the bump plan and (unless dryRun) writes it.
 * Exported separately from the CLI entry so tests can call it directly with
 * injected read/write and assert on the returned plan without touching disk.
 */
export function bumpAll({
  stages = STAGES,
  root,
  dryRun = false,
  readPkg = (dir) => readPackageJson(dir, root),
  writePkg = writePackageJson,
  log = console.log,
} = {}) {
  const entries = flattenGraph(stages);
  const plan = entries.map((entry) => {
    const { path, json } = readPkg(entry.dir);
    const oldVersion = json.version;
    const newVersion = bumpPatch(oldVersion);
    return { ...entry, path, json, oldVersion, newVersion };
  });

  for (const item of plan) {
    if (dryRun) {
      log(`[dry-run] would bump ${item.pkgName}: ${item.oldVersion} -> ${item.newVersion}`);
      continue;
    }
    writePkg(item.path, { ...item.json, version: item.newVersion });
    log(`bumped ${item.pkgName}: ${item.oldVersion} -> ${item.newVersion}`);
  }

  return plan.map(({ name, pkgName, dir, oldVersion, newVersion }) => ({
    name,
    pkgName,
    dir,
    oldVersion,
    newVersion,
  }));
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  bumpAll({ dryRun });
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  main();
}
