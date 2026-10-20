// Shiki highlighting for `code` scenes: turns the scene's own `code` text into per-row tokens.
import {bundledLanguages, codeToTokens, type BundledLanguage} from 'shiki';
import {parseDiff, splitCode} from '../template/src/codeLines.js';
import type {CodeLine} from '../template/src/types.js';

const PLAIN = new Set(['text', 'plaintext', 'txt', 'plain']);

/** True when Shiki can highlight `lang` (or it is a plain-text alias). */
export const isKnownLanguage = (lang: string): boolean =>
  PLAIN.has(lang) || lang in bundledLanguages;

export async function highlightCode(scene: {
  code: string;
  language: string;
  startLine: number;
  mode?: 'plain' | 'diff';
}): Promise<CodeLine[]> {
  const raw = splitCode(scene.code);
  const rows =
    scene.mode === 'diff' ? parseDiff(raw).rows : raw.map((text) => ({kind: undefined, text}));
  const {tokens} = await codeToTokens(rows.map((r) => r.text).join('\n'), {
    lang: (PLAIN.has(scene.language) ? 'text' : scene.language) as BundledLanguage,
    theme: 'github-dark',
  });
  return rows.map((r, i) => ({
    n: scene.startLine + i,
    ...(r.kind ? {kind: r.kind} : {}),
    tokens: (tokens[i] ?? []).map((tk) => ({c: tk.content, color: tk.color})),
  }));
}
