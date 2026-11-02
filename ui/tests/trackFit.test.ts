import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import { fitNodes, fitTrack, sampleFit, type FitResult } from '../src/trackFit.js';
import { traceOptions } from '../src/trackTrace.js';
import { G, TEN_PARTS, clicksAlong, offLine, type Piece } from './trackClicks.js';

const opts = traceOptions(G);
const TOLERANCE = 0.25 * G;

function fit(clicks: readonly Point[]): FitResult {
  const res = fitTrack(clicks, opts);
  if (!res) throw new Error('no fit');
  return res;
}

/** Each part's radius in gauges, Infinity for a straight. */
function radii(res: FitResult): number[] {
  return res.fit.parts.map(p => (p.curvature === 0 ? Infinity : 1 / Math.abs(p.curvature) / G));
}

/** Distance from `p` to the fitted line, measured on a dense sampling of it. */
function distanceTo(res: FitResult, p: Point): number {
  const line = sampleFit(res.fit, 0.05 * G, 0);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y)));
  }
  return best;
}

/**
 * Each part, run from the join at its start, ends at the next join with the
 * next join's heading: the parts meet without a gap or a kink.
 */
function expectTangent(res: FitResult) {
  res.fit.parts.forEach((part, i) => {
    const a = res.joins[i];
    const b = res.joins[i + 1];
    const k = part.curvature;
    const h = a.heading + k * part.length;
    const x = k === 0 ? a.x + part.length * Math.cos(a.heading) : a.x + (Math.sin(h) - Math.sin(a.heading)) / k;
    const y = k === 0 ? a.y + part.length * Math.sin(a.heading) : a.y - (Math.cos(h) - Math.cos(a.heading)) / k;
    expect(Math.hypot(x - b.x, y - b.y)).toBeLessThan(1e-6 * G);
    expect(Math.abs(h - b.heading)).toBeLessThan(1e-9);
  });
}

describe('fitTrack', () => {
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
        const res = fit(clicksAlong(pieces, { spacing }));
        const got = radii(res);
        expect(got).toHaveLength(expected.length);
        // Radii within 5%.
        got.forEach((r, i) => expect(r === expected[i] || Math.abs(r / expected[i] - 1) < 0.05).toBe(true));
        expect(res.worst).toBeLessThanOrEqual(TOLERANCE);
        expect(res.outliers).toEqual([]);
        expectTangent(res);
      });
    }
  }

  it('turns the way the track turns', () => {
    const res = fit(clicksAlong([{ radius: 30, turn: 60 }, { radius: 30, turn: -60 }]));
    expect(res.fit.parts.map(p => Math.sign(p.curvature))).toEqual([1, -1]);
  });

  it('reports an inner click past the end of the line at its distance, not along the line', () => {
    // Out 15 G and three clicks back.
    const there = clicksAlong([{ straight: 15 }]);
    const clicks = [...there, ...[...there].reverse().slice(1, 4)];
    const res = fit(clicks);
    // The ends may lie on the line extended; every other click is measured to the line itself.
    clicks.slice(1, -1).forEach((p, i) => expect(Math.abs(res.residuals[i + 1])).toBeCloseTo(distanceTo(res, p), 0));
  });
});

