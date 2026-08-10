import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rule contracts/operator-loop-protocol.md exists to enforce:
 *
 * > The loop child **never** constructs a `SidecarClient`, **never** spawns a
 * > native binary, and **never** opens `~/.windower/capture.lock`.
 *
 * > This is enforced by a dependency-graph test over the loop entry point's
 * > import closure, not by code review — mirroring how the native split is
 * > enforced by `otool -L` rather than convention.
 *
 * Letting the loop process touch ScreenCaptureKit itself would silently
 * reintroduce the exact multi-process `replayd` hazard the ScreenCaptureKit
 * exclusivity mutex (`contracts/screen-capture-exclusivity.md`) exists to
 * eliminate, so this file is the mechanism, not a description of one.
 *
 * The three prohibitions map onto the three checks below: `FORBIDDEN_SPECIFIERS`
 * covers spawning a native binary, `FORBIDDEN_BINDINGS` covers constructing a
 * `SidecarClient`, and `FORBIDDEN_FILE_PATTERN` covers both plus the capture
 * lock module (`screen-capture-lock`) that owns `~/.windower/capture.lock`.
 *
 * The walk resolves **named bindings**, not just module specifiers. That
 * matters: `@windower/core`'s public entry is a barrel that re-exports
 * `sidecar-process.js`, so a specifier-level check would either pass
 * vacuously (ignore the barrel) or fail vacuously (reject every core import).
 * Resolving `import { X } from "@windower/core"` to the file that *declares* X
 * and continuing from there makes the barrel non-load-bearing: importing a Zod
 * schema stays clean, importing `spawnSidecar` does not. `import type` is
 * skipped entirely because it is erased before anything runs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OPERATOR_SRC = resolve(HERE, "..");
const CORE_SRC = resolve(HERE, "../../../core/src");

/**
 * Module specifiers that can reach a native binary or another process.
 *
 * `@windower/engine` is here for the third prohibition specifically: it owns
 * `screen-capture-lock.ts` and therefore `~/.windower/capture.lock`, and it is
 * also where every recording/session type lives. A package-level ban is the
 * only check that can see it — the walker resolves relative and `@windower/core`
 * imports into files, but any other workspace package appears as an external
 * specifier and would otherwise slip past the file-name pattern.
 */
const FORBIDDEN_SPECIFIERS = [
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "cluster",
  "node:cluster",
  "vm",
  "node:vm",
  "@windower/engine",
];

/** Source files that own the native process boundary. */
const FORBIDDEN_FILE_PATTERN = /(sidecar-process|sidecar-client|sidecar-path|screen-capture-lock)/;

/** Bindings whose mere presence means the loop reached the native surface. */
const FORBIDDEN_BINDINGS = [
  "SidecarClient",
  "SpawnedSidecar",
  "spawnSidecar",
  "resolveSidecarBinaryPath",
];

interface ImportRef {
  specifier: string;
  /** Empty for namespace/side-effect imports, which pull the whole module. */
  names: string[];
  /** True for `import * as ns` / bare `import "x"` — no name granularity. */
  wholeModule: boolean;
}

interface Closure {
  files: Set<string>;
  externals: Set<string>;
  bindings: Set<string>;
  /** Core value imports the walker could not attribute to a declaring file. */
  unresolved: Set<string>;
}

const STATEMENT_RE = /(?:^|[\n;])\s*(?:import|export)(?:\s+([\s\S]*?)\s+from)?\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /(?:\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;

function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of source.matchAll(STATEMENT_RE)) {
    const clause = (match[1] ?? "").trim();
    const specifier = match[2] as string;
    if (clause.length === 0) {
      refs.push({ specifier, names: [], wholeModule: true });
      continue;
    }
    if (/^type\b/.test(clause)) continue; // erased at compile time
    if (clause.includes("*")) {
      refs.push({ specifier, names: [], wholeModule: true });
      continue;
    }
    const braces = clause.match(/\{([\s\S]*)\}/);
    const names: string[] = [];
    const defaultPart = clause
      .replace(/\{[\s\S]*\}/, "")
      .replace(/,/g, " ")
      .trim();
    if (defaultPart.length > 0) names.push(defaultPart.split(/\s+/)[0] as string);
    if (braces) {
      for (const entry of (braces[1] as string).split(",")) {
        const trimmed = entry.trim();
        if (trimmed.length === 0) continue;
        if (/^type\b/.test(trimmed)) continue; // erased
        names.push((trimmed.split(/\s+as\s+/)[0] as string).trim());
      }
    }
    refs.push({ specifier, names, wholeModule: false });
  }
  for (const match of source.matchAll(DYNAMIC_RE)) {
    refs.push({ specifier: match[1] as string, names: [], wholeModule: true });
  }
  return refs;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const DECLARATION_RE =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z0-9_$]+)/gm;
const REEXPORT_LIST_RE = /^export\s*\{([^}]*)\}(?!\s*from)/gm;

/**
 * name → declaring file, over every source file in `@windower/core`. Built
 * without consulting the barrel, so `export *` chains cannot hide a declaration.
 */
function buildCoreExportMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of listTsFiles(CORE_SRC)) {
    if (file.includes(".test.")) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DECLARATION_RE)) map.set(match[1] as string, file);
    for (const match of source.matchAll(REEXPORT_LIST_RE)) {
      for (const entry of (match[1] as string).split(",")) {
        const name = entry
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name !== undefined && name.length > 0 && !/^type\b/.test(entry.trim())) {
          if (!map.has(name)) map.set(name, file);
        }
      }
    }
  }
  return map;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  return base.replace(/\.js$/, ".ts");
}

