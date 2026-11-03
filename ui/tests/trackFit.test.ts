import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Click, Point } from '@rails49/r49';
import { buildLine, fitNodes, fitOptions, sampleFit, type Fit } from '../src/trackFit.js';
import {
  G,
  along,
  clicksAlong,
  clicksAt,
  lengthOf,
  positionsAlong,
  reversedClicks,
  straightBetween,
  type Piece,
} from './trackClicks.js';

const opts = fitOptions(G);

/** The line of `clicks`; throws when the rule refuses them. */
function lineOf(clicks: readonly Click[]): Fit {
  const built = buildLine(clicks, opts);
  if (built.kind !== 'line') throw new Error(`refused: ${built.reason}`);
  return built.fit;
}

/** Points along the line every pixel. */
function samples(fit: Fit): Point[] {
  return sampleFit(fit, 1, 0);
}

/** How far `p` lies from the polyline through `points`. */
function distanceTo(p: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

describe('two clicks', () => {
  it('make a straight from the first to the second', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 400, y: 500 };
    const line = samples(lineOf([a, b]));
    expect(line[0]).toEqual(a);
    expect(distanceTo(b, line)).toBeLessThan(1e-9);
    for (const p of line) expect(Math.abs(4 * (p.x - 100) - 3 * (p.y - 100))).toBeLessThan(1e-9);
  });
});

/** Clicks on the circle of `radius` px about `centre`, at `angles` in radians. */
function onCircle(centre: Point, radius: number, angles: readonly number[]): Point[] {
  return angles.map(a => ({ x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) }));
}

describe('clicks on one straight or one circle', () => {
  it('give that straight, however they are spaced', () => {
    const clicks = [0, 3, 11, 12.5, 30, 41].map(s => ({ x: 100 + s * G * 0.8, y: 50 + s * G * 0.6 }));
    const line = samples(lineOf(clicks));
    for (const p of line) expect(Math.abs(0.6 * (p.x - 100) - 0.8 * (p.y - 50))).toBeLessThan(1e-6);
    expect(distanceTo(clicks[clicks.length - 1], line)).toBeLessThan(1e-6);
  });

  for (const [name, angles] of [
    ['three clicks', [0, 0.4, 1]],
    ['clicks spaced unevenly round most of a turn', [0, 0.3, 0.45, 1.2, 1.9, 2.1, 3, 4.4, 5.2]],
    ['clicks the other way round', [2, 1.5, 0.2, -0.6, -1]],
  ] as const) {
    it(`give that circle: ${name}`, () => {
      const centre = { x: 2000, y: 1500 };
      const r = 30 * G;
      const line = samples(lineOf(onCircle(centre, r, angles)));
      for (const p of line) expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeCloseTo(r, 6);
      expect(distanceTo(onCircle(centre, r, [angles[angles.length - 1]])[0], line)).toBeLessThan(1e-6);
    });
  }
});

/**
 * Noisy clicks along the shapes track is laid in, at the spacing the rule
 * expects and closer: the line must pass through each of them.
 */
const SHAPES: [string, Click[]][] = [
  ['a straight', clicksAlong([{ straight: 80 }], { spacing: 6 })],
  ['an arc', clicksAlong([{ radius: 30, turn: 160 }], { spacing: 6 })],
  ['a straight into an arc', clicksAt([{ straight: 20 }, { radius: 30, turn: 90 }], positionsAlong([{ straight: 20 }, { radius: 30, turn: 90 }]))],
  ['a reverse curve', clicksAlong([{ radius: 30, turn: 60 }, { radius: 30, turn: -60 }], { spacing: 6 })],
  [
    'a 180° curve between straights',
    clicksAt(
      [{ straight: 15 }, { radius: 25, turn: 180 }, { straight: 15 }],
      positionsAlong([{ straight: 15 }, { radius: 25, turn: 180 }, { straight: 15 }], 6)
    ),
  ],
];

/**
 * A click set in tests/clickSets: `gauge`, and `lines` of clicks `[x, y]` in
 * image pixels in the order made. A set recorded in the editor is a file
 * dropped into the directory; the suite finds it.
 */
interface ClickSet {
  readonly gauge: number;
  readonly lines: readonly (readonly [number, number])[][];
}

const SETS = import.meta.glob<ClickSet>('./clickSets/*.json', { eager: true, import: 'default' });

