import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Finds the pid of a direct child of `parentPid` whose command line
 * contains `commandSubstring`, via `ps -eo pid,ppid,command`. Used by the
 * sidecar crash-injection test to get the *real* sidecar OS pid to
 * `kill -9` — the daemon protocol has no RPC that exposes a session's
 * sidecar pid (contracts/sidecar-protocol.md doesn't need one; this is
 * test-harness-only process-table introspection, not something
 * `packages/core`/`apps/daemon` should ever expose above the stdio line).
 * Filtering by parent pid (rather than a bare `pgrep -f`) avoids false
 * positives from any other windower dev processes that might be running on
 * the same machine.
 */
export async function findChildPidByCommand(
  parentPid: number,
  commandSubstring: string,
): Promise<number | undefined> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,ppid,command"]);
  const lines = stdout.split("\n").slice(1); // header
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, command] = match;
    if (Number(ppidStr) === parentPid && command.includes(commandSubstring)) {
      return Number(pidStr);
    }
  }
  return undefined;
}
