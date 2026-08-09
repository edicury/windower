import type { CaptureTarget, ListTargetsResult } from "@windower/core";
import type { Command } from "commander";
import { withDaemon } from "../daemon.js";
import { printResult } from "../output.js";

/** `windower targets [--kind display|window|app] [--json]` — contracts/cli.md. */
export function registerTargetsCommand(program: Command): void {
  program
    .command("targets")
    .description("List current capture targets (displays, windows, apps)")
    .option("--kind <kind>", "filter by kind: display|window|app")
    .option("--json", "output JSON")
    .action(async (opts: { kind?: string; json?: boolean }) => {
      const json = Boolean(opts.json);
      await withDaemon(json, async (client) => {
        const kinds = opts.kind ? [opts.kind as "display" | "window" | "app"] : undefined;
        const result = await client.listTargets({ kinds });
        printResult(json, result, renderTargetsTable);
      });
    });
}

function targetNameOrTitle(target: CaptureTarget): string {
  switch (target.kind) {
    case "display":
      return target.name;
    case "window":
      return `${target.title} — ${target.appName}`;
    case "region":
      return `region on ${target.displayId}`;
  }
}

function targetId(target: CaptureTarget): string {
  return target.kind === "region" ? target.displayId : target.id;
}

function boundsLabel(target: CaptureTarget): string {
  const { x, y, width, height } = target.bounds;
  return `${x},${y} ${width}x${height}`;
}

export function renderTargetsTable(result: ListTargetsResult): string {
  if (result.targets.length === 0) return "No capture targets found.";

  const rows = result.targets.map((t) => [
    t.kind,
    targetId(t),
    targetNameOrTitle(t),
    boundsLabel(t),
  ]);
  const header = ["KIND", "ID", "NAME", "BOUNDS"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  return [formatRow(header), ...rows.map(formatRow)].join("\n");
}
