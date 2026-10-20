// Pure helpers for the approval gate (FR-SB-04, FR-SEC-03): summary, disclosures, approval edit.
import {countWords} from '../template/src/schema.js';
import {PROVIDER_META} from './tts/providers.js';
import {TARGET_RANGE_S, checkTotal, computeTiming} from './timing.js';
import type {ValidationResult} from './validate-storyboard.js';

export interface ProviderInfo {
  id: string;
  voiced: boolean;
  implemented: boolean;
  egress: string;
}

/** Derived from the TTS registry (scripts/tts/providers.ts). `voiced` here means narration text leaves the machine. */
export const PROVIDERS: Record<string, ProviderInfo> = Object.fromEntries(
  Object.values(PROVIDER_META).map((m) => [
    m.id,
    {
      id: m.id,
      voiced: m.voiced && !m.egress.startsWith('nothing'),
      implemented: m.implemented,
      egress: m.egress,
    },
  ]),
);

const CREDIT_MODEL: Record<string, string> = {
  elevenlabs: 'ElevenLabs bills credits per character; the rate depends on your plan and model',
  openai: 'OpenAI bills per input token/character by model; the rate depends on your account',
};

/** Voiced narration runs about 15% longer than the reading-speed estimate (contract section 7). */
export const VOICED_GROWTH = 1.15;

export interface SceneRow {
  id: string;
  type: string;
  title: string;
  durationSec: number;
}

import type {ResolvedVoice} from './tts/voice.js';

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
  /** Why this provider was chosen: flag, no-voice, config, env or default. */
  providerSource: string;
  /** Voice and model with their origin; null when the provider is null (silent). */
  voice: ResolvedVoice | null;
  egress: string;
  /** Set when a voiced run would likely exceed the 120 s ceiling. */
  voicedLengthWarning?: string;
  costNote: string;
  /** Always states that nothing is sent before approval. */
  approvalNote: string;
  disclosures: {service: string; receives: string}[];
  mcpServers: string[];
  /** External sources whose data entered the brief (4.C.2). */
  externalSources: {server: string; status: 'used'}[];
  /** [url ...] citations from Context items, grouped by host. */
  externalUrls: {host: string; urls: string[]}[];
  /** MCP servers recorded as unavailable; skipped (4.B.2). */
  skippedServers: string[];
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

const SKIPPED = /\b(unavailable|not available|failed|failing|skipped|unreachable)\b/i;

function sectionBody(briefText: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}[^\\n]*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'im');
  return re.exec(briefText)?.[1] ?? '';
}

/** Servers recorded as unavailable under Excluded or Sources consulted; their data never entered the brief. */
export function skippedServersFromBrief(briefText: string | undefined): string[] {
  if (!briefText) return [];
  const found = new Set<string>();
  for (const sec of ['Excluded', 'Sources consulted']) {
    for (const line of sectionBody(briefText, sec).split('\n')) {
      if (!SKIPPED.test(line)) continue;
      const m = /\bmcp[:/ ]+([A-Za-z0-9_.-]+)/i.exec(line);
      const name = m?.[1]?.toLowerCase();
      if (name && !/^(server|servers|tool|tools)$/.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/** Distinct `[url ...]` citations from Context items, grouped by host. */
export function contextUrlsFromBrief(
  briefText: string | undefined,
): {host: string; urls: string[]}[] {
  if (!briefText) return [];
  const byHost = new Map<string, Set<string>>();
  for (const line of sectionBody(briefText, 'Context').split('\n')) {
    if (!/^\s*[-*]\s+C\d+\b/.test(line)) continue;
    for (const m of line.matchAll(/\[url\s+([^\]\s]+)[^\]]*\]/gi)) {
      const url = m[1] ?? '';
      let host = '(unparsed)';
      try {
        host = new URL(url).host || host;
      } catch {
        // keep placeholder host
      }
      byHost.set(host, (byHost.get(host) ?? new Set()).add(url));
    }
  }
  return [...byHost]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, u]) => ({host, urls: [...u].sort()}));
}

/** MCP servers named in brief.md: `mcp:<name>` tags and "Sources consulted" bullets marked used. */
export function mcpServersFromBrief(briefText: string | undefined): string[] {
  if (!briefText) return [];
  const skipped = new Set(skippedServersFromBrief(briefText));
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
      if (name && !/^(mcp|code|git|gh|github|github cli|repo|repository|files?)$/.test(name))
        found.add(name);
    }
  }
  return [...found].filter((n) => !skipped.has(n)).sort();
}

export function buildSummary(
  raw: unknown,
  validation: ValidationResult,
  opts: {
    briefText?: string;
    provider?: string;
    providerSource?: string;
    voice?: ResolvedVoice;
  } = {},
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
  const skippedServers = skippedServersFromBrief(opts.briefText);
  const externalUrls = contextUrlsFromBrief(opts.briefText);

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

  const local = !info?.voiced && providerId !== 'null' && info?.id === providerId;
  const costNote = info?.voiced
    ? `${narrationChars} characters billed by ${providerId}; ${CREDIT_MODEL[providerId] ?? 'rate depends on your plan and model'} (no price hardcoded)`
    : local
      ? `no cost, runs locally (${providerId}); ${narrationChars} characters synthesized`
      : `silent, 0 characters billed (provider: ${providerId})`;
  const egress = info?.egress ?? 'unknown provider; assume narration text is sent';
  const voiced = providerId !== 'null';
  const voicedLengthWarning =
    voiced && totalSec * VOICED_GROWTH > TARGET_RANGE_S[1]
      ? `voiced narration runs about 15% longer than the silent estimate: ${totalSec.toFixed(1)} s -> ~${(totalSec * VOICED_GROWTH).toFixed(1)} s, over the ${TARGET_RANGE_S[1]} s ceiling; consider trimming narration`
      : undefined;

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
    providerSource: opts.providerSource ?? (opts.provider ? 'flag' : 'default'),
    voice: providerId === 'null' ? null : (opts.voice ?? null),
    egress,
    ...(voicedLengthWarning ? {voicedLengthWarning} : {}),
    costNote,
    approvalNote: 'Nothing is sent to any service until you approve.',
    disclosures,
    mcpServers,
    externalSources: mcpServers.map((server) => ({server, status: 'used' as const})),
    externalUrls,
    skippedServers,
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
    `Voice: ${s.provider} (chosen by ${s.providerSource}); ${s.costNote}`,
    ...(s.voice
      ? [
          `Voice id: ${s.voice.voiceId} (${s.voice.voiceSource}); model: ${s.voice.modelId} (${s.voice.modelSource})`,
        ]
      : []),
    `Egress: ${s.egress}`,
    ...(s.voicedLengthWarning ? [`Length warning: ${s.voicedLengthWarning}`] : []),
    s.approvalNote,
    '',
    'Data disclosure:',
  );
  for (const d of s.disclosures) L.push(`  ${d.service}: ${d.receives}`);
  if (s.externalSources.length || s.externalUrls.length || s.skippedServers.length) {
    L.push('', 'External sources:');
    for (const e of s.externalSources) L.push(`  mcp:${e.server}: ${e.status}`);
    for (const g of s.externalUrls) L.push(`  ${g.host}: ${g.urls.join(', ')}`);
    for (const n of s.skippedServers) L.push(`  mcp:${n}: unavailable, skipped`);
  }
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