/** Every line to check: the shapes, and every line of every click set, at its gauge. */
const LINES: { name: string; clicks: Click[]; gauge: number }[] = [
  ...SHAPES.map(([name, clicks]) => ({ name, clicks, gauge: G })),
  ...Object.entries(SETS).flatMap(([file, set]) =>
    set.lines.map((raw, i) => ({ name: `${file} line ${i + 1}`, clicks: raw.map(([x, y]) => ({ x, y })), gauge: set.gauge }))
  ),
];

/** Every `n`th of `points`, and the last. */
function every(points: readonly Point[], n: number): Point[] {
  return points.filter((_, i) => i % n === 0 || i === points.length - 1);
}

/** The line between each click and the next, as samples. */
function gaps(clicks: readonly Click[]): Point[][] {
  const line = samples(lineOf(clicks));
  const at: number[] = [];
  let from = 0;
  for (const p of clicks) {
    let best = from;
    for (let i = from; i < line.length; i++) {
      if (Math.hypot(line[i].x - p.x, line[i].y - p.y) < Math.hypot(line[best].x - p.x, line[best].y - p.y)) best = i;
    }
    at.push(best);
    from = best;
  }
  return at.slice(1).map((end, k) => line.slice(at[k], end + 1));
}

/** How far apart two stretches of line lie, at most. */
function apart(a: readonly Point[], b: readonly Point[]): number {
  return Math.max(...every(a, 5).map(p => distanceTo(p, b)), ...every(b, 5).map(p => distanceTo(p, a)));
}

/**
 * Checks that only gaps within three of an edit change: `kept` maps a gap of
 * the line before to the same gap after, for every gap out of reach, and
 * `touched` is a gap the edit does change.
 */
function expectLocal(before: readonly Click[], after: readonly Click[], kept: (gap: number) => number | null, touched: number) {
  const was = gaps(before);
  const now = gaps(after);
  let checked = 0;
  was.forEach((g, k) => {
    const n = kept(k);
    if (n === null) return;
    expect(apart(g, now[n]), `gap ${k}`).toBeLessThan(1e-6);
    checked++;
  });
  expect(checked).toBeGreaterThan(0);
  expect(apart(was[touched], now[touched])).toBeGreaterThan(1e-3);
}

describe('every line', () => {
  it('includes the click sets', () => {
    expect(Object.keys(SETS).length).toBeGreaterThan(0);
  });

  for (const { name, clicks, gauge } of LINES) {
    it(`passes through every click: ${name}`, () => {
      const built = buildLine(clicks, fitOptions(gauge));
      expect(built.kind).toBe('line');
      if (built.kind !== 'line') return;
      const line = samples(built.fit);
      for (const p of clicks) expect(distanceTo(p, line)).toBeLessThan(1e-6);
    });

    it(`has no kink: ${name}`, () => {
      // Samples a pixel apart on arcs no tighter than 10 G turn under 0.004 rad from one to the next.
      const line = samples(lineOf(clicks));
      for (let i = 2; i < line.length; i++) {
        const a = Math.atan2(line[i - 1].y - line[i - 2].y, line[i - 1].x - line[i - 2].x);
        const b = Math.atan2(line[i].y - line[i - 1].y, line[i].x - line[i - 1].x);
        expect(Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)))).toBeLessThan(0.005);
      }
    });

    it(`is the same for the clicks reversed: ${name}`, () => {
      const forward = samples(lineOf(clicks));
      const backward = samples(lineOf([...clicks].reverse()));
      expect(backward[0]).toEqual(clicks[clicks.length - 1]);
      for (const p of every(forward, 20)) expect(distanceTo(p, backward)).toBeLessThan(1e-6);
      for (const p of every(backward, 20)) expect(distanceTo(p, forward)).toBeLessThan(1e-6);
    });
  }
});

describe('an edit', () => {
  const long = LINES.filter(l => l.clicks.length >= 12);

  it('is checked on lines long enough to leave gaps out of its reach', () => {
    expect(long.length).toBeGreaterThan(0);
  });

  for (const { name, clicks, gauge } of long) {
    const j = Math.floor(clicks.length / 2);

    it(`moving a click changes at most three gaps on each side: ${name}`, () => {
      const moved = clicks.map((p, i) => (i === j ? { x: p.x + gauge / 4, y: p.y - gauge / 5 } : p));
      expectLocal(clicks, moved, g => (g <= j - 4 || g >= j + 3 ? g : null), j);
    });

    it(`inserting a click changes at most three gaps on each side: ${name}`, () => {
      // Near the line, halfway along the gap.
      const gap = gaps(clicks)[j];
      const mid = gap[Math.floor(gap.length / 2)];
      const inserted = [...clicks.slice(0, j + 1), { x: mid.x + 2, y: mid.y - 1 }, ...clicks.slice(j + 1)];
      expectLocal(clicks, inserted, g => (g <= j - 3 ? g : g >= j + 3 ? g + 1 : null), j - 1);
    });

    it(`deleting a click changes at most three gaps on each side: ${name}`, () => {
      const left = clicks.filter((_, i) => i !== j);
      expectLocal(clicks, left, g => (g <= j - 4 ? g : g >= j + 3 ? g - 1 : null), j - 2);
    });
  }
});

