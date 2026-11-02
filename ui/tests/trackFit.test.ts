import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import { distances, extend, fitNodes, fitTrack, sampleFit, type Line } from '../src/trackFit.js';
import { traceOptions } from '../src/trackTrace.js';
import { G, TEN_PARTS, clicksAlong, offLine, type Piece } from './trackClicks.js';

const opts = traceOptions(G);
const TOLERANCE = 0.25 * G;

function fit(clicks: readonly Point[]): Line {
  const line = fitTrack(clicks, opts);
  if (!line) throw new Error('no fit');
  return line;
}

/** How far the click farthest from the line lies, px. */
function worst(line: Line, clicks: readonly Point[]): number {
  return Math.max(...distances(line.fit, clicks).map(Math.abs));
}

/** The clicks farther than the tolerance from the line. */
function red(line: Line, clicks: readonly Point[]): number[] {
  return distances(line.fit, clicks).flatMap((d, i) => (Math.abs(d) > TOLERANCE ? [i] : []));
}

/**
 * Each part's radius in gauges. The solver's curvature is never exactly 0,
 * so a straight is a part whose radius is over 200 G: its sagitta over a 40 G
 * straight is under 1 G.
 */
function radii(line: Line): number[] {
  return line.fit.parts.map(p => {
    const r = 1 / Math.abs(p.curvature) / G;
    return r > 200 ? Infinity : r;
  });
}

describe('fitTrack', () => {
  it('needs two clicks, and makes the first straight of them', () => {
    expect(fitTrack([{ x: 1, y: 1 }], opts)).toBeNull();
    const line = fit([
      { x: 100, y: 100 },
      { x: 400, y: 500 },
    ]);
    expect(line.fit.start).toEqual({ x: 100, y: 100, heading: Math.atan2(400, 300) });
    expect(line.fit.parts).toEqual([{ length: 500, curvature: 0 }]);
    expect(line.firstClick).toEqual([0]);
  });

  // Radii in gauges, Infinity for a straight.
  const shapes: [string, Piece[], number[]][] = [
    ['a straight', [{ straight: 40 }], [Infinity]],
    ['an arc', [{ radius: 30, turn: 90 }], [30]],
    ['a straight into an arc', [{ straight: 20 }, { radius: 30, turn: 90 }], [Infinity, 30]],
    ['a reverse curve', [{ radius: 30, turn: 60 }, { radius: 30, turn: -60 }], [30, 30]],
    ['a 180° curve', [{ straight: 15 }, { radius: 25, turn: 180 }, { straight: 15 }], [Infinity, 25, Infinity]],
  ];
  for (const [name, pieces, expected] of shapes) {
    for (const spacing of [3, 5]) {
      it(`fits ${name}, a click every ${spacing} G`, () => {
        const clicks = clicksAlong(pieces, { spacing });
        const line = fit(clicks);
        const got = radii(line);
        expect(got).toHaveLength(expected.length);
        // Radii within 5%.
        got.forEach((r, i) => expect(r === expected[i] || Math.abs(r / expected[i] - 1) < 0.05).toBe(true));
        expect(worst(line, clicks)).toBeLessThanOrEqual(TOLERANCE);
      });
    }
  }

  it('turns the way the track turns', () => {
    const line = fit(clicksAlong([{ radius: 30, turn: 60 }, { radius: 30, turn: -60 }]));
    expect(line.fit.parts.map(p => Math.sign(p.curvature))).toEqual([1, -1]);
  });

  it('gives each part the clicks from its first to the next part’s first', () => {
    const clicks = clicksAlong([{ straight: 20 }, { radius: 30, turn: 90 }]);
    const line = fit(clicks);
    expect(line.firstClick[0]).toBe(0);
    for (let i = 1; i < line.firstClick.length; i++) expect(line.firstClick[i]).toBeGreaterThan(line.firstClick[i - 1]);
    expect(line.firstClick[line.firstClick.length - 1]).toBeLessThan(clicks.length);
  });
});

