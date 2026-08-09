import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  type RecordingSession,
  RecordingSessionSchema,
  type SessionState,
  sessionFilePath,
  sessionsDir,
} from "@windower/core";

/**
 * Persists `RecordingSession` records to `~/.windower/sessions/<id>.json` on
 * every state transition (phase-6 task file: "required for crash recovery
 * and `windower status` after a daemon restart"). Keeps an in-memory cache
 * so reads don't hit disk on every RPC call — the cache is always written
 * through, never the source of truth on its own.
 */
export class SessionStore {
  private readonly cache = new Map<string, RecordingSession>();

  /** Loads every persisted session file into the in-memory cache. Call once at daemon startup. */
  async load(): Promise<RecordingSession[]> {
    await mkdir(sessionsDir(), { recursive: true });
    const entries = await readdir(sessionsDir()).catch(() => [] as string[]);
    const sessions: RecordingSession[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const session = await this.readFile(entry);
      if (session) {
        this.cache.set(session.id, session);
        sessions.push(session);
      }
    }
    return sessions;
  }

  private async readFile(fileName: string): Promise<RecordingSession | undefined> {
    try {
      const raw = await readFile(`${sessionsDir()}/${fileName}`, "utf8");
      return RecordingSessionSchema.parse(JSON.parse(raw));
    } catch {
      // Malformed/partially-written session file — skip rather than crash
      // daemon startup over one bad record.
      return undefined;
    }
  }

  get(sessionId: string): RecordingSession | undefined {
    return this.cache.get(sessionId);
  }

  list(state?: SessionState): RecordingSession[] {
    const all = [...this.cache.values()];
    return state ? all.filter((s) => s.state === state) : all;
  }

  /** Persists a session to disk and updates the in-memory cache. Call on every state transition. */
  async save(session: RecordingSession): Promise<void> {
    await mkdir(sessionsDir(), { recursive: true });
    await writeFile(sessionFilePath(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    this.cache.set(session.id, session);
  }
}
