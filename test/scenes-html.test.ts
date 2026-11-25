import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {validateFile, validateStoryboard, type Issue} from '../scripts/validate-storyboard.js';
import {Storyboard} from '../template/src/schema.js';
import {htmlProblems} from '../template/src/htmlLint.js';
import {KIT_BRAND_MAP, KIT_THEME_VARS, buildSrcdoc} from '../template/src/htmlKit.js';

const fx = (name: string) => path.join('fixtures', 'storyboards', name);
const load = (name: string) => JSON.parse(readFileSync(fx(name), 'utf8'));
const run = (sb: unknown) => validateStoryboard(sb, {baseDir: path.dirname(fx('x.json'))});
const has = (list: Issue[], sceneId: string, text: string) =>
  list.some((i) => i.sceneId === sceneId && i.message.includes(text));
const withHtml = (html: string) => {
  const sb = load('html.json');
  sb.scenes[1].html = html;
  return run(sb);
};

describe('html scene schema', () => {
  it('accepts inline html and file scenes', () => {
    expect(Storyboard.safeParse(load('html.json')).success).toBe(true);
    expect(validateFile(fx('html.json')).errors).toEqual([]);
  });
  it('needs exactly one of html and file, and rejects unknown fields', () => {
    const sb = load('html.json');
    sb.scenes[1].file = 'html-card.html';
    expect(Storyboard.safeParse(sb).success).toBe(false);
    const none = load('html.json');
    delete none.scenes[1].html;
    expect(Storyboard.safeParse(none).success).toBe(false);
    const extra = load('html.json');
    extra.scenes[1].css = 'x';
    expect(Storyboard.safeParse(extra).success).toBe(false);
  });
});

describe('html scene validation', () => {
  it('rejects oversize html and missing, escaping or non-html files', () => {
    expect(has(withHtml('<p class="w-fade">' + 'x'.repeat(60001)).errors, 's02', '60000')).toBe(
      true,
    );
    const sb = load('html.json');
    sb.scenes[2].file = 'nope.html';
    expect(has(run(sb).errors, 's03', 'not found')).toBe(true);
    sb.scenes[2].file = '../../package.json';
    expect(has(run(sb).errors, 's03', 'inside the storyboard directory')).toBe(true);
  });
  it.each([
    ['remote image', '<img src="https://x.test/a.png" class="w-fade">', 'remote URLs'],
    ['script src', '<script src="a.js"></script><i class="w-fade"></i>', '<script src>'],
    ['fetch', '<i class="w-fade"></i><script>fetch("/a")</script>', 'network APIs'],
    ['remote @import', '<style>@import url(x.css);</style><i class="w-fade"></i>', '@import'],
    [
      'web font',
      '<style>@font-face{src:url(//f.test/a.woff2)}</style><i class="w-fade"></i>',
      'remote URLs',
    ],
    ['local asset', '<i class="w-fade" style="background:url(a.png)"></i>', 'cannot load'],
    ['wall clock', '<i class="w-fade"></i><script>Date.now()</script>', 'wall-clock'],
  ])('rejects %s', (_n, html, msg) => {
    expect(has(withHtml(html).errors, 's02', msg)).toBe(true);
  });
  it('warns on static pages and tiny text; allows data: URIs and svg namespaces', () => {
    const r = withHtml('<p style="font-size:20px">hi</p>');
    expect(has(r.warnings, 's02', 'no animation')).toBe(true);
    expect(has(r.warnings, 's02', '28px')).toBe(true);
    const ok = htmlProblems(
      '<svg xmlns="http://www.w3.org/2000/svg"><path class="w-draw"/></svg><img class="w-fade" src="data:image/png;base64,AA==">',
    );
    expect(ok.filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('html kit', () => {
  it('wraps fragments and full documents with CSP and the kit first', () => {
    for (const html of [
      '<p>x</p>',
      '<html><head><title>t</title></head><body>x</body></html>',
      '<head></head><p>x</p>',
    ]) {
      const doc = buildSrcdoc(html);
      expect(doc).toContain("default-src 'none'");
      expect(doc.indexOf('windower-kit')).toBeLessThan(doc.indexOf('x</'));
    }
  });
  it('maps every theme variable to a brand variable', () => {
    expect(Object.keys(KIT_BRAND_MAP).sort()).toEqual(Object.keys(KIT_THEME_VARS).sort());
  });
});