describe('fitTrack with a click past the tolerance', () => {
  const straight = clicksAlong([{ straight: 30 }]);
  /** `clicks` with click `i` moved `gauges` across the track. */
  const moved = (clicks: readonly Point[], gauges: number, i: number) =>
    clicks.map((p, k) => (k === i ? offLine(p, clicks[k - 1] ?? p, clicks[k + 1] ?? p, gauges) : p));

  it('leaves a lone click a gauge across a straight red, and keeps the straight', () => {
    const clicks = moved(straight, 1, 4);
    const line = fit(clicks);
    expect(radii(line)).toEqual([Infinity]);
    expect(red(line, clicks)).toEqual([4]);
  });

  it('reaches a click a gauge across on the end with a new part', () => {
    const clicks = moved(straight, 1, straight.length - 1);
    const line = fit(clicks);
    expect(line.fit.parts.length).toBeGreaterThan(1);
    expect(red(line, clicks)).toEqual([]);
  });

  // The last click, past the end of a straight into a curve, was the worst
  // click and cut its part at its own projection, the part's end: a second
  // half of no length the solve could not grow, so splitting stopped there.
  it('splits for a last click past the end of its part, so a straight into a reverse curve stays five parts', () => {
    const dpt = 89.6875;
    const clicks = clicksAlong([
      { straight: 20 },
      { radius: 30, turn: 90 },
      { straight: 20 },
      { radius: 30, turn: -90 },
      { straight: 20 },
    ]).map(p => ({ x: Math.round((p.x * dpt) / G), y: Math.round((p.y * dpt) / G) }));
    const o = traceOptions(dpt);
    let line: Line | null = null;
    for (let n = 2; n <= clicks.length; n++) {
      line = extend(line, clicks.slice(0, n), o);
      expect(line?.fit.parts.length, `${n} clicks`).toBeLessThanOrEqual(5);
    }
    expect(line?.fit.parts).toHaveLength(5);
    expect(distances(line!.fit, clicks).filter(d => Math.abs(d) > o.tolerance)).toEqual([]);
  });

  // A click back along a straight left the solve free to wind an arc round
  // and round: its length ran away, and drawing it ran out of memory.
  it('keeps a part within one turn of its circle for a click folded back along the line', () => {
    const o = traceOptions(89.6875);
    const clicks = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 200, y: 100 },
    ];
    const line = fitTrack(clicks, o)!;
    for (const p of line.fit.parts) expect(Math.abs(p.length * p.curvature)).toBeLessThan(2 * Math.PI);
    expect(sampleFit(line.fit, 2, 0).length).toBeLessThan(10_000);
  });

  it('adds no part for clicks nothing reaches, and leaves them red', () => {
    /** Twelve clicks every 3 G, every other one 1.5 G across: no straight or arc reaches them. */
    const zigzag = Array.from({ length: 12 }, (_, i) => ({ x: 400 + i * 3 * G, y: 300 + (i % 2) * 1.5 * G }));
    let line: Line | null = null;
    for (let n = 2; n <= zigzag.length; n++) {
      line = extend(line, zigzag.slice(0, n), opts);
      expect(line?.fit.parts, `${n} clicks`).toHaveLength(1);
    }
    expect(red(line!, zigzag)).toEqual(zigzag.map((_, i) => i));
  });
});

