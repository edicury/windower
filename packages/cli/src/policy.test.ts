import { type CommandId, POLICY_TABLE, resolveBackendMode } from "@windower/core";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";

/**
 * Walks a fully-registered Commander `program` (`buildProgram()`, shared
 * with `index.ts` so this test can never drift from what the real binary
 * registers) and collects the CLI-facing id (`contracts/cli.md`'s Daemon
 * policy table key, e.g. `"daemon restart"`) for every command node that
 * has its own registered action handler — i.e. every command a user can
 * actually invoke, not just container nodes like `daemon`/`config`/
 * `permission` that only exist to hold subcommands.
 *
 * `Command._actionHandler` is Commander's own (underscore-prefixed but not
 * privately enforced) marker for "this node has an `.action()` callback" —
 * there's no public API for it in commander@12.
 */
function collectLeafCommandIds(command: Command, prefix: string[] = []): string[] {
  const ids: string[] = [];
  for (const child of command.commands) {
    const path = [...prefix, child.name()];
    const hasAction = (child as unknown as { _actionHandler: unknown })._actionHandler !== null;
    if (hasAction) ids.push(path.join(" "));
    ids.push(...collectLeafCommandIds(child, path));
  }
  return ids;
}

describe("backend policy completeness", () => {
  it("every registered commander command has a POLICY_TABLE entry (or is resolvable via resolveBackendMode)", () => {
    const program = buildProgram();
    const ids = collectLeafCommandIds(program);

    // Sanity check the walk itself found the commands we expect — guards
    // against this test silently passing with zero commands if
    // `buildProgram()`'s registration list ever gets gutted by accident.
    expect(ids).toEqual(expect.arrayContaining(["record", "start", "stop", "cancel", "targets"]));
    expect(ids.length).toBeGreaterThanOrEqual(15);

    const missing = ids.filter((id) => {
      if (id in POLICY_TABLE) return false;
      try {
        // `CommandId` is a closed string-literal union and `id` is only
        // known to be a `string` here — that's the whole point of this
        // test, to catch a real Commander id that ISN'T one of those
        // literals, so the cast is deliberately loose rather than `any`.
        resolveBackendMode(id as CommandId);
        return false;
      } catch {
        return true;
      }
    });

    expect(missing).toEqual([]);
  });

  it("has no POLICY_TABLE entry that doesn't correspond to a real registered command (catches typos/stale entries)", () => {
    const program = buildProgram();
    const ids = new Set(collectLeafCommandIds(program));
    const staleEntries = Object.keys(POLICY_TABLE).filter((id) => !ids.has(id));
    expect(staleEntries).toEqual([]);
  });
});
