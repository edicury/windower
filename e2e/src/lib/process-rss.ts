import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resident set size, in kilobytes, for a live PID (via `ps -o rss=`). Returns `undefined` if the process is gone. */
export async function sampleRssKb(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    return Number(trimmed);
  } catch {
    // `ps` exits non-zero when the pid no longer exists.
    return undefined;
  }
}

export interface RssSample {
  atMs: number;
  rssKb: number;
}

/**
 * Samples a process's RSS on an interval until `stop()` is called. Used by
 * the soak test to build a memory-over-time series for the
 * plateaus-rather-than-grows-linearly assertion.
 */
export function startRssSampler(
  pid: number,
  intervalMs: number,
): { samples: RssSample[]; stop: () => void } {
  const samples: RssSample[] = [];
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void sampleRssKb(pid).then((rssKb) => {
      if (rssKb !== undefined) samples.push({ atMs: Date.now() - startedAt, rssKb });
    });
  }, intervalMs);
  return {
    samples,
    stop: () => clearInterval(timer),
  };
}

/**
 * Crude linear-growth check: compares the mean RSS of the first and last
 * `fraction` of samples. A plateauing/bounded process should show the tail
 * mean within `maxGrowthRatio` of the head mean; unbounded growth blows
 * past it.
 */
export function assertNoUnboundedGrowth(
  samples: RssSample[],
  options: { fraction?: number; maxGrowthRatio?: number } = {},
): { headMeanKb: number; tailMeanKb: number; growthRatio: number } {
  const fraction = options.fraction ?? 0.2;
  const maxGrowthRatio = options.maxGrowthRatio ?? 1.5;
  if (samples.length < 10) {
    throw new Error(`Not enough RSS samples (${samples.length}) to evaluate growth`);
  }
  const chunkSize = Math.max(1, Math.floor(samples.length * fraction));
  const head = samples.slice(0, chunkSize);
  const tail = samples.slice(-chunkSize);
  const mean = (xs: RssSample[]): number => xs.reduce((sum, s) => sum + s.rssKb, 0) / xs.length;
  const headMeanKb = mean(head);
  const tailMeanKb = mean(tail);
  const growthRatio = tailMeanKb / headMeanKb;
  if (growthRatio > maxGrowthRatio) {
    throw new Error(
      `RSS grew ${growthRatio.toFixed(2)}x over the run (head mean ${headMeanKb.toFixed(0)}KB, ` +
        `tail mean ${tailMeanKb.toFixed(0)}KB) — exceeds ${maxGrowthRatio}x threshold, looks unbounded.`,
    );
  }
  return { headMeanKb, tailMeanKb, growthRatio };
}
