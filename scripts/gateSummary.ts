// Pure helpers for the approval gate (FR-SB-04, FR-SEC-03): summary, disclosures, approval edit.
import {countWords} from '../template/src/schema.js';
import {TARGET_RANGE_S, checkTotal, computeTiming} from './timing.js';
import type {ValidationResult} from './validate-storyboard.js';

export interface ProviderInfo {
  id: string;
  voiced: boolean;
  implemented: boolean;
  egress: string;
}

/** Mirrors contracts/tts-provider.md §1.1; the real registry (scripts/tts/providers.ts) lands in phase 5. */
export const PROVIDERS: Record<string, ProviderInfo> = {
  null: {id: 'null', voiced: false, implemented: true, egress: 'nothing leaves the machine'},
  piper: {id: 'piper', voiced: false, implemented: false, egress: 'nothing leaves the machine'},
  elevenlabs: {
    id: 'elevenlabs',
    voiced: true,
    implemented: false,
    egress: 'narration text is sent to ElevenLabs',
  },
  openai: {
    id: 'openai',
    voiced: true,
    implemented: false,
    egress: 'narration text is sent to OpenAI',
  },
};

export interface SceneRow {
  id: string;
  type: string;
  title: string;
  durationSec: number;
}

export interface GateSummary {
  title: string;
  slug: string;
  approved: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  scenes: SceneRow[];
  totalSec: number;
  target: {minSec: number; maxSec: number};
  lengthVerdict: string;
  sourceRefs: number;
  uniqueSources: number;
  narrationChars: number;
  narrationWords: number;
  provider: string;
  costNote: string;
  disclosures: {service: string; receives: string}[];
  mcpServers: string[];
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

function sceneTitle(s: Loose): string {
  for (const k of ['headline', 'heading', 'title']) {
    const v = s[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** MCP servers named in brief.md: `mcp:<name>` tags and "Sources consulted" bullets marked used. */
export function mcpServersFromBrief(briefText: string | undefined): string[] {
  if (!briefText) return [];
  const found = new Set<string>();
  for (const m of briefText.matchAll(/\bmcp[:/ ]+([A-Za-z0-9_.-]+)/gi)) {
    const name = m[1];
    if (name && !/^(server|servers|tool|tools)$/i.test(name)) found.add(name.toLowerCase());
  }
  const section = /^##\s+Sources consulted\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(briefText);
  if (section?.[1]) {
    for (const line of section[1].split('\n')) {
      const m = /^\s*[-*]\s*([A-Za-z][\w .-]*?)\s*[:(—-].*\bused\b/i.exec(line);
      const name = m?.[1]?.trim().toLowerCase();
      if (name && !/^(code|git|gh|github|github cli|repo|repository|files?)$/.test(name))
        found.add(name);
    }
  }
  return [...found].sort();
}

export function buildSummary(
  raw: unknown,
  validation: ValidationResult,
  opts: {briefText?: string; provider?: string} = {},
): GateSummary {
  const sb: Loose = isObj(raw) ? raw : {};
  const scenesRaw = Array.isArray(sb.scenes) ? sb.scenes.filter(isObj) : [];
  const narrations = scenesRaw.map((s) => (typeof s.narration === 'string' ? s.narration : ''));
  const narrationChars = narrations.reduce((n, t) => n + t.length, 0);
  const narrationWords = narrations.reduce((n, t) => n + countWords(t), 0);

  let rows: SceneRow[] = [];
  let totalSec = 0;
  let lengthVerdict = 'unknown';
  try {
    const timing = computeTiming(
      scenesRaw.map((s) => ({
        id: String(s.id ?? ''),
        narration: typeof s.narration === 'string' ? s.narration : '',
        minDurationSec: typeof s.minDurationSec === 'number' ? s.minDurationSec : undefined,
        transition: s.transition as 'fade' | 'slide' | 'none' | undefined,
      })),
    );
    rows = timing.scenes.map((t, i) => ({
      id: t.id,
      type: String(scenesRaw[i]?.type ?? '?'),
      title: sceneTitle(scenesRaw[i] ?? {}),
      durationSec: t.durationFrames / timing.fps,
    }));
    totalSec = timing.totalFrames / timing.fps;
    const v = checkTotal(timing);
    lengthVerdict = v.level === 'ok' ? 'within target' : (v.message ?? v.level);
  } catch {
    // Malformed scenes: the validation errors already explain it.
  }

  const refs = scenesRaw.flatMap((s) => (Array.isArray(s.sources) ? s.sources.filter(isObj) : []));
  const uniqueSources = new Set(refs.map((r) => `${String(r.kind)}:${String(r.ref)}`)).size;

  const info = PROVIDERS[opts.provider ?? 'null'];
  const providerId = info?.id ?? opts.provider ?? 'null';
  const mcpServers = mcpServersFromBrief(opts.briefText);

  const disclosures: GateSummary['disclosures'] = [];
  if (info?.voiced) {
    disclosures.push({
      service: providerId,
      receives: `narration text only (${narrationChars} characters); never code, file paths or brief content`,
    });
  } else {
    disclosures.push({
      service: `none (${providerId === 'null' ? 'silent' : providerId})`,
      receives: 'no data leaves the machine for narration',
    });
  }
  for (const s of mcpServers)
    disclosures.push({
      service: `MCP server "${s}"`,
      receives: 'already queried while gathering context for brief.md; no further data is sent',
    });

  const costNote = info?.voiced
    ? `${narrationChars} characters billed by ${providerId}; rate depends on your plan and model (no price hardcoded)`
    : `silent, 0 characters billed (provider: ${providerId})`;

  return {
    title: typeof sb.title === 'string' ? sb.title : '',
    slug: typeof sb.slug === 'string' ? sb.slug : '',
    approved: sb.approved === true,
    valid: validation.errors.length === 0,
    errors: validation.errors.map((i) => format(i)),
    warnings: validation.warnings.map((i) => format(i)),
    scenes: rows,
    totalSec,
    target: {minSec: TARGET_RANGE_S[0], maxSec: TARGET_RANGE_S[1]},
    lengthVerdict,
    sourceRefs: refs.length,
    uniqueSources,
    narrationChars,
    narrationWords,
    provider: providerId,
    costNote,
    disclosures,
    mcpServers,
  };
}

function format(i: ValidationResult['errors'][number]): string {
  return `${i.sceneId ? `scene ${i.sceneId}` : 'storyboard'} - ${i.path}: ${i.message} [${i.rule}]`;
}

export function renderSummary(s: GateSummary): string {
  const L: string[] = [];
  L.push(`Approval summary: ${s.title || '(untitled)'}${s.slug ? ` [${s.slug}]` : ''}`);
  L.push(
    `Status: ${s.approved ? 'APPROVED' : 'not approved'}; validation ${s.valid ? 'passed' : 'FAILED'}`,
  );
  L.push('', 'Scenes:');
  for (const r of s.scenes)
    L.push(
      `  ${r.id.padEnd(6)} ${r.type.padEnd(12)} ${r.durationSec.toFixed(1).padStart(5)} s  ${r.title}`,
    );
  L.push(
    '',
    `Length: ${s.totalSec.toFixed(1)} s estimated (target ${s.target.minSec}-${s.target.maxSec} s): ${s.lengthVerdict}`,
    `Sources: ${s.sourceRefs} citations across scenes (${s.uniqueSources} unique)`,
    `Narration: ${s.narrationWords} words, ${s.narrationChars} characters`,
    `Voice: ${s.costNote}`,
    '',
    'Data disclosure:',
  );
  for (const d of s.disclosures) L.push(`  ${d.service}: ${d.receives}`);
  if (s.errors.length) L.push('', 'Errors:', ...s.errors.map((e) => `  ${e}`));
  if (s.warnings.length) L.push('', 'Warnings:', ...s.warnings.map((w) => `  ${w}`));
  return L.join('\n');
}

/**
 * Returns storyboard JSON text with `approved: true` and `approvedAt` set. Key order, other fields,
 * indentation and trailing newline are preserved; a missing `approved` is inserted before `scenes`.
 */
export function applyApproval(text: string, nowIso: string): string {
  const obj = JSON.parse(text) as Loose;
  const indent = /^\{\s*\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const out: Loose = {};
  let placed = false;
  const put = () => {
    out.approved = true;
    out.approvedAt = nowIso;
    placed = true;
  };
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'approvedAt') continue;
    if (k === 'approved') put();
    else {
      if (k === 'scenes' && !placed) put();
      out[k] = v;
    }
  }
  if (!placed) put();
  const compact = !text.includes('\n');
  return (
    JSON.stringify(out, null, compact ? undefined : indent) + (text.endsWith('\n') ? '\n' : '')
  );
}
