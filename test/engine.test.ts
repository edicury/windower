import {describe, expect, it} from 'vitest';
import {engineName} from '../scripts/engine/index.js';

describe('engine selection', () => {
  it('defaults to framekit', () => {
    expect(engineName(undefined, undefined)).toBe('framekit');
    expect(engineName('framekit', undefined)).toBe('framekit');
    expect(engineName(undefined, 'framekit')).toBe('framekit');
  });

  it('rejects any other engine with a clear message', () => {
    expect(() => engineName('other', undefined)).toThrow(/framekit only/);
    expect(() => engineName(undefined, 'other')).toThrow(/unsupported engine "other"/);
  });
});
