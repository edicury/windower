import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type OperatorRun,
  OperatorRunSchema,
  type OperatorRunState,
  windowerHome,
} from "@windower/core";

/**
 * Directory holding one `<runId>.json` per `OperatorRun` — the operator's
 * counterpart to `sessionsDir()` (`~/.windower/sessions`). Defined here rather
 * than in `@windower/core`'s `daemon/paths.ts` because nothing outside the
 * daemon reads these files directly; everyone else goes through
 * `get_operator_run`/`list_operator_runs`.
 */
export function operatorRunsDir(): string {
  return join(windowerHome(), "operator-runs");
}

export function operatorRunFilePath(runId: string): string {
  return join(operatorRunsDir(), `${runId}.json`);
}

/**
 * Persists `OperatorRun` records to `~/.windower/operator-runs/<runId>.json`
 * on every state transition — the same write-through-cache convention
 * `SessionStore` uses for `RecordingSession`, and required for the same
 * reasons (crash recovery on daemon restart, `windower operate status <runId>`
 * surviving a daemon bounce).
 *
 * Every write goes through `OperatorRunSchema.parse`, which strips unknown
 * keys — a structural guarantee that nothing the operator loop attaches to a
 * run in memory (resolved secrets above all) can reach disk.
 */
export class OperatorRunStore {
  private readonly cache = new Map<string, OperatorRun>();

  /** Loads every persisted run file into the in-memory cache. Call once at daemon startup. */
  async load(): Promise<OperatorRun[]> {
    await mkdir(operatorRunsDir(), { recursive: true });
    const entries = await readdir(operatorRunsDir()).catch(() => [] as string[]);
    const runs: OperatorRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const run = await this.readFile(entry);
      if (run) {
        this.cache.set(run.id, run);
        runs.push(run);
      }
    }
    return runs;
  }

  private async readFile(fileName: string): Promise<OperatorRun | undefined> {
    try {
      const raw = await readFile(join(operatorRunsDir(), fileName), "utf8");
      return OperatorRunSchema.parse(JSON.parse(raw));
    } catch {
      // Malformed/partially-written run file — skip rather than crash daemon
      // startup over one bad record (mirrors SessionStore.readFile).
      return undefined;
    }
  }

  get(runId: string): OperatorRun | undefined {
    return this.cache.get(runId);
  }

  list(state?: OperatorRunState): OperatorRun[] {
    const all = [...this.cache.values()];
    return state ? all.filter((run) => run.state === state) : all;
  }

  /** Persists a run to disk and updates the in-memory cache. Call on every state transition. */
  async save(run: OperatorRun): Promise<void> {
    const sanitized = OperatorRunSchema.parse(run);
    await mkdir(operatorRunsDir(), { recursive: true });
    // Write-then-rename: a run transitions on every step, so `windower operate
    // status <runId>` (and crash recovery) would otherwise be able to read a
    // half-written file mid-run.
    const finalPath = operatorRunFilePath(sanitized.id);
    const tempPath = `${finalPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
    await rename(tempPath, finalPath);
    this.cache.set(sanitized.id, sanitized);
  }
}