/** Walks the runtime import closure of `entry`, resolving core by binding name. */
function walk(entry: string, coreExports: Map<string, string>): Closure {
  const files = new Set<string>();
  const externals = new Set<string>();
  const bindings = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const ref of parseImports(source)) {
      for (const name of ref.names) bindings.add(name);
      if (ref.specifier.startsWith(".")) {
        queue.push(resolveRelative(file, ref.specifier));
        continue;
      }
      if (ref.specifier === "@windower/core") {
        for (const name of ref.names) {
          const declaring = coreExports.get(name);
          // An unresolvable value import is reported, never silently dropped —
          // a hole here would be a hole in the guarantee.
          if (declaring === undefined) unresolved.add(`${name} (from ${file})`);
          else queue.push(declaring);
        }
        if (ref.wholeModule) queue.push(join(CORE_SRC, "index.ts"));
        continue;
      }
      externals.add(ref.specifier);
    }
  }
  return { files, externals, bindings, unresolved };
}

const coreExports = buildCoreExportMap();
const LOOP_ENTRY = join(OPERATOR_SRC, "loop-entry.ts");

describe("operator-loop child — dependency-graph enforcement", () => {
  const closure = walk(LOOP_ENTRY, coreExports);

  it("reaches no module that can spawn a process", () => {
    const offenders = [...closure.externals].filter((s) => FORBIDDEN_SPECIFIERS.includes(s));
    expect(offenders, `loop-entry.ts reaches: ${offenders.join(", ")}`).toEqual([]);
  });

  it("reaches no sidecar process/client/path module", () => {
    const offenders = [...closure.files].filter((f) => FORBIDDEN_FILE_PATTERN.test(f));
    expect(offenders, `loop-entry.ts reaches: ${offenders.join(", ")}`).toEqual([]);
  });

  it("imports no binding that constructs or spawns a sidecar", () => {
    const offenders = [...closure.bindings].filter((b) => FORBIDDEN_BINDINGS.includes(b));
    expect(offenders).toEqual([]);
  });

  it("attributes every core value import to a declaring file", () => {
    expect([...closure.unresolved]).toEqual([]);
  });

  it("actually walks something — the closure is not vacuously empty", () => {
    expect(closure.files.size).toBeGreaterThan(5);
    expect([...closure.files].some((f) => f.endsWith("loop/deps.ts"))).toBe(true);
    expect([...closure.files].some((f) => f.endsWith("run.ts"))).toBe(true);
    // The provider SDK is expected and is the whole reason this process exists.
    expect([...closure.externals].some((s) => s === "ai")).toBe(true);
  });

  it("fails when a loop module reaches the native surface (negative control)", () => {
    // Proof that the checks above can fail: the same walker, over a file that
    // does exactly what the contract forbids. `packages/core`'s own
    // `sidecar-process.ts` is that file — it is what a compromised loop would
    // have to reach — and the walker must see it.
    const offending = join(CORE_SRC, "process", "sidecar-process.ts");
    const bad = walk(offending, coreExports);
    expect([...bad.externals].filter((s) => FORBIDDEN_SPECIFIERS.includes(s))).not.toEqual([]);
    expect([...bad.files].filter((f) => FORBIDDEN_FILE_PATTERN.test(f))).not.toEqual([]);
    expect([...bad.bindings].filter((b) => FORBIDDEN_BINDINGS.includes(b))).not.toEqual([]);
  });

  it("fails when a loop module reaches native capability through the core barrel (negative control)", () => {
    // The realistic regression: someone adds a value import from
    // `@windower/core` that happens to be the spawn helper. A specifier-level
    // check would wave this through; binding resolution must not.
    const offending = join(tmpdir(), `windower-loop-negative-control-${process.pid}.ts`);
    writeFileSync(
      offending,
      'import { spawnSidecar } from "@windower/core";\nexport const boom = spawnSidecar;\n',
      "utf8",
    );
    try {
      const bad = walk(offending, coreExports);
      expect([...bad.files].filter((f) => FORBIDDEN_FILE_PATTERN.test(f))).not.toEqual([]);
      expect([...bad.externals]).toContain("node:child_process");
      expect([...bad.bindings]).toContain("spawnSidecar");
    } finally {
      rmSync(offending, { force: true });
    }
  });

  it("resolves a core binding to its declaring file, not to the barrel", () => {
    // If this ever regressed to specifier-level matching, `spawnSidecar` would
    // look identical to `parseModelConfig` and the whole test would be theatre.
    expect(coreExports.get("spawnSidecar")).toMatch(/process[/\\]sidecar-process\.ts$/);
    expect(coreExports.get("BATCH_ABORTED_RESULT")).toMatch(/schemas[/\\]operator\.ts$/);
  });
});

describe("operator-loop child — recording independence", () => {
  it("has no route to stop, cancel, or finalize a recording", () => {
    // contracts/operator.md §Recording independence: an OperatorRun never knows
    // whether a recording exists, and never starts, stops, or looks one up.
    // Enforcement is daemon-side, but the child must not even have the
    // vocabulary — there is no method on this wire that could touch a recording
    // if the child were fully compromised.
    const loopSources = [...walk(LOOP_ENTRY, coreExports).files]
      .filter((f) => f.startsWith(join(OPERATOR_SRC, "loop")))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const forbidden of [
      "stopRecording",
      "cancelRecording",
      "cancelCapture",
      "startRecording",
      "finalize",
    ]) {
      expect(loopSources.includes(forbidden), forbidden).toBe(false);
    }
  });
});
