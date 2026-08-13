/**
 * Builds the `windower` Commander program with every command registered —
 * split out of `index.ts` so `policy.test.ts` can walk the exact same
 * command tree the real binary registers (import this, not a hand-rolled
 * duplicate list) without also invoking `program.parseAsync(process.argv)`.
 */
import { packageVersion } from "@windower/core";
import { Command } from "commander";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerListCommand } from "./commands/list.js";
import { registerPermissionCommand } from "./commands/permission.js";
import { registerRecordCommand } from "./commands/record.js";
import { registerResizeCommand } from "./commands/resize.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerStubCommands } from "./commands/stubs.js";
import { registerTargetsCommand } from "./commands/targets.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("windower")
    .description("AI-native screen recorder — record demos from the CLI or an agent")
    .version(packageVersion(import.meta.url))
    // Debugging escape hatches (contracts/cli.md "Daemon policy"): force a
    // command that would otherwise resolve to `local`/`daemon` to the other
    // mode. `attach`-mode commands (`stop`, `cancel`, `daemon status|stop|restart`)
    // ignore these — see `backend.ts`'s `effectiveMode`. `WINDOWER_BACKEND=local|daemon`
    // is the environment-variable equivalent, read directly from `process.env`
    // by `resolveForcedMode` (an env var has no Commander representation).
    .option("--daemon", "force daemon-backed mode for this invocation, overriding the policy table")
    .option(
      "--no-daemon",
      "force local (daemon-free) mode for this invocation, overriding the policy table",
    );

  registerTargetsCommand(program);
  registerDoctorCommand(program);
  registerDaemonCommand(program);
  registerPermissionCommand(program);
  registerResizeCommand(program);
  registerConfigCommand(program);
  registerListCommand(program);
  registerStartCommand(program);
  registerStatusCommand(program);
  registerStopCommand(program);
  registerCancelCommand(program);
  registerRecordCommand(program);
  registerStubCommands(program);

  return program;
}
