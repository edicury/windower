// Helpers for the `code` scene payload, shared by the schema, the validator and prepare.
// No imports: this file must stay dependency-free so every layer can use it.

export type DiffKind = 'add' | 'del' | 'ctx';
export type DiffRow = {kind: DiffKind; text: string};

/** Splits a snippet into lines: CRLF normalised, one trailing newline ignored. */
export function splitCode(code: string): string[] {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Diff snippets prefix every line with `+`, `-` or one space (context). */
export function parseDiff(lines: string[]): {rows: DiffRow[]; badLine?: number; hunks: number} {
  const rows: DiffRow[] = [];
  let hunks = 0;
  let inHunk = false;
  let badLine: number | undefined;
  lines.forEach((l, i) => {
    const c = l.charAt(0);
    const kind: DiffKind | undefined = c === '+' ? 'add' : c === '-' ? 'del' : c === ' ' ? 'ctx' : undefined;
    if (!kind) {
      badLine ??= i + 1;
      rows.push({kind: 'ctx', text: l});
      inHunk = false;
      return;
    }
    rows.push({kind, text: l.slice(1)});
    if (kind === 'ctx') inHunk = false;
    else {
      if (!inHunk) hunks += 1;
      inHunk = true;
    }
  });
  return {rows, badLine, hunks};
}

/** Text of each displayed row (diff prefixes removed). */
export function displayLines(code: string, mode: 'plain' | 'diff'): string[] {
  const lines = splitCode(code);
  return mode === 'diff' ? parseDiff(lines).rows.map((r) => r.text) : lines;
}

/** Problems with a code payload's text, independent of any file. Each is `{field, message}`. */
export function codeTextProblems(
  s: {code: string; startLine: number; mode?: 'plain' | 'diff'; focus?: {lines: [number, number]}[]},
  limits: {lines: number; chars: number},
): {path: (string | number)[]; message: string}[] {
  const out: {path: (string | number)[]; message: string}[] = [];
  const mode = s.mode ?? 'plain';
  const raw = splitCode(s.code);
  if (raw.length > limits.lines) out.push({path: ['code'], message: `lines > ${limits.lines}: ${raw.length} lines`});
  let shown = raw;
  if (mode === 'diff') {
    const d = parseDiff(raw);
    shown = d.rows.map((r) => r.text);
    if (d.badLine !== undefined)
      out.push({path: ['code'], message: `diff line ${d.badLine} must start with "+", "-" or a space`});
    else if (d.hunks !== 1)
      out.push({path: ['code'], message: `diff mode needs exactly 1 hunk, found ${d.hunks}`});
  }
  shown.forEach((l, i) => {
    if (l.length > limits.chars)
      out.push({path: ['code'], message: `line length > ${limits.chars}: line ${i + 1} has ${l.length} chars`});
  });
  const end = s.startLine + raw.length - 1;
  (s.focus ?? []).forEach((f, k) => {
    const [a, b] = f.lines;
    if (a > b || a < s.startLine || b > end)
      out.push({
        path: ['focus', k, 'lines'],
        message: `focus range ${a}-${b} is outside the snippet ${s.startLine}-${end}`,
      });
  });
  return out;
}