/**
 * Clicks along `pieces` at `positions` gauges, with the gaps between the
 * clicks at `runs` (pairs of click indices) marked straight. No click is put
 * where a curve meets a straight.
 */
interface Marked {
  readonly name: string;
  readonly pieces: readonly Piece[];
  readonly positions: readonly number[];
  readonly runs: readonly (readonly [number, number])[];
}

const MARKED: Marked[] = [
  { name: 'a straight', pieces: [{ straight: 40 }], positions: [0, 5, 10, 15, 20, 25, 30, 35, 40], runs: [[0, 8]] },
  {
    name: 'a straight into an arc',
    pieces: [{ straight: 20 }, { radius: 30, turn: 90 }],
    positions: [0, 5, 10, 15, 23, 28, 33, 38, 43, 47],
    runs: [[0, 3]],
  },
  {
    name: 'an arc into a straight',
    pieces: [{ radius: 30, turn: 90 }, { straight: 20 }],
    positions: [0, 5, 10, 15, 20, 25, 30, 35, 40, 51, 56, 61, 67],
    runs: [[9, 12]],
  },
  {
    name: 'a straight between two curves',
    pieces: [{ radius: 30, turn: 60 }, { straight: 20 }, { radius: 40, turn: -60 }],
    positions: [0, 6, 12, 18, 24, 30, 34, 40, 46, 50, 55, 61, 67, 73, 79, 85, 93],
    runs: [[6, 9]],
  },
  {
    name: 'a curve between two straights',
    pieces: [{ straight: 20 }, { radius: 25, turn: 90 }, { straight: 20 }],
    positions: [0, 5, 10, 16, 22, 28, 34, 40, 46, 52, 57, 62, 67, 72, 79],
    runs: [
      [0, 3],
      [11, 14],
    ],
  },
];

/** The clicks of a marked line, with `noise` σ in gauges. */
function markedClicks({ pieces, positions, runs }: Marked, noise: number): Click[] {
  const clicks = clicksAt(pieces, positions, { noise, seed: 7 });
  return runs.reduce((out, [a, b]) => straightBetween(out, a, b), clicks);
}

/** The click indices of the marked line's straight runs. */
function runClicks({ runs }: Marked): number[] {
  return runs.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
}

/** The index of the sample nearest `p`. */
function nearestSample(samples: readonly Point[], p: Point): number {
  let best = 0;
  samples.forEach((q, i) => {
    if (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(samples[best].x - p.x, samples[best].y - p.y)) best = i;
  });
  return best;
}