describe('fitTrack on the sparse and dense cases that once collapsed the solver', () => {
  it('fits seven sparse clicks, 15 G apart, on a straight, a 90° curve and a straight', () => {
    const clicks = clicksAlong([{ straight: 25 }, { radius: 30, turn: 90 }, { straight: 25 }], { spacing: 15 });
    expect(clicks).toHaveLength(7);
    const line = fit(clicks);
    expect(worst(line, clicks)).toBeLessThanOrEqual(TOLERANCE);
    for (const p of line.fit.parts) expect(Math.abs(p.curvature)).toBeLessThanOrEqual(1 / (10 * G));
  });

  // A part turns at most 300°, so a full circle is two arcs.
  it('fits a dense loop, a click every 1.5 G around a 32 G circle, as two arcs of that radius', () => {
    const clicks = clicksAlong([{ radius: 32, turn: 360 }], { spacing: 1.5 });
    const line = fit(clicks);
    expect(worst(line, clicks)).toBeLessThanOrEqual(TOLERANCE);
    expect(radii(line)).toHaveLength(2);
    for (const r of radii(line)) expect(Math.abs(r / 32 - 1)).toBeLessThan(0.05);
  });
});

describe('fitTrack on a long line clicked every 2 G', () => {
  const line = clicksAlong(TEN_PARTS, { spacing: 2, seed: 7 });

  // A click may be red while it is the last, until the next click reaches it;
  // a click before the window is never red, as nothing can reach it later.
  // Timed with room for a slow machine: a click is well under a second, and a
  // rebuild (a move or delete) under half of one.
  it('leaves no click before the window red at any prefix, each click in under 100 ms, and rebuilds in under 400 ms', () => {
    expect(line).toHaveLength(166);
    let fitted: Line | null = null;
    for (let n = 2; n <= line.length; n++) {
      const t0 = performance.now();
      fitted = extend(fitted, line.slice(0, n), opts);
      expect(performance.now() - t0, `click ${n}`).toBeLessThan(100);
      const m = fitted!.fit.parts.length;
      const windowFirst = fitted!.firstClick[Math.max(0, m - 2)];
      expect(red(fitted!, line.slice(0, n)).filter(i => i < windowFirst), `${n} clicks`).toEqual([]);
    }
    expect(fitted?.fit.parts).toHaveLength(10);
    expect(red(fitted!, line)).toEqual([]);
    const t0 = performance.now();
    expect(fitTrack(line, opts)).toEqual(fitted);
    expect(performance.now() - t0).toBeLessThan(400);
  }, 20_000);
});

describe('fitTrack on clicks nothing fits', () => {
  /** Clicks scattered at random over a 3000 px square, seeded. */
  function scatter(n: number): Point[] {
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n }, () => ({ x: next() * 3000, y: next() * 3000 }));
  }

  it('returns within 500 ms for 40 scattered clicks, most of them red', () => {
    const clicks = scatter(40);
    const t0 = performance.now();
    const line = fit(clicks);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(red(line, clicks).length).toBeGreaterThan(20);
  });
});

/**
 * A click set as the prototype's copy key wrote it, `{ gauge, lines }` with
 * each click `[x, y]` in image pixels, plus what its lines fit to when it was
 * recorded: the part count and the worst distance in gauges.
 */
interface ClickSet {
  readonly note?: string;
  readonly gauge: number;
  readonly lines: readonly (readonly [number, number])[][];
  readonly parts: readonly number[];
  readonly worst: readonly number[];
}

describe('fitTrack on the recorded click sets in tests/clickSets', () => {
  const sets = import.meta.glob<ClickSet>('./clickSets/*.json', { eager: true, import: 'default' });

  it('finds the click sets', () => {
    expect(Object.keys(sets).length).toBeGreaterThan(0);
  });

  for (const [file, set] of Object.entries(sets)) {
    set.lines.forEach((raw, i) => {
      it(`fits ${file} line ${i + 1} to ${set.parts[i]} parts, worst within ${set.worst[i]} G, none red`, () => {
        const clicks = raw.map(([x, y]) => ({ x, y }));
        const line = fitTrack(clicks, traceOptions(set.gauge));
        expect(line?.fit.parts).toHaveLength(set.parts[i]);
        expect(worst(line!, clicks) / set.gauge).toBeLessThanOrEqual(Math.min(set.worst[i], 0.25));
      });
    });
  }
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

  it('makes each join a node, and splits an arc past 90° at its midpoint', () => {
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
});
