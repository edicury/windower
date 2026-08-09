function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check()` until it returns a truthy value or `timeoutMs` elapses, then throws `timeoutMessage`. */
export async function pollUntil<T>(
  check: () => Promise<T | undefined | false>,
  options: { timeoutMs: number; intervalMs?: number; timeoutMessage: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 250;
  let lastResult: T | undefined | false;
  while (Date.now() < deadline) {
    lastResult = await check();
    if (lastResult) return lastResult;
    await sleep(intervalMs);
  }
  throw new Error(options.timeoutMessage);
}
