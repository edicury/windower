import type { ResolvedSecret } from "@windower/core";

/**
 * Redaction filter (contracts/operator.md §Secret refs, point 3).
 *
 * This module is the **last write barrier**: every transcript, every step
 * record, and every log line passes through a `Redactor` immediately before it
 * is written to disk or handed to a caller. Call sites never redact ad hoc —
 * they hand raw values to the barrier and the barrier decides.
 */

/** Used when a matched secret value can't be attributed to a known name. */
export const REDACTION_MARKER = "{{redacted}}";

/** Values shorter than this are too collision-prone to substring-match on. */
const MIN_REDACTABLE_LENGTH = 4;

/** Values at/above this length also get fuzzy (near-match) redaction. */
const MIN_FUZZY_LENGTH = 8;

/** Normalized edit-distance ratio above which a token counts as a near-match. */
const FUZZY_SIMILARITY_THRESHOLD = 0.8;

/** Token boundaries used when scanning for high-entropy near-matches. */
const TOKEN_SPLIT = /([^A-Za-z0-9_\-+/=.@:]+)/;

export interface Redactor {
  /** Redact a single string. */
  redactString(input: string): string;
  /** Deep-redact any JSON-ish value (objects, arrays, strings, keys included). */
  redact<T>(value: T): T;
  /** True when the value contains no trace of any known secret. */
  isClean(value: unknown): boolean;
}

interface CompiledSecret {
  name: string;
  value: string;
  placeholder: string;
  fuzzy: boolean;
}

function placeholderFor(name: string): string {
  return name.length > 0 ? `{{${name}}}` : REDACTION_MARKER;
}

/**
 * Shannon entropy per character. Used to decide whether a secret is
 * "high-entropy" enough that near-matches (a model paraphrasing/mangling it,
 * an OCR-ish transcription, a partially typed value) should also be caught.
 */
function entropyPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

function replaceAllCaseInsensitive(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  let out = "";
  let index = 0;
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  for (;;) {
    const at = lowerHaystack.indexOf(lowerNeedle, index);
    if (at === -1) {
      out += haystack.slice(index);
      return out;
    }
    out += haystack.slice(index, at) + replacement;
    index = at + needle.length;
  }
}

/**
 * Builds the write barrier for a set of resolved secrets. Longest values are
 * compiled first so that a secret which is a substring of another secret can't
 * shadow the longer one's placeholder.
 */
export function createRedactor(secrets: readonly ResolvedSecret[]): Redactor {
  const compiled: CompiledSecret[] = secrets
    .filter((s) => s.value.length >= MIN_REDACTABLE_LENGTH)
    .map((s) => ({
      name: s.name,
      value: s.value,
      placeholder: placeholderFor(s.name),
      fuzzy: s.value.length >= MIN_FUZZY_LENGTH && entropyPerChar(s.value) >= 2,
    }))
    .sort((a, b) => b.value.length - a.value.length);

  function redactString(input: string): string {
    if (compiled.length === 0) return input;
    let out = input;
    for (const secret of compiled) {
      out = replaceAllCaseInsensitive(out, secret.value, secret.placeholder);
    }
    const fuzzySecrets = compiled.filter((s) => s.fuzzy);
    if (fuzzySecrets.length === 0) return out;
    // Near-match pass: split into tokens and replace any token that is a
    // high-similarity variant of a high-entropy secret (mangled casing,
    // inserted/dropped characters, truncation).
    return out
      .split(TOKEN_SPLIT)
      .map((token) => {
        if (token.length < MIN_FUZZY_LENGTH) return token;
        for (const secret of fuzzySecrets) {
          if (
            similarity(token.toLowerCase(), secret.value.toLowerCase()) >=
            FUZZY_SIMILARITY_THRESHOLD
          ) {
            return secret.placeholder;
          }
        }
        return token;
      })
      .join("");
  }

  function redact<T>(value: T): T {
    return redactUnknown(value) as T;
  }

  function redactUnknown(value: unknown): unknown {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(redactUnknown);
    if (value instanceof Error) {
      const cloned = new Error(redactString(value.message));
      cloned.name = value.name;
      return cloned;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[redactString(key)] = redactUnknown(val);
      }
      return out;
    }
    return value;
  }

  function isClean(value: unknown): boolean {
    if (compiled.length === 0) return true;
    const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    const lower = serialized.toLowerCase();
    return !compiled.some((s) => lower.includes(s.value.toLowerCase()));
  }

  return { redactString, redact, isClean };
}

export type LogSink = (line: string) => void;

export interface RedactedLogger {
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The only logging entry point in this package. Every line is redacted before
 * it reaches the sink, so no call site can leak a secret by forgetting to.
 */
export function createRedactedLogger(redactor: Redactor, sink?: LogSink): RedactedLogger {
  const write: LogSink =
    sink ??
    (process.env.WINDOWER_OPERATOR_DEBUG
      ? (line) => {
          process.stderr.write(`${line}\n`);
        }
      : () => {});
  return {
    log(message, fields) {
      const suffix = fields === undefined ? "" : ` ${JSON.stringify(redactor.redact(fields))}`;
      write(redactor.redactString(`[operator] ${message}${suffix}`));
    },
  };
}
