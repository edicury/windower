#!/usr/bin/env node
// Test-only fixture: a tiny standalone process that speaks the same
// newline-delimited JSON-RPC 2.0 protocol a real native sidecar would
// (contracts/sidecar-protocol.md), used to exercise `SidecarProcess`
// against a REAL OS child process without depending on the Swift binary
// being built. Deliberately dependency-free (no TS, no zod, no imports
// from the package) so it can be spawned directly with `node`.
//
// Supported behavior, controlled by argv / env for test scenarios:
//   --exit-after-describe   exit(0) right after answering one `describe` call
//   --ignore-requests       accept connections but never respond (to exercise
//                            "process killed while a request is pending")
//   FAKE_SIDECAR_VERSION    overrides the version string in `describe`'s result

import { createInterface } from "node:readline";

const args = new Set(process.argv.slice(2));
const version = process.env.FAKE_SIDECAR_VERSION ?? "0.0.0-fixture";

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stderr.write("fake-sidecar-cli: started\n");

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (rawLine) => {
  const line = rawLine.trim();
  if (line.length === 0) return;

  if (args.has("--ignore-requests")) {
    process.stderr.write(`fake-sidecar-cli: ignoring request: ${line}\n`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method } = parsed;

  switch (method) {
    case "describe":
      write({
        jsonrpc: "2.0",
        id,
        result: {
          platform: "macos",
          version,
          capabilities: ["capture.display"],
        },
      });
      if (args.has("--exit-after-describe")) {
        process.stderr.write("fake-sidecar-cli: exiting after describe\n");
        process.exit(0);
      }
      break;
    default:
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: `Unknown method "${method}"`,
          data: { code: "UNSUPPORTED_CAPABILITY" },
        },
      });
  }
});

process.on("SIGTERM", () => {
  process.stderr.write("fake-sidecar-cli: received SIGTERM, exiting\n");
  process.exit(0);
});
