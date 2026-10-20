// brief: `brief <brief.md> [--json]` lints brief provenance (FR-SRC-02): every fact carries a
// `[file ...]`, `[url ...]` or `[git ...]` citation, ids are unique, Context items cite a URL.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';

export const BRIEF_USAGE = 'Usage: brief <brief.md> [--json]';

export interface BriefFinding {
  rule: 'missing-citation' | 'duplicate-id' | 'context-no-url' | 'no-sources-section';
  id?: string;
  line?: number;
  message: string;
}

const CITATION = /\[(file|url|git)\s+[^\]]+\]/i;
const URL_CITATION = /\[url\s+[^\]]+\]/i;
const ITEM = /^\s*[-*]\s+([FC]\d+)\b/;

/** Pure lint of a brief's text; returns findings (empty when clean). */
export function lintBrief(text: string): BriefFinding[] {
  const findings: BriefFinding[] = [];
  const seen = new Map<string, number>();
  let section = '';
  let hasSources = false;
  text.split('\n').forEach((line, i) => {
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) {
      section = (h[1] ?? '').toLowerCase();
      if (section.startsWith('sources consulted')) hasSources = true;
      return;
    }
    const inFacts = section.startsWith('facts');
    const inContext = section.startsWith('context');
    if (!inFacts && !inContext) return;
    const m = ITEM.exec(line);
    const id = m?.[1];
    if (!id) return;
    const expected = inFacts ? 'F' : 'C';
    if (!id.startsWith(expected)) return;
    const n = i + 1;
    const prev = seen.get(id);
    if (prev !== undefined)
      findings.push({
        rule: 'duplicate-id',
        id,
        line: n,
        message: `${id} is already used on line ${prev}`,
      });
    else seen.set(id, n);
    if (!CITATION.test(line))
      findings.push({
        rule: 'missing-citation',
        id,
        line: n,
        message: `${id} has no [file ...], [url ...] or [git ...] citation`,
      });
    else if (inContext && !URL_CITATION.test(line))
      findings.push({
        rule: 'context-no-url',
        id,
        line: n,
        message: `${id} is context from tickets/docs but cites no [url ...]`,
      });
  });
  if (!hasSources)
    findings.push({
      rule: 'no-sources-section',
      message: 'brief has no "## Sources consulted" section',
    });
  return findings;
}

function main(): void {
  const {values, positionals} = parseArgs({
    options: {json: {type: 'boolean'}},
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    console.error(BRIEF_USAGE);
    process.exit(EXIT.validation);
  }
  let text: string;
  try {
    text = readFileSync(path.resolve(target), 'utf8');
  } catch {
    console.error(`brief not found: ${target}`);
    process.exit(EXIT.validation);
  }
  const findings = lintBrief(text);
  if (values.json) console.log(JSON.stringify({ok: findings.length === 0, findings}, null, 2));
  else if (findings.length === 0) console.error('brief provenance ok');
  else
    for (const f of findings)
      console.error(`${f.line ? `line ${f.line}: ` : ''}${f.message} [${f.rule}]`);
  process.exit(findings.length === 0 ? EXIT.ok : EXIT.validation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
