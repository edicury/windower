import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { DaemonIdentitySchema } from "./protocol.js";
import { windowerHome } from "./paths.js";

/**
 * `~/.windower/daemon.json` — the daemon identity state file, written on
 * successful `listen()` and unlinked on graceful shutdown. Same shape as
 * `hello`/`daemon_info`'s result (`DaemonIdentitySchema` in `protocol.ts`)
 * on purpose, so `doctor`/stale-socket detection can learn daemon identity
 * and check pid liveness without connecting to the socket. See
 * `data-model.md`'s "Daemon state file" section and
 * `contracts/daemon-rpc.md`.
 */
export const DaemonStateFileSchema = DaemonIdentitySchema;
export type DaemonStateFile = ReturnType<typeof DaemonStateFileSchema.parse>;

/** Path to `~/.windower/daemon.json` (respects `WINDOWER_HOME` override, per `paths.ts`). */
export function daemonStateFilePath(): string {
  return join(windowerHome(), "daemon.json");
}

/**
 * Writes the daemon identity state file on listen. Uses `writeFileAtomic`
 * (temp file + rename in the same directory) so a concurrent reader (e.g.
 * `windower doctor` or a racing `ensureDaemonRunning`) never observes a torn
 * write.
 */
export async function writeDaemonState(state: DaemonStateFile): Promise<void> {
  const validated = DaemonStateFileSchema.parse(state);
  const path = daemonStateFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(validated, null, 2)}\n`);
}

/**
 * Unlinks the state file on clean/graceful stop. Missing file is not an
 * error — `stop` is idempotent and may run against a state file that was
 * never written (e.g. daemon crashed before `listen()` completed).
 */
export async function clearDaemonState(): Promise<void> {
  await rm(daemonStateFilePath(), { force: true });
}

/**
 * Reads and parses `~/.windower/daemon.json`. Returns `null` — never
 * throws — when the file is absent (the normal "no daemon running" case) or
 * malformed (partial write from a crash, corrupt JSON, schema mismatch from
 * an old daemon version). Callers that need to distinguish "not running"
 * from "unreadable" don't exist yet; both collapse to `null` today, matching
 * how stale-socket detection only cares about "is there a live, trustworthy
 * identity here or not."
 */
export async function readDaemonState(): Promise<DaemonStateFile | null> {
  let text: string;
  try {
    text = await readFile(daemonStateFilePath(), "utf8");
  } catch {
    return null;
  }
  try {
    return DaemonStateFileSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}