describe('a line with straight gaps', () => {
  const tolerance = 0.1 * G;

  for (const marked of MARKED) {
    const { name, pieces, runs } = marked;
    const clicks = markedClicks(marked, 0.03);
    const inRun = runClicks(marked);

    it(`is exactly straight along each run, and within the tolerance of its clicks: ${name}`, () => {
      const line = samples(lineOf(clicks));
      for (const [a, b] of runs) {
        const from = nearestSample(line, clicks[a]);
        const to = nearestSample(line, clicks[b]);
        const ends = [line[from], line[to]];
        for (let i = from; i <= to; i++) expect(distanceTo(line[i], ends)).toBeLessThan(1e-6);
        for (let i = a; i <= b; i++) expect(distanceTo(clicks[i], line)).toBeLessThanOrEqual(tolerance);
      }
    });

    it(`passes through every free click: ${name}`, () => {
      const line = samples(lineOf(clicks));
      clicks.forEach((p, i) => {
        if (!inRun.includes(i)) expect(distanceTo(p, line)).toBeLessThan(1e-6);
      });
    });

    it(`has no kink: ${name}`, () => {
      const line = samples(lineOf(clicks));
      for (let i = 2; i < line.length; i++) {
        const a = Math.atan2(line[i - 1].y - line[i - 2].y, line[i - 1].x - line[i - 2].x);
        const b = Math.atan2(line[i].y - line[i - 1].y, line[i].x - line[i - 1].x);
        expect(Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)))).toBeLessThan(0.005);
      }
    });

    it(`is the same for the clicks and marks reversed: ${name}`, () => {
      const forward = samples(lineOf(clicks));
      const backward = samples(lineOf(reversedClicks(clicks)));
      for (const p of every(forward, 20)) expect(distanceTo(p, backward)).toBeLessThan(1e-6);
      for (const p of every(backward, 20)) expect(distanceTo(p, forward)).toBeLessThan(1e-6);
    });

    it(`is the track, where a curve meets a run with no click there, for clicks on the track: ${name}`, () => {
      const exact = markedClicks(marked, 0);
      const total = lengthOf(pieces);
      const track = Array.from({ length: Math.ceil(total / 0.05) + 1 }, (_, i) => along(pieces, Math.min(total, i * 0.05)));
      const line = samples(lineOf(exact));
      const from = nearestSample(track, exact[0]);
      const to = nearestSample(track, exact[exact.length - 1]);
      for (const p of every(line, 5)) expect(distanceTo(p, track)).toBeLessThan(1e-3);
      for (const p of every(track.slice(from, to + 1), 5)) expect(distanceTo(p, line)).toBeLessThan(1e-3);
    });

    it.skipIf(inRun.length === clicks.length)(`changes at most three gaps on each side when a free click moves: ${name}`, () => {
      // A straight part whose length changes is sampled at other points
      // along it, so a gap out of reach is compared with the whole line.
      const was = gaps(clicks);
      const wasLine = samples(lineOf(clicks));
      const free = clicks.map((_, i) => i).filter(i => !inRun.includes(i) && i > 0 && i < clicks.length - 1);
      for (const j of free) {
        // A tenth of a gauge: clicks 5 G apart on a curve of 25 G leave little room before an arc is too tight.
        const moved = clicks.map((p, i) => (i === j ? { ...p, x: p.x + G / 12, y: p.y - G / 15 } : p));
        const now = gaps(moved);
        const nowLine = samples(lineOf(moved));
        was.forEach((g, k) => {
          if (k > j - 4 && k < j + 3) return;
          for (const p of every(g, 5)) expect(distanceTo(p, nowLine), `click ${j}, gap ${k}`).toBeLessThan(1e-6);
          for (const p of every(now[k], 5)) expect(distanceTo(p, wasLine), `click ${j}, gap ${k}`).toBeLessThan(1e-6);
        });
        expect(apart(was[j], now[j])).toBeGreaterThan(1e-3);
      }
    });
  }

  it('is built when the curves on both sides of a one-gap run would touch it the wrong way round', () => {
    // Clicks on a circle of 40 G that touches the run 4.25 G along it, past
    // where the circle from the other side touches it, 0.75 G along.
    const R = 40;
    const before = [3, 2, 1].map(k => {
      const a = 0.2 + 0.15 * k;
      return { x: (4.25 - R * Math.sin(a)) * G, y: R * (1 - Math.cos(a)) * G };
    });
    const after = [...before].reverse().map(p => ({ x: 5 * G - p.x, y: -p.y }));
    const clicks = [...before, { x: 0, y: 0, straight: true }, { x: 5 * G, y: 0 }, ...after];
    const line = samples(lineOf(clicks));
    for (const p of [...before, ...after]) expect(distanceTo(p, line)).toBeLessThan(1e-6);
    for (let i = 2; i < line.length; i++) {
      const a = Math.atan2(line[i - 1].y - line[i - 2].y, line[i - 1].x - line[i - 2].x);
      const b = Math.atan2(line[i].y - line[i - 1].y, line[i].x - line[i - 1].x);
      expect(Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)))).toBeLessThan(0.005);
    }
    const backward = samples(lineOf(reversedClicks(clicks)));
    for (const p of every(line, 20)) expect(distanceTo(p, backward)).toBeLessThan(1e-6);
  });
});

