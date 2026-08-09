import { DaemonError, type DaemonResizeWindowResult, type Rect } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printError, printResult } from "../output.js";

interface ResizeOpts {
  window: string;
  width: string;
  height: string;
  x?: string;
  y?: string;
  json?: boolean;
}

function parsePositiveNumber(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new DaemonError("INVALID_ARGS", `Invalid ${label} "${raw}" — expected a positive number`);
  }
  return value;
}

function parseOptionalNumber(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new DaemonError("INVALID_ARGS", `Invalid ${label} "${raw}" — expected a number`);
  }
  return value;
}

/**
 * `windower resize --window <id> --width <px> --height <px> [--x <px>] [--y <px>] [--json]`
 * — contracts/cli.md. `DaemonResizeWindowParams.bounds` is a full `Rect`, so
 * when `--x`/`--y` are omitted we look up the target's current position via
 * `list_targets` and keep it — i.e. resize-in-place is the default, matching
 * "resize" (not "move") being the bare command name.
 */
export function registerResizeCommand(program: Command): void {
  program
    .command("resize")
    .description("Resize/reposition a window before recording")
    .requiredOption("--window <id>", "window target id")
    .requiredOption("--width <px>", "width in pixels")
    .requiredOption("--height <px>", "height in pixels")
    .option("--x <px>", "x position in pixels (default: current position)")
    .option("--y <px>", "y position in pixels (default: current position)")
    .option("--json", "output JSON")
    .action(async (opts: ResizeOpts) => {
      const json = Boolean(opts.json);

      let width: number;
      let height: number;
      let x: number | undefined;
      let y: number | undefined;
      try {
        width = parsePositiveNumber(opts.width, "--width");
        height = parsePositiveNumber(opts.height, "--height");
        x = parseOptionalNumber(opts.x, "--x");
        y = parseOptionalNumber(opts.y, "--y");
      } catch (err) {
        process.exitCode = printError(json, err);
        return;
      }

      await withDaemon(json, async (client) => {
        if (x === undefined || y === undefined) {
          const { targets } = await client.listTargets({});
          const target = targets.find((t) => t.kind === "window" && t.id === opts.window);
          if (!target) {
            throw new DaemonError(
              "INVALID_ARGS",
              `Unknown window target "${opts.window}" — run \`windower targets\` first`,
            );
          }
          x ??= target.bounds.x;
          y ??= target.bounds.y;
        }

        const bounds: Rect = { x, y, width, height };
        const result = await client.resizeWindow({ targetId: opts.window, bounds });
        printResult(json, result, (data) => renderResizeResult(opts.window, data));
      });
    });
}

export function renderResizeResult(windowId: string, result: DaemonResizeWindowResult): string {
  const { x, y, width, height } = result.actualBounds;
  return `Resize window ${windowId}: ${result.result} — actual bounds ${x},${y} ${width}x${height}`;
}
