/**
 * Executable entry point for the operator decision-loop child process
 * (contracts/operator-loop-protocol.md). The daemon computes this module's path
 * from its own resolved module location and spawns it directly — both ends
 * always ship from the same installed package version, which is why the
 * protocol asserts its version rather than negotiating capabilities.
 *
 * No run configuration arrives on `argv`: secret **names**, model config, and
 * the task text are all the result of the `ready` handshake, because anything
 * on `argv` is visible in `ps` output.
 *
 * This file is the root of the import closure that `loop-entry.deps.test.ts`
 * walks. Adding anything here that can reach `SidecarClient`, `sidecar-process`,
 * or `node:child_process` fails that test — which is the enforcement mechanism
 * for the rule this whole process split exists to guarantee.
 */
import { runLoopChild } from "./loop/child.js";

runLoopChild({ input: process.stdin, output: process.stdout }).then(
  (result) => {
    process.exitCode = result.exitCode;
  },
  (err: unknown) => {
    // stderr is free-form human-readable logs only, never protocol data. The
    // daemon runs its redaction filter over it before persisting anything.
    process.stderr.write(
      `[operator-loop] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
