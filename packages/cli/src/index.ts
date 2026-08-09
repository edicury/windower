#!/usr/bin/env node
/**
 * @windower/cli — the `windower` binary, a thin wrapper over @windower/core.
 * See specs/001-windower-mvp/contracts/cli.md for the full command contract.
 */
import { buildProgram } from "./program.js";

const program = buildProgram();

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
