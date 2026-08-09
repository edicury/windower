import { defineConfig } from "vitest/config";

/** Config for the 30-minute soak test (`pnpm test:soak`). See vitest.e2e.config.ts for why this is a separate file. */
export default defineConfig({
  test: {
    include: ["soak/**/*.soak.test.ts"],
    // 30 minutes of recording plus setup/teardown/ffprobe margin.
    testTimeout: 40 * 60 * 1000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
