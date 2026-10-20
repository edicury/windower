// Retry/backoff and HTTP error mapping (contract §6). Messages never contain secrets.
import {TtsError} from './types.js';

export const DEFAULT_DELAYS_MS = [1000, 3000, 9000];

export interface RetryOptions {
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries only retryable TtsError; waits max(backoff, retryAfterMs). Throws the last error on exhaustion. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const delay = delays[attempt];
      if (!(e instanceof TtsError) || !e.retryable || delay === undefined) throw e;
      await sleep(e.retryAfterMs !== undefined ? Math.max(e.retryAfterMs, 0) : delay);
    }
  }
}

/** Removes the key value (and anything shaped like an API key) from text. */
export function redactKey(text: string, key?: string): string {
  let out = text;
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/\bsk[-_][A-Za-z0-9_-]{16,}/g, '[redacted]');
}

/** Retry-After: delta-seconds or HTTP date -> ms. */
export function parseRetryAfter(
  h: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!h) return undefined;
  const s = h.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.max(t - now, 0);
}

function providerMessage(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const d = j.detail ?? j.error ?? j.message;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const m = (d as Record<string, unknown>).message;
      if (typeof m === 'string') return m;
    }
  } catch {
    // not JSON
  }
  return body;
}

export function mapHttpError(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
  apiKey?: string,
): TtsError {
  const detail = redactKey(providerMessage(bodyText), apiKey)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403)
    return new TtsError(`API key invalid or not permitted (HTTP ${status})${suffix}`, {
      code: 'auth',
      status,
      retryable: false,
    });
  if (status === 429) {
    const ra = parseRetryAfter(retryAfterHeader);
    return new TtsError(`rate limited (HTTP 429)${suffix}`, {
      code: 'rate-limit',
      status,
      retryable: true,
      ...(ra !== undefined ? {retryAfterMs: ra} : {}),
    });
  }
  if (status >= 500) {
    const ra = parseRetryAfter(retryAfterHeader);
    return new TtsError(`provider server error (HTTP ${status})${suffix}`, {
      code: 'server',
      status,
      retryable: true,
      ...(ra !== undefined ? {retryAfterMs: ra} : {}),
    });
  }
  return new TtsError(`request rejected (HTTP ${status})${suffix}`, {
    code: 'bad-request',
    status,
    retryable: false,
  });
}
