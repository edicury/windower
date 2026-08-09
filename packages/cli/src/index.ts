#!/usr/bin/env node
/**
 * @windower/cli — the `windower` binary, a thin wrapper over @windower/core.
 * See specs/001-windower-mvp/contracts/cli.md for the full command contract.
 */
import { Command } from "commander";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerListCommand } from "./commands/list.js";
import { registerOperateCommand } from "./commands/operate.js";
import { registerPermissionCommand } from "./commands/permission.js";
import { registerRecordCommand } from "./commands/record.js";
import { registerResizeCommand } from "./commands/resize.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerStubCommands } from "./commands/stubs.js";
import { registerTargetsCommand } from "./commands/targets.js";

const program = new Command();

program
  .name("windower")
  .description("AI-native screen recorder — record demos from the CLI or an agent")
  .version("0.0.0");

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
registerOperateCommand(program);
registerStubCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
