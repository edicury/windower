#!/usr/bin/env node
// Publishes the release graph strictly in dependency order, per
// specs/001-windower-mvp/tasks/phase-23-ci-release-automation.md's settled
// decisions 2 and 3:
//
//   - Preflight: before ANY package publishes, every target version in the
//     whole graph is checked against the real npm registry. If any already
//     exists, the whole run refuses to proceed (hard fail, non-zero exit) —
//     an "already exists" registry response is fatal, never retried on the
//     same version.
//   - Publish order follows graph.mjs's STAGES exactly. A stage only starts
//     once every package in every earlier stage has published successfully
//     (publish step exited 0). Any single package's publish failing —
//     including "already exists" — hard-stops the whole process; later
//     packages in the order are never attempted.
//
// Usage:
//   NPM_TOKEN=... node scripts/release/publish.mjs           # real publish
//   node scripts/release/publish.mjs --dry-run                # plan only, no network calls

import { flattenGraph, STAGES } from "./graph.mjs";
import {
  publishPackage,
  readPackageJson,
  registryVersionExists,
  setupNpmAuth,
} from "./lib.mjs";

/**
 * Pure core of the publish flow. Everything that touches the network or the
 * filesystem is injected, so tests can assert on ordering/stop-on-failure/
 * refuse-on-conflict behavior without hitting the real registry or `pnpm`.
 *
 * @returns {{ ok: boolean, attempted: string[], failedAt: object|null, reason: string|null, versionConflicts: string[] }}
 */
export async function runRelease({
  stages = STAGES,
  root,
  dryRun = false,
  readPkg = (dir) => readPackageJson(dir, root),
  checkExists,
  publish,
  log = console.log,
} = {}) {
  const entries = flattenGraph(stages).map((entry) => {
    const { json } = readPkg(entry.dir);
    return { ...entry, version: json.version };
  });

  if (dryRun) {
    for (const stage of stages) {
      log(`[dry-run] stage: ${stage.map((e) => `${e.pkgName}@${entries.find((x) => x.name === e.name).version}`).join(", ")}`);
    }
    return { ok: true, attempted: [], failedAt: null, reason: null, versionConflicts: [] };
  }

  // --- Preflight: whole graph, before any publish. ---
  const versionConflicts = [];
  for (const entry of entries) {
    const exists = await checkExists(entry.pkgName, entry.version);
    if (exists) {
      versionConflicts.push(`${entry.pkgName}@${entry.version}`);
    }
  }
  if (versionConflicts.length > 0) {
    const reason =
      `Refusing to publish: the following version(s) already exist on the npm registry ` +
      `and a version number is never reused (bump and try again): ${versionConflicts.join(", ")}`;
    log(`ERROR: ${reason}`);
    return { ok: false, attempted: [], failedAt: null, reason, versionConflicts };
  }

  // --- Publish, strictly in stage order. ---
  const attempted = [];
  for (const stage of stages) {
    for (const name of stage.map((e) => e.name)) {
      const entry = entries.find((e) => e.name === name);
      attempted.push(entry.pkgName);
      log(`publishing ${entry.pkgName}@${entry.version} ...`);
      const result = await publish(entry);
      if (!result || result.status !== 0) {
        const reason =
          `Publish failed for ${entry.pkgName}@${entry.version} (exit ${result?.status}): ` +
          `${result?.stderr || result?.error || "unknown error"}. ` +
          `Hard-stopping — no later package in the release order will be published.`;
        log(`ERROR: ${reason}`);
        return { ok: false, attempted, failedAt: entry, reason, versionConflicts: [] };
      }
    }
    // Verify (at minimum, exit codes checked above) every package in this
    // stage succeeded before starting the next stage — enforced by the loop
    // structure itself: we never reach the next `for (const stage ...)`
    // iteration without every entry in this stage having returned status 0.
  }

  return { ok: true, attempted, failedAt: null, reason: null, versionConflicts: [] };
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const token = process.env.NPM_TOKEN;

  let npmrcPath;
  let cleanup = () => {};
  if (!dryRun) {
    const auth = setupNpmAuth(token);
    npmrcPath = auth.npmrcPath;
    cleanup = auth.cleanup;
    process.env.NODE_AUTH_TOKEN = token;
  }

  try {
    const result = await runRelease({
      dryRun,
      checkExists: (pkgName, version) => registryVersionExists(pkgName, version),
      publish: (entry) => publishPackage(entry, { npmrcPath }),
    });
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    cleanup();
  }
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  await main();
}
