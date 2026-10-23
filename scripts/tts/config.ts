// Optional <repo>/.windower.json. Secrets never come from this file (contract §2).
import fs from 'node:fs';
import path from 'node:path';
import {HEX, LOGO_POSITIONS, SAFE_FONT, type LogoPosition} from '../../template/src/brand.js';

export interface WindowerConfig {
  provider?: string;
  /** Third-party provider modules. */
  providers?: string[];
  voice?: string;
  model?: string;
  /** Brand theme (US-07). `logoFile` is the absolute path of `logo`, checked to exist. */
  brand?: {
    primary: string;
    background: string;
    accent?: string;
    text?: string;
    font?: string;
    logo?: string;
    logoFile?: string;
    logoPosition?: LogoPosition;
  };
  /** Default video length in seconds (60-120), surfaced to the skill. */
  defaultLengthSec?: number;
}

export const LENGTH_RANGE = {min: 60, max: 120} as const;
export const MAX_LOGO_BYTES = 256 * 1024;
const KNOWN = ['provider', 'providers', 'voice', 'model', 'brand', 'defaultLengthSec'];
const KNOWN_BRAND = ['primary', 'background', 'accent', 'text', 'font', 'logo', 'logoPosition'];
const bad = (field: string, why: string): never => {
  throw new Error(`.windower.json "${field}" ${why}`);
};

function parseBrand(
  v: unknown,
  repoRoot: string,
  warnings: string[],
): NonNullable<WindowerConfig['brand']> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('brand', 'must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!KNOWN_BRAND.includes(k)) warnings.push(`.windower.json: unknown key "brand.${k}" ignored`);
  const color = (k: 'primary' | 'background' | 'accent' | 'text', required: boolean) => {
    const c = o[k];
    if (c === undefined) {
      if (required) bad(`brand.${k}`, 'is required');
      return undefined;
    }
    if (typeof c !== 'string' || !HEX.test(c))
      return bad(`brand.${k}`, 'must be a hex color like #0a84ff or #fff');
    return c.toLowerCase();
  };
  const brand: NonNullable<WindowerConfig['brand']> = {
    primary: color('primary', true) as string,
    background: color('background', true) as string,
  };
  const accent = color('accent', false);
  if (accent) brand.accent = accent;
  const text = color('text', false);
  if (text) brand.text = text;
  if (o.font !== undefined) {
    if (typeof o.font !== 'string' || !SAFE_FONT.test(o.font))
      bad('brand.font', 'must be a font family name (letters, digits, spaces, hyphens only)');
    brand.font = o.font as string;
  }
  if (o.logo !== undefined) {
    if (typeof o.logo !== 'string' || !o.logo) return bad('brand.logo', 'must be a file path');
    if (!/\.(svg|png)$/i.test(o.logo)) bad('brand.logo', 'must be an .svg or .png file');
    const file = path.resolve(repoRoot, o.logo);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return bad('brand.logo', `file not found: ${file}`);
    }
    if (size > MAX_LOGO_BYTES)
      bad(
        'brand.logo',
        `is ${Math.round(size / 1024)} KB; the limit is ${MAX_LOGO_BYTES / 1024} KB`,
      );
    brand.logo = o.logo;
    brand.logoFile = file;
  }
  if (o.logoPosition !== undefined) {
    if (!LOGO_POSITIONS.includes(o.logoPosition as LogoPosition))
      return bad('brand.logoPosition', `must be one of ${LOGO_POSITIONS.join(', ')}`);
    brand.logoPosition = o.logoPosition as LogoPosition;
  }
  return brand;
}

const KEY_LIKE = /key|secret|token|password|passwd|credential|auth/i;

function findKeyLike(v: unknown, trail: string): string | null {
  if (v && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) {
      const p = trail ? `${trail}.${k}` : k;
      if (KEY_LIKE.test(k)) return p;
      const hit = findKeyLike(child, p);
      if (hit) return hit;
    }
  }
  return null;
}

export function loadConfigWithWarnings(repoRoot: string): {
  config: WindowerConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const file = path.join(repoRoot, '.windower.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {config: {}, warnings};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`.windower.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('.windower.json must be a JSON object');
  const secret = findKeyLike(raw, '');
  if (secret)
    throw new Error(
      `.windower.json field "${secret}" looks like a secret; API keys are read from the environment only`,
    );
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!KNOWN.includes(k)) warnings.push(`.windower.json: unknown key "${k}" ignored`);
  const cfg: WindowerConfig = {};
  const str = (k: 'provider' | 'voice' | 'model') => {
    const v = o[k];
    if (v === undefined) return;
    if (typeof v !== 'string' || !v)
      throw new Error(`.windower.json "${k}" must be a non-empty string`);
    cfg[k] = v;
  };
  str('provider');
  str('voice');
  str('model');
  if (o.providers !== undefined) {
    if (!Array.isArray(o.providers) || !o.providers.every((p) => typeof p === 'string'))
      throw new Error('.windower.json "providers" must be an array of strings');
    cfg.providers = o.providers as string[];
  }
  if (o.brand !== undefined) cfg.brand = parseBrand(o.brand, repoRoot, warnings);
  if (o.defaultLengthSec !== undefined) {
    const n = o.defaultLengthSec;
    if (
      typeof n !== 'number' ||
      !Number.isFinite(n) ||
      n < LENGTH_RANGE.min ||
      n > LENGTH_RANGE.max
    )
      return bad(
        'defaultLengthSec',
        `must be a number from ${LENGTH_RANGE.min} to ${LENGTH_RANGE.max}`,
      );
    cfg.defaultLengthSec = n;
  }
  return {config: cfg, warnings};
}

export function loadConfig(repoRoot: string): WindowerConfig {
  return loadConfigWithWarnings(repoRoot).config;
}