describe('the rule refuses', () => {
  const P = (x: number, y: number) => ({ x: 100 + x * G, y: 100 + y * G });

  it('a click behind the click before it, or on it', () => {
    expect(buildLine([P(0, 0), P(10, 0), P(5, 0)], opts)).toEqual({ kind: 'refused', reason: 'behind' });
    expect(buildLine([P(0, 0), P(10, 0), P(10, 0)], opts)).toEqual({ kind: 'refused', reason: 'behind' });
    expect(buildLine([P(0, 0), P(0, 0)], opts)).toEqual({ kind: 'refused', reason: 'behind' });
    expect(buildLine([P(0, 0), P(10, 0), P(-3, 1)], opts)).toEqual({ kind: 'refused', reason: 'behind' });
  });

  it('two clicks out of order on a long line', () => {
    const [, clicks] = SHAPES[0];
    const swapped = clicks.map((p, i) => (i === 5 ? clicks[6] : i === 6 ? clicks[5] : p));
    expect(buildLine(swapped, opts)).toEqual({ kind: 'refused', reason: 'behind' });
  });

  it('an arc tighter than 10 G, and takes one of 10 G and more', () => {
    // The circle through the three has a radius of 7.5 G; through a click farther on, 35 G.
    expect(buildLine([P(0, 0), P(10, 0), P(11, 10)], opts)).toEqual({ kind: 'refused', reason: 'tight' });
    expect(buildLine([P(0, 0), P(10, 0), P(40, 30)], opts).kind).toBe('line');
    const centre = { x: 2000, y: 1500 };
    const angles = [0, 0.5, 1, 1.5, 2];
    expect(buildLine(onCircle(centre, 9.9 * G, angles), opts)).toEqual({ kind: 'refused', reason: 'tight' });
    expect(buildLine(onCircle(centre, 10.1 * G, angles), opts).kind).toBe('line');
  });

  it('a click of a straight run more than 0.1 G off its line, and takes one less', () => {
    const run = [P(0, 0), P(5, 0), P(10, 0), P(15, 0), P(20, 0)];
    const off = (gauges: number) =>
      straightBetween(run.map((p, i) => (i === 2 ? { x: p.x, y: p.y + gauges * G } : p)), 0, 4);
    // The run's line moves towards the click by a fifth of how far it is off.
    expect(buildLine(off(0.13), opts)).toEqual({ kind: 'refused', reason: 'off-straight' });
    expect(buildLine(off(0.12), opts).kind).toBe('line');
    expect(buildLine(off(-0.13), opts)).toEqual({ kind: 'refused', reason: 'off-straight' });
    // Free, the same clicks make a line.
    expect(buildLine(run.map((p, i) => (i === 2 ? { x: p.x, y: p.y + 0.13 * G } : p)), opts).kind).toBe('line');
  });

  it('the same clicks reversed for the same reason', () => {
    for (const clicks of [
      [P(0, 0), P(10, 0), P(5, 0)],
      [P(0, 0), P(10, 0), P(11, 10)],
    ]) {
      expect(buildLine([...clicks].reverse(), opts)).toEqual(buildLine(clicks, opts));
    }
  });
});

describe('fitNodes', () => {
  const r = 100;
  const line = {
    start: { x: 0, y: 0, heading: 0 },
    parts: [
      { length: 100, curvature: 0 },
      { length: (r * Math.PI) / 2, curvature: 1 / r },
      { length: (r * 2 * Math.PI) / 3, curvature: 1 / r },
    ],
  };

  it('makes each join a node, and splits an arc past 90° in two', () => {
    const nodes = fitNodes(line);
    const expected = [
      [0, 0, 0],
      [100, 0, 0],
      [200, 100, Math.PI / 2],
      [150, 100 + 50 * Math.sqrt(3), (5 * Math.PI) / 6],
      [50, 100 + 50 * Math.sqrt(3), (-5 * Math.PI) / 6],
    ];
    expect(nodes).toHaveLength(expected.length);
    nodes.forEach((n, i) => {
      expect(n.x).toBeCloseTo(expected[i][0], 6);
      expect(n.y).toBeCloseTo(expected[i][1], 6);
      expect(n.heading).toBeCloseTo(expected[i][2], 6);
    });
  });

  // A Bézier between two nodes follows an arc closely only while it turns
  // 90° or less; a 300° part stored as two 150° segments lay 0.2 G off it.
  it('splits an arc of 300° into four pieces, every node on the arc', () => {
    const sweep = (5 * Math.PI) / 3;
    const nodes = fitNodes({ start: { x: 0, y: 0, heading: 0 }, parts: [{ length: r * sweep, curvature: 1 / r }] });
    expect(nodes).toHaveLength(5);
    nodes.forEach((n, i) => {
      // The circle's centre is (0, r).
      expect(Math.hypot(n.x, n.y - r)).toBeCloseTo(r, 6);
      expect(Math.cos(n.heading - (i * sweep) / 4)).toBeCloseTo(1, 6);
    });
  });
});

describe('the rule module', () => {
  it('imports nothing but the r49 types and track.ts, so no DOM and no Lit', () => {
    for (const file of ['trackFit.ts', 'track.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
      const from = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
      for (const f of from) expect(['@rails49/r49', './track.js']).toContain(f);
    }
  });
});
