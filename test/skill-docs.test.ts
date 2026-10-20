// Keeps the skill docs honest: the worked example validates, the example brief covers its citations,
// and every ve: script named in the skill files exists in package.json.
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {validateStoryboard} from '../scripts/validate-storyboard';

const root = path.resolve(__dirname, '..');
const skillDir = path.join(root, 'skills/windower');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const block = (md: string, lang: string): string => {
  const m = new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```').exec(md);
  if (!m) throw new Error(`no \`\`\`${lang} block`);
  return m[1]!;
};

const docs = [
  'skills/windower/SKILL.md',
  'skills/windower/references/workflow.md',
  'skills/windower/references/storyboard-authoring.md',
  'skills/windower/references/scene-catalog.md',
  'skills/windower/references/narration-style.md',
  'commands/explain-video.md',
];

describe('skill docs', () => {
  const example = JSON.parse(
    block(read('skills/windower/references/storyboard-authoring.md'), 'json'),
  );
  const brief = block(read('skills/windower/references/workflow.md'), 'markdown');
  const sample = path.join(root, 'fixtures/repos/sample');

  it('worked example storyboard validates with its brief', () => {
    const res = validateStoryboard(example, {repoRoot: sample, briefText: brief});
    expect(res.errors.map((e) => `${e.sceneId} ${e.path} ${e.message}`)).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.estimatedSec).toBeGreaterThanOrEqual(60);
    expect(res.estimatedSec).toBeLessThanOrEqual(120);
  });

  it('example is unapproved and cites every scene except the title', () => {
    expect(example.approved).toBe(false);
    for (const s of example.scenes.slice(1))
      if (s.type !== 'outro') expect(s.sources.length).toBeGreaterThan(0);
  });

  it('every ve: script named in the docs exists in package.json', () => {
    const pkg = JSON.parse(read('package.json')) as {scripts: Record<string, string>};
    const named = new Set<string>();
    for (const d of docs) for (const m of read(d).matchAll(/\bve:[a-z-]+/g)) named.add(m[0]);
    expect(named.size).toBeGreaterThan(5);
    for (const n of named) expect(pkg.scripts[n], n).toBeTruthy();
  });

  it('SKILL.md has frontmatter, links existing references, and names the plugin root', () => {
    const skill = read('skills/windower/SKILL.md');
    expect(skill).toMatch(/^---\nname: windower\ndescription: .{40,}\n---/);
    for (const m of skill.matchAll(/\]\((references\/[a-z-]+\.md)\)/g))
      expect(existsSync(path.join(skillDir, m[1]!)), m[1]).toBe(true);
    expect(skill).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(read('commands/explain-video.md')).toContain('$ARGUMENTS');
  });

  it('scene catalog covers every scene type in the schema', () => {
    const catalog = read('skills/windower/references/scene-catalog.md');
    for (const t of ['title', 'bullets', 'code', 'architecture', 'sequence', 'timeline', 'outro'])
      expect(catalog).toContain(`## ${t}`);
  });
});
