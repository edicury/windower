// Optional <repo>/.windower.json. Secrets never come from this file (contract §2).
import fs from 'node:fs';
import path from 'node:path';

export interface WindowerConfig {
  provider?: string;
  /** Third-party provider modules. */
  providers?: string[];
  voice?: string;
  model?: string;
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

export function loadConfig(repoRoot: string): WindowerConfig {
  const file = path.join(repoRoot, '.windower.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`.windower.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('.windower.json must be a JSON object');
  const bad = findKeyLike(raw, '');
  if (bad)
    throw new Error(
      `.windower.json field "${bad}" looks like a secret; API keys are read from the environment only`,
    );
  const o = raw as Record<string, unknown>;
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
  return cfg;
}
