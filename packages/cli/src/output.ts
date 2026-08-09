import { DaemonError } from "@windower/core";
import { exitCodeForError } from "./exit-codes.js";

/**
 * Prints a successful command result: raw JSON (`--json`) or a
 * human-readable rendering, to stdout. `humanRenderer` receives the same
 * `data` that would be JSON-serialized — commands should never reshape data
 * differently between the two modes, only how it's displayed.
 */
export function printResult<T>(json: boolean, data: T, humanRenderer: (data: T) => string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${humanRenderer(data)}\n`);
  }
}

/**
 * Prints a failed command's error to stderr — `{ error: { code, message } }`
 * JSON, or a plain `Error: <message>` line — and returns the process exit
 * code the caller should set (`process.exitCode = printError(...)`).
 */
export function printError(json: boolean, err: unknown): number {
  const code = err instanceof DaemonError ? err.code : "INTERNAL_ERROR";
  const message = err instanceof Error ? err.message : String(err);

  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }

  return exitCodeForError(err);
}
