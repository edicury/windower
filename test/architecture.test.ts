import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {validateFile, validateStoryboard, type Issue} from '../scripts/validate-storyboard.js';
import {
  NODE_H,
  NODE_W,
  adjacent,
  hLabelLines,
  layoutGrid,
  routeEdge,
  MAX_H_LABEL_LINES,
} from '../template/src/scenes/architectureLayout.js';

const fx = (name: string) => path.join('fixtures', 'storyboards', name);
const load = (name: string) => JSON.parse(readFileSync(fx(name), 'utf8'));
const has = (list: Issue[], sceneId: string, field: string, text?: string) =>
  list.some(
    (i) =>
      i.sceneId === sceneId &&
      i.path.startsWith(field) &&
      (text === undefined || i.message.includes(text)),
  );

/** at-limit storyboard with the architecture scene (s02) mutated. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mutated(fn: (arch: Record<string, any>) => void) {
  const sb = load('architecture-at-limit.json');
  fn(sb.scenes[1]);
  return validateStoryboard(sb, {baseDir: path.dirname(fx('x'))});
}

describe('architecture grid layout (2.E.5)', () => {
  const ids = Array.from({length: 9}, (_, i) => `n${i}`);
  const grid = layoutGrid(ids);

  it('places 9 nodes at x = 120/740/1360 and rows ~200/470/740', () => {
    expect([...new Set([...grid.values()].map((p) => p.x))]).toEqual([120, 740, 1360]);
    expect([...new Set([...grid.values()].map((p) => p.y))]).toEqual([200, 470, 740]);
  });

  it('keeps column gaps >= 150 px, no overlap, content above the captions bar', () => {
    const ps = [...grid.values()];
    for (const a of ps)
      for (const b of ps) {
        if (a === b || a.row !== b.row || b.col !== a.col + 1) continue;
        expect(b.x - (a.x + NODE_W)).toBeGreaterThanOrEqual(150);
      }
    expect(Math.max(...ps.map((p) => p.y + NODE_H))).toBeLessThan(880);
  });

  it('keeps 2x2 and 2-node layouts inside the same gap rule', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const g = [...layoutGrid(ids.slice(0, n)).values()];
      for (const a of g)
        for (const b of g)
          if (a !== b && a.row === b.row && b.col === a.col + 1)
            expect(b.x - (a.x + NODE_W)).toBeGreaterThanOrEqual(150);
      expect(Math.max(...g.map((p) => p.y + NODE_H))).toBeLessThan(880);
      expect(Math.max(...g.map((p) => p.x + NODE_W))).toBeLessThanOrEqual(1800);
    }
  });

  it('routes adjacent edges straight between facing sides, clear of every node', () => {
    const a = grid.get('n0')!;
    const r = routeEdge(a, grid.get('n1')!);
    expect(r.clear).toBe(true);
    expect(r.points[0]!.y).toBe(r.points[1]!.y);
    expect(r.points[0]!.x).toBeGreaterThan(a.x + NODE_W);
    expect(r.points[1]!.x).toBeLessThan(grid.get('n1')!.x);
    expect(adjacent(a, grid.get('n4')!)).toBe(false);
    expect(routeEdge(a, grid.get('n4')!).clear).toBe(false);
  });

  it('wraps a 24-char label into at most 3 lines', () => {
    expect(hLabelLines('x'.repeat(24)).length).toBeLessThanOrEqual(MAX_H_LABEL_LINES);
    expect(hLabelLines('route to orders svc!!').length).toBeLessThanOrEqual(MAX_H_LABEL_LINES);
  });
});

describe('architecture validation (2.B.1)', () => {
  it('accepts the at-limit (9 nodes, 12 edges) and small fixtures', () => {
    const sb = load('architecture-at-limit.json').scenes[1];
    expect(sb.nodes).toHaveLength(9);
    expect(sb.edges).toHaveLength(12);
    expect(validateFile(fx('architecture-at-limit.json')).errors).toEqual([]);
    expect(validateFile(fx('architecture-small.json')).errors).toEqual([]);
  });

  it('rejects more than 9 nodes and more than 12 edges', () => {
    const r = mutated((a) => {
      a.nodes.push({id: 'extra', label: 'Extra', kind: 'service'});
      a.edges.push({from: 'client', to: 'gateway'});
    });
    expect(has(r.errors, 's02', 'nodes', 'nodes > 9')).toBe(true);
    expect(has(r.errors, 's02', 'edges', 'edges > 12')).toBe(true);
  });

  it('rejects fewer than 2 nodes and 1 edge', () => {
    const r = mutated((a) => {
      a.nodes = a.nodes.slice(0, 1);
      a.edges = [];
      delete a.flow;
    });
    expect(has(r.errors, 's02', 'nodes', 'nodes < 2')).toBe(true);
    expect(has(r.errors, 's02', 'edges', 'edges < 1')).toBe(true);
  });

  it('rejects over-long node label, sub and edge label naming scene and field', () => {
    const r = mutated((a) => {
      a.nodes[0].label = 'L'.repeat(21);
      a.nodes[1].sub = 'S'.repeat(31);
      a.edges[0].label = 'E'.repeat(25);
    });
    expect(has(r.errors, 's02', 'nodes[0].label', 'label > 20')).toBe(true);
    expect(has(r.errors, 's02', 'nodes[1].sub', 'sub > 30')).toBe(true);
    expect(has(r.errors, 's02', 'edges[0].label', 'label > 24')).toBe(true);
  });

  it('rejects unknown edge ids and unknown flow ids', () => {
    const r = mutated((a) => {
      a.edges[2].to = 'ghost';
      a.flow[0].path[1] = 'phantom';
    });
    expect(has(r.errors, 's02', 'edges[2].to', 'ghost')).toBe(true);
    expect(has(r.errors, 's02', 'flow[0].path[1]', 'phantom')).toBe(true);
  });

  it('rejects non-adjacent edges and self edges', () => {
    const r = mutated((a) => {
      a.edges[0] = {from: 'client', to: 'database'};
      a.edges[1] = {from: 'auth', to: 'auth'};
      a.flow = [];
    });
    expect(has(r.errors, 's02', 'edges[0]', 'non-adjacent')).toBe(true);
    expect(has(r.errors, 's02', 'edges[1]', 'itself')).toBe(true);
  });

  it('rejects a flow step with no edge, and an out-of-range flow.at', () => {
    const r = mutated((a) => {
      a.flow = [{path: ['client', 'auth'], at: 1.5}];
    });
    expect(has(r.errors, 's02', 'flow[0].path[1]', 'no edge')).toBe(true);
    expect(has(r.errors, 's02', 'flow[0].at')).toBe(true);
  });

  it('rejects the old hand-placed x/y fields and a missing kind', () => {
    const r = mutated((a) => {
      a.nodes[0].x = 5;
      delete a.nodes[1].kind;
    });
    expect(has(r.errors, 's02', 'nodes[0]', 'unknown field')).toBe(true);
    expect(has(r.errors, 's02', 'nodes[1].kind')).toBe(true);
  });
});

describe('Architecture.tsx (2.E.4)', () => {
  const src = readFileSync('template/src/scenes/Architecture.tsx', 'utf8');
  it('has no debug <title> in the SVG', () => {
    expect(src).not.toContain('<title>');
  });
  it('draws straight edges in an SVG that comes after the node boxes', () => {
    expect(src.indexOf('route.clear ? drawEdge')).toBeGreaterThan(src.indexOf('scene.nodes.map'));
  });
});