describe('fitTrack with a bad click', () => {
  const straight = clicksAlong([{ straight: 30 }]);
  const arc = clicksAlong([{ radius: 30, turn: 90 }]);
  /** `clicks` with click `i` moved `gauges` across the track. */
  const moved = (clicks: readonly Point[], gauges: number, ...at: number[]) =>
    clicks.map((p, i) => (at.includes(i) ? offLine(p, clicks[i - 1] ?? p, clicks[i + 1] ?? p, gauges) : p));

  it('leaves out a lone bad click on a straight', () => {
    const res = fit(moved(straight, 1, 4));
    expect(res.outliers).toEqual([4]);
    expect(radii(res)).toEqual([Infinity]);
    expect(res.worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('leaves out a lone bad click inside an arc', () => {
    const res = fit(moved(arc, 1, 7));
    expect(res.outliers).toEqual([7]);
    expect(res.fit.parts).toHaveLength(1);
    expect(res.worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('fits through a bad end click', () => {
    const clicks = moved(straight, 1, straight.length - 1);
    const res = fit(clicks);
    expect(res.outliers).toEqual([]);
    expect(Math.abs(res.residuals[clicks.length - 1])).toBeLessThanOrEqual(TOLERANCE);
  });

  it('splits at two bad clicks in a row rather than leaving them out', () => {
    const res = fit(moved(straight, 1, 4, 5));
    expect(res.outliers).toEqual([]);
    expect(res.fit.parts.length).toBeGreaterThan(1);
  });
});

describe('fitTrack on the sparse and dense cases that once collapsed the solver', () => {
  /** Every part within the bounds, every click within the tolerance, none left out. */
  function expectSound(res: FitResult) {
    for (const p of res.fit.parts) {
      expect(p.length).toBeGreaterThanOrEqual(G);
      expect(Math.abs(p.curvature)).toBeLessThanOrEqual(1 / (10 * G));
      expect(Math.abs(p.curvature * p.length)).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
    expect(res.worst).toBeLessThanOrEqual(TOLERANCE);
    expect(res.outliers).toEqual([]);
  }

  it('fits seven sparse clicks, 15 G apart, on a straight, a 90° curve and a straight', () => {
    const clicks = clicksAlong([{ straight: 25 }, { radius: 30, turn: 90 }, { straight: 25 }], { spacing: 15 });
    expect(clicks).toHaveLength(7);
    expectSound(fit(clicks));
  });

  it('fits a dense loop, a click every 1.5 G around a 32 G circle, as arcs of that radius', () => {
    const res = fit(clicksAlong([{ radius: 32, turn: 360 }], { spacing: 1.5 }));
    expectSound(res);
    for (const r of radii(res)) expect(Math.abs(r / 32 - 1)).toBeLessThan(0.05);
  });
});

describe('fitTrack on a long line clicked every 2 G', () => {
  const line = clicksAlong(TEN_PARTS, { spacing: 2, seed: 7 });

  it('fits every prefix from 20 clicks on within the tolerance', () => {
    for (let n = 20; n <= line.length; n++) {
      expect(fit(line.slice(0, n)).worst, `${n} clicks`).toBeLessThanOrEqual(TOLERANCE);
    }
  }, 30_000);

  // A finished line refits whole on every edit. Timed with room for a slow machine.
  it('fits the whole line, 166 clicks, in under 400 ms', () => {
    const times = [0, 1, 2].map(() => {
      const t0 = performance.now();
      fit(line);
      return performance.now() - t0;
    });
    expect(Math.min(...times)).toBeLessThan(400);
  });
});

describe('fitTrack on clicks nothing fits', () => {
  /** Clicks scattered at random over a 3000 px square, seeded. */
  function scatter(n: number): Point[] {
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n }, () => ({ x: next() * 3000, y: next() * 3000 }));
  }

  // The bound: two segmentations and at most two refits. Timed with room for a slow machine.
  for (const [n, ms] of [[40, 500], [160, 1000]]) {
    it(`returns within ${ms} ms for ${n} scattered clicks`, () => {
      const t0 = performance.now();
      const res = fit(scatter(n));
      expect(performance.now() - t0).toBeLessThan(ms);
      expect(res.worst).toBeGreaterThan(TOLERANCE);
    });
  }
});

/**
 * A click set as the prototype's copy key wrote it, `{ gauge, lines, finished }`
 * with each click `[x, y]` in image pixels, plus what its lines fit to when it
 * was recorded: the part count and the worst error in gauges.
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
    set.lines.forEach((line, i) => {
      it(`fits ${file} line ${i + 1} to ${set.parts[i]} parts, worst within ${set.worst[i]} G`, () => {
        const res = fitTrack(
          line.map(([x, y]) => ({ x, y })),
          traceOptions(set.gauge)
        );
        expect(res?.fit.parts).toHaveLength(set.parts[i]);
        expect((res?.worst ?? Infinity) / set.gauge).toBeLessThanOrEqual(Math.min(set.worst[i], 0.25));
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
