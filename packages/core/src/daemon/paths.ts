import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Env var override for `~/.windower` — used by tests so daemon state never
 * touches a real user's home directory.
 */
export const WINDOWER_HOME_ENV = "WINDOWER_HOME";

/** Root state directory: `~/.windower` (or `WINDOWER_HOME` override). */
export function windowerHome(): string {
  const override = process.env[WINDOWER_HOME_ENV];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".windower");
}

/** Unix domain socket the daemon listens on. `0600` perms, set on listen. */
export function daemonSocketPath(): string {
  return join(windowerHome(), "daemon.sock");
}

/** Directory holding one `<sessionId>.json` per `RecordingSession`. */
export function sessionsDir(): string {
  return join(windowerHome(), "sessions");
}

export function sessionFilePath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

/** `~/.windower/config.json` — output folder, idle timeout, defaults (contracts/cli.md `config get|set`). */
export function configFilePath(): string {
  return join(windowerHome(), "config.json");
}

/** Default output folder for finalized recordings (plan.md §"No network calls" note). */
export function defaultOutputDir(): string {
  return join(homedir(), "Movies", "Windower");
}
