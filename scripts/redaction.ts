// redaction: pure scanner for secrets and PII (FR-SEC-01/02, storyboard rule R6, sources.md section 6).
// No I/O here. Findings carry a MASKED preview only; the matched value is never returned as text.
import path from 'node:path';

export const REDACTED = '‹redacted›';

export type RuleId =
  | 'aws-key'
  | 'sk-key'
  | 'xi-api-key'
  | 'github-token'
  | 'private-key'
  | 'jwt'
  | 'secret-assign'
  | 'email'
  | 'phone';

interface Rule {
  id: RuleId;
  label: string;
  pii?: boolean;
  re: RegExp;
  /** Capture group holding the sensitive span; defaults to the whole match. */
  group?: number;
  /** Extra test on the sensitive span to cut false positives. */
  accept?: (span: string, match: RegExpExecArray) => boolean;
}

const PLACEHOLDER =
  /^(?:\$\{|\{\{|<|%|process\.env|os\.environ|env\.|your[-_ ]|example|changeme|placeholder|dummy|xxx|\*{3}|\.{3}|‹)/i;

const NAME_WORDS = '[A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key)[A-Za-z0-9_]*';

// Patterns are assembled from fragments so this file never contains a scannable literal itself.
const RULES: Rule[] = [
  {id: 'aws-key', label: 'AWS access key id', re: new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b', 'g')},
  {id: 'sk-key', label: 'sk- API key', re: new RegExp('\\bsk' + '-[A-Za-z0-9_-]{20,}', 'g')},
  {
    id: 'xi-api-key',
    label: 'xi-api-key value',
    re: new RegExp('xi-api-key["\']?\\s*[:=]\\s*["\']?([A-Za-z0-9_-]{16,})', 'gi'),
    group: 1,
    accept: (s) => !PLACEHOLDER.test(s),
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    re: new RegExp('\\bgh[pousr]' + '_[A-Za-z0-9]{36,}', 'g'),
  },
  {
    id: 'private-key',
    label: 'private key block',
    re: new RegExp(
      '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----)?',
      'g',
    ),
  },
  {
    id: 'jwt',
    label: 'JWT-like token',
    re: new RegExp('\\bey' + 'J[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', 'g'),
  },
  {
    id: 'secret-assign',
    label: 'literal secret assignment',
    re: new RegExp(
      '(' +
        NAME_WORDS +
        ')(["\']?)\\s*(?::|=|=>)\\s*(?:"([^"\\n]{6,})"|\'([^\'\\n]{6,})\'|`([^`\\n]{6,})`)',
      'gi',
    ),
    // The sensitive span is the quoted value; see spanOf().
    accept: (_s, m) => {
      const v = m[3] ?? m[4] ?? m[5] ?? '';
      return !PLACEHOLDER.test(v) && !/\$\{/.test(v) && /[A-Za-z0-9]/.test(v) && !/\s{2,}/.test(v);
    },
  },
  {
    id: 'email',
    label: 'email address',
    pii: true,
    re: /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
    accept: (s) => !/@(?:[\w-]+\.)*example\.(?:com|org|net)$/i.test(s) && !/^noreply@/i.test(s),
  },
  {
    id: 'phone',
    label: 'phone number',
    pii: true,
    re: /(?<![\w.+-])(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)|\d{1,4})(?:[\s.-]?\d{2,4}){2,4}|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{3}[-.]\d{3}[-.]\d{4})(?![\w-])/g,
  },
];

export const RULE_IDS: RuleId[] = RULES.map((r) => r.id);
export const labelOf = (id: RuleId): string => RULES.find((r) => r.id === id)?.label ?? id;

export interface Finding {
  rule: RuleId;
  label: string;
  /** 1-based line and column of the sensitive span. */
  line: number;
  col: number;
  /** Absolute offsets [start, end) of the sensitive span in the scanned text. */
  start: number;
  end: number;
  /** The source line with every finding on it masked and shortened; safe to print. */
  preview: string;
}

export interface ScanOptions {
  /** Do not report emails and phone numbers. */
  allowPii?: boolean;
}

/** Masks a span: keeps a short non-secret lead for key-shaped values, never more than 4 chars. */
export function maskSpan(rule: RuleId, span: string): string {
  const n = span.length;
  if (rule === 'aws-key') return 'AKIA' + '*'.repeat(Math.max(4, n - 4));
  if (rule === 'private-key') return '-----BEGIN … PRIVATE KEY-----' + ' ‹block›';
  if (rule === 'email') return '***@' + span.slice(span.indexOf('@') + 1);
  if (rule === 'phone') return '***-' + span.slice(-2);
  return `***(${n} chars)`;
}

function spanOf(rule: Rule, m: RegExpExecArray): {start: number; end: number} {
  if (rule.id === 'secret-assign') {
    const v = m[3] ?? m[4] ?? m[5] ?? '';
    const whole = m[0];
    const at = whole.lastIndexOf(v);
    return {start: m.index + at, end: m.index + at + v.length};
  }
  if (rule.group) {
    const g = m[rule.group] ?? '';
    const at = m[0].lastIndexOf(g);
    return {start: m.index + at, end: m.index + at + g.length};
  }
  return {start: m.index, end: m.index + m[0].length};
}

interface Raw {
  rule: Rule;
  start: number;
  end: number;
}

function collect(text: string, opts: ScanOptions): Raw[] {
  const raws: Raw[] = [];
  for (const rule of RULES) {
    if (rule.pii && opts.allowPii) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (m[0] === '') {
        rule.re.lastIndex++;
        continue;
      }
      const span = spanOf(rule, m);
      if (rule.accept && !rule.accept(text.slice(span.start, span.end), m)) continue;
      raws.push({rule, start: span.start, end: span.end});
    }
  }
  // Overlaps (an xi-api-key value is also a secret assignment): earliest start wins, then the longer span.
  raws.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: Raw[] = [];
  for (const r of raws) if (!kept.length || r.start >= kept[kept.length - 1]!.end) kept.push(r);
  return kept;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineIndex(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const PREVIEW_MAX = 100;

export function scanText(text: string, opts: ScanOptions = {}): Finding[] {
  const raws = collect(text, opts);
  if (!raws.length) return [];
  const starts = lineStarts(text);
  const lineEnd = (i: number) => (i + 1 < starts.length ? starts[i + 1]! - 1 : text.length);
  return raws.map((r) => {
    const li = lineIndex(starts, r.start);
    const ls = starts[li]!;
    const le = lineEnd(li);
    // Build the masked line from every finding that touches this line.
    let out = '';
    let pos = ls;
    for (const o of raws) {
      if (o.end <= ls || o.start >= le) continue;
      const s = Math.max(o.start, ls);
      const e = Math.min(o.end, le);
      out += text.slice(pos, s) + maskSpan(o.rule.id, text.slice(o.start, o.end));
      pos = e;
    }
    out += text.slice(pos, le);
    let preview = out.trim();
    if (preview.length > PREVIEW_MAX) preview = preview.slice(0, PREVIEW_MAX - 1) + '…';
    return {
      rule: r.rule.id,
      label: r.rule.label,
      line: li + 1,
      col: r.start - ls + 1,
      start: r.start,
      end: r.end,
      preview,
    };
  });
}

/** Replaces every finding with the redaction marker. */
export function redactText(
  text: string,
  opts: ScanOptions = {},
): {text: string; findings: Finding[]} {
  const findings = scanText(text, opts);
  let out = '';
  let pos = 0;
  for (const f of findings) {
    out += text.slice(pos, f.start) + REDACTED;
    pos = f.end;
  }
  return {text: out + text.slice(pos), findings};
}

/** Counts findings per rule label (kinds and counts, never values) for brief.md "Excluded / redacted". */
export function summarize(findings: Pick<Finding, 'rule' | 'label'>[]): string[] {
  const counts = new Map<RuleId, {label: string; n: number}>();
  for (const f of findings) {
    const c = counts.get(f.rule) ?? {label: f.label, n: 0};
    c.n++;
    counts.set(f.rule, c);
  }
  return [...counts.entries()].map(([, c]) => `${c.n} x ${c.label} replaced with ${REDACTED}`);
}

/** Files that must never be read into a brief or quoted in a code scene (FR-SEC-02). */
export function isSecretFile(file: string): boolean {
  const b = path.basename(file);
  return (
    /^\.env(\..*)?$/i.test(b) ||
    /\.(pem|key|p12|pfx|jks|keystore)$/i.test(b) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(b)
  );
}

export const isEnvFile = (file: string): boolean => /^\.env/i.test(path.basename(file));
