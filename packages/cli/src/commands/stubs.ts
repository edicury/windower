import type { Command } from "commander";

/**
 * Stubs for every `contracts/cli.md` command not implemented in this pass.
 * Each still registers its full flag/argument shape from the contract — so
 * `windower --help` and per-command `--help` are accurate — but the action
 * just reports "not yet implemented" and exits non-zero. All commands
 * previously stubbed here have since been implemented in their own files
 * (`start.ts`, `status.ts`, `stop.ts`, `cancel.ts`, `record.ts`,
 * `config.ts`, `list.ts`, `permission.ts`, `resize.ts`); this file is now
 * empty pending any future not-yet-implemented command.
 */

export function registerStubCommands(_program: Command): void {
  // No stub commands remain — every `contracts/cli.md` command is
  // implemented. Kept as a no-op so `index.ts`'s registration call doesn't
  // need to be removed by whichever agent lands last.
}
