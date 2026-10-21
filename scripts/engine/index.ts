// Engine selection (FR-ADOPT-03): framekit is the only engine. `--engine` / WINDOWER_ENGINE accept `framekit`.
import {framekitEngine} from './framekit.js';
import type {Engine, EngineName} from './types.js';

export type {Engine, EngineName} from './types.js';

export const ENGINES: readonly EngineName[] = ['framekit'];

/** Resolves the engine name; throws on any value other than `framekit`. */
export function engineName(
  flag?: string,
  env: string | undefined = process.env.WINDOWER_ENGINE,
): EngineName {
  const value = flag ?? (env ? env : 'framekit');
  if (value === 'framekit') return 'framekit';
  throw new Error(
    `unsupported engine "${value}": windower renders with framekit only; use --engine framekit (or unset WINDOWER_ENGINE)`,
  );
}

export function resolveEngine(flag?: string): Engine {
  engineName(flag);
  return framekitEngine;
}
