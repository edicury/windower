import { readFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { windowerHome } from "./paths.js";

/**
 * `~/.windower/sidecar-pids.json` — pids of native sidecar child processes
 * (`packages/core/src/process/sidecar-process.ts`) the daemon currently owns
 * (capture + control surfaces, `contracts/sidecar-protocol.md`). Sidecar
 * pids only ever live in the spawning daemon's memory otherwise — a fresh
 * CLI process invoking `windower daemon kill` shares none of that memory, so
 * this file is the only way it can discover which native processes to
 * force-kill alongside the daemon itself. Written/cleared by the daemon
 * process (`apps/daemon/src/main.ts` wraps `spawnSidecar` to keep this file
 * in sync with every spawn/exit); `windower daemon kill` only ever reads and
 * clears it, never writes pids into it.
 *
 * Deliberately a flat array, not keyed by session/surface — `daemon kill`
 * doesn't need to know *which* sidecar a pid belongs to, only that it's one
 * the daemon spawned and should die with it.
 */
export interface SidecarPidsFile {
  pids: number[];
}

/** Path to `~/.windower/sidecar-pids.json` (respects `WINDOWER_HOME` override). */
export function sidecarPidsFilePath(): string {
  return join(windowerHome(), "sidecar-pids.json");
}

// Every read-modify-write below is serialized through this promise chain so
// concurrent spawns/exits within the same daemon process (e.g. the capture
// and control sidecars starting close together) never race and lose an
// update — `sidecar-pids.json` has exactly one writer process (the daemon),
// but that process can still issue overlapping async writes.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

/**
 * Reads the current set of tracked sidecar pids. Returns `[]` — never
 * throws — when the file is absent or malformed, matching `readDaemonState`'s
 * "missing/corrupt collapses to the empty case" convention.
 */
export async function readSidecarPids(): Promise<number[]> {
  let text: string;
  try {
    text = await readFile(sidecarPidsFilePath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as SidecarPidsFile).pids) &&
      (parsed as SidecarPidsFile).pids.every((p) => typeof p === "number")
    ) {
      return (parsed as SidecarPidsFile).pids;
    }
    return [];
  } catch {
    return [];
  }
}

async function writePids(pids: number[]): Promise<void> {
  const path = sidecarPidsFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ pids }, null, 2)}\n`);
}

/** Records `pid` as a sidecar the daemon owns. Idempotent — adding an already-tracked pid is a no-op. */
export function addSidecarPid(pid: number): Promise<void> {
  return enqueue(async () => {
    const pids = await readSidecarPids();
    if (pids.includes(pid)) return;
    await writePids([...pids, pid]);
  });
}

/** Stops tracking `pid` (the sidecar exited). Idempotent — removing an untracked pid is a no-op. */
export function removeSidecarPid(pid: number): Promise<void> {
  return enqueue(async () => {
    const pids = await readSidecarPids();
    if (!pids.includes(pid)) return;
    await writePids(pids.filter((p) => p !== pid));
  });
}

/** Unlinks the tracking file entirely — used on clean daemon shutdown, mirrors `clearDaemonState`. */
export function clearSidecarPids(): Promise<void> {
  return enqueue(async () => {
    await rm(sidecarPidsFilePath(), { force: true });
  });
}
