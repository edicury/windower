import { defineConfig } from "vitest/config";

/**
 * Config for the golden-path / crash-injection e2e suite (`pnpm test:e2e`).
 * Deliberately separate from `vitest.soak.config.ts` so a normal e2e run
 * never accidentally sits through the 30-minute soak test, and vice versa.
 *
 * Not discovered by any bare `vitest` invocation elsewhere in the repo:
 * every other package uses vitest's zero-config default (co-located
 * `*.test.ts`), so an explicit `--config` flag (see package.json's
 * `test:e2e` script) is required to pick this file up at all.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    // Real process spawn + real capture + polling loops are slower than
    // fake-sidecar unit tests; individual tests get a generous ceiling
    // rather than tuning per-test timeouts.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Real daemon instances bind a single well-known unix socket
    // (~/.windower/daemon.sock) and spawn real OS processes — running e2e
    // files in parallel would race on that socket and on demo-app window
    // enumeration. Force sequential execution.
    fileParallelism: false,
    pool: "forks",
  },
});
