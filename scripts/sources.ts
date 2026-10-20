// sources: `sources <url-or-id> [--json]` classifies a source reference (FR-SRC-04). Pure string
// parsing: nothing is fetched. Tells the skill which connected MCP server to look for and which
// citation string to use verbatim as storyboard `sources[].ref`.
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';

export const SOURCES_USAGE = 'Usage: sources <url-or-id> [--json]';

export type SourceKind =
  | 'github-pr'
  | 'github-issue'
  | 'github-repo-file'
  | 'notion'
  | 'linear'
  | 'slack'
  | 'jira'
  | 'sentry'
  | 'generic-url'
  | 'pr-number'
  | 'linear-id'
  | 'notion-id'
  | 'unknown';

export interface SourceClass {
  kind: SourceKind;
  host?: string;
  /** Parsed stable id (e.g. `owner/repo#123`, `ABC-123`, the Notion page id). */
  id: string;
  /** Use verbatim as `sources[].ref` (kind `url`, or `git` for `pr#123`). */
  citation: string;
  /** Lowercase MCP server name to look for among connected servers ('' when unknown). */
  mcpHint: string;
}

const NOTION_ID = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const LINEAR_ID = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

const normNotion = (s: string): string => s.replace(/-/g, '').toLowerCase();

function hostHint(host: string): string {
  if (host.endsWith('atlassian.net') || host.endsWith('atlassian.com')) return 'atlassian';
  if (host.endsWith('sentry.io')) return 'sentry';
  if (host === 'drive.google.com' || host === 'docs.google.com') return 'google-drive';
  if (host.endsWith('figma.com')) return 'figma';
  if (host.endsWith('datadoghq.com') || host.endsWith('datadoghq.eu')) return 'datadog';
  if (host.endsWith('github.com')) return 'github';
  const labels = host.split('.');
  return labels.length >= 2 ? labels[labels.length - 2]! : host;
}

function classifyUrl(u: URL): SourceClass {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const clean = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  const make = (kind: SourceKind, id: string, mcpHint: string): SourceClass => ({
    kind,
    host,
    id,
    citation: clean,
    mcpHint,
  });

  if (host === 'github.com') {
    const [owner, repo, type, a, ...rest] = segs;
    if (owner && repo) {
      if ((type === 'pull' || type === 'issues') && a && /^\d+$/.test(a))
        return make(
          type === 'pull' ? 'github-pr' : 'github-issue',
          `${owner}/${repo}#${a}`,
          'github',
        );
      if ((type === 'blob' || type === 'tree') && a && rest.length > 0)
        return make('github-repo-file', `${owner}/${repo}:${rest.join('/')}@${a}`, 'github');
      return make('generic-url', `${owner}/${repo}`, 'github');
    }
  }

  if (host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site')) {
    const last = segs[segs.length - 1] ?? '';
    const m = NOTION_ID.exec(last) ?? NOTION_ID.exec(u.searchParams.get('p') ?? '');
    if (m) return make('notion', normNotion(m[1]!), 'notion');
    return make('generic-url', last || host, 'notion');
  }

  if (host === 'linear.app') {
    const i = segs.indexOf('issue');
    const m = i >= 0 ? LINEAR_ID.exec(segs[i + 1] ?? '') : null;
    if (m) return make('linear', `${m[1]!.toUpperCase()}-${m[2]}`, 'linear');
    return make('generic-url', segs.join('/') || host, 'linear');
  }

  if (host === 'slack.com' || host.endsWith('.slack.com')) {
    const i = segs.indexOf('archives');
    if (i >= 0 && segs[i + 1]) {
      const id = [segs[i + 1], segs[i + 2]].filter(Boolean).join('/');
      return make('slack', id, 'slack');
    }
    return make('generic-url', segs.join('/') || host, 'slack');
  }

  if (host.endsWith('.atlassian.net') || segs[0] === 'browse') {
    const i = segs.indexOf('browse');
    const m = i >= 0 ? LINEAR_ID.exec(segs[i + 1] ?? '') : null;
    const key = u.searchParams.get('selectedIssue');
    const k = m ?? (key ? LINEAR_ID.exec(key) : null);
    if (k) return make('jira', `${k[1]!.toUpperCase()}-${k[2]}`, 'atlassian');
  }

  if (host === 'sentry.io' || host.endsWith('.sentry.io')) {
    const i = segs.indexOf('issues');
    if (i >= 0 && segs[i + 1] && /^\d+$/.test(segs[i + 1]!)) {
      const sub = host.endsWith('.sentry.io')
        ? host.split('.')[0]!
        : segs[0] === 'organizations'
          ? segs[1]
          : undefined;
      return make('sentry', `${sub ? `${sub}/` : ''}${segs[i + 1]}`, 'sentry');
    }
  }

  return make('generic-url', `${host}${u.pathname.replace(/\/+$/, '')}`, hostHint(host));
}

/** Classifies a URL or bare id. Pure: never fetches. `kind: 'unknown'` means unparseable. */
export function classifySource(input: string): SourceClass {
  const s = input.trim();
  const unknown: SourceClass = {kind: 'unknown', id: '', citation: '', mcpHint: ''};
  if (!s) return unknown;

  const pr = /^#?(\d+)$/.exec(s);
  if (pr) return {kind: 'pr-number', id: `#${pr[1]}`, citation: `pr#${pr[1]}`, mcpHint: 'github'};

  const gh = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  if (gh) return classifyUrl(new URL(`https://github.com/${gh[1]}/${gh[2]}/pull/${gh[3]}`));

  const lin = LINEAR_ID.exec(s);
  if (lin) {
    const id = `${lin[1]!.toUpperCase()}-${lin[2]}`;
    return {kind: 'linear-id', id, citation: id, mcpHint: 'linear'};
  }

  if (NOTION_ID.test(s) && /^[0-9a-f-]+$/i.test(s)) {
    const id = normNotion(s);
    return {kind: 'notion-id', id, citation: id, mcpHint: 'notion'};
  }

  if (/^https?:\/\//i.test(s)) {
    try {
      return classifyUrl(new URL(s));
    } catch {
      return unknown;
    }
  }
  return unknown;
}

export function formatSource(c: SourceClass): string {
  const lines = [`Kind: ${c.kind}${c.host ? ` (${c.host})` : ''}`, `Id: ${c.id}`];
  lines.push(`Citation: ${c.citation}`, `MCP hint: ${c.mcpHint || '(none)'}`);
  return lines.join('\n');
}

function main(): void {
  const {values, positionals} = parseArgs({
    options: {json: {type: 'boolean'}},
    allowPositionals: true,
  });
  const input = positionals[0];
  if (!input) {
    console.error(SOURCES_USAGE);
    process.exit(EXIT.error);
  }
  const c = classifySource(input);
  if (c.kind === 'unknown') {
    console.error(`cannot classify source: ${input}`);
    if (values.json) console.log(JSON.stringify(c, null, 2));
    process.exit(EXIT.validation);
  }
  if (values.json) console.log(JSON.stringify(c, null, 2));
  else console.error(formatSource(c));
  process.exit(EXIT.ok);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
