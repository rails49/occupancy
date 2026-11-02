import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import { ahead, distances, extend, fitNodes, type Line } from '../src/trackFit.js';
import { Trace, traceOptions } from '../src/trackTrace.js';
import { G, along, clicksAlong, clicksAt, type Piece } from './trackClicks.js';

const opts = traceOptions(G);

/** The line built click by click over `clicks`; throws when a click does not go on it. */
function built(clicks: readonly Point[]): Line {
  let line: Line | null = null;
  for (let n = 1; n < clicks.length; n++) {
    const step = extend(line, clicks.slice(0, n), clicks[n], opts);
    if (step.kind !== 'added') throw new Error(`click ${n + 1} ${step.kind}`);
    line = step.line;
  }
  if (!line) throw new Error('no line');
  return line;
}

/**
 * Each part's radius in gauges. A refit straight's curvature is never exactly
 * 0, so a straight is a part whose radius is over 200 G: its sagitta over a
 * 40 G straight is under 1 G.
 */
function radii(line: Line): number[] {
  return line.fit.parts.map(p => {
    const r = 1 / Math.abs(p.curvature) / G;
    return r > 200 ? Infinity : r;
  });
}

/** How far the click farthest from the line lies, in gauges. */
function worst(line: Line, clicks: readonly Point[]): number {
  return Math.max(...distances(line, clicks)) / G;
}

/** The true point `gauges` along an arc of 30 G turning left. */
const ARC = [{ radius: 30, turn: 120 }];
const onArc = (gauges: number) => along(ARC, gauges);

describe('the first clicks of a line', () => {
  it('make a straight of two clicks, with a straight projection ahead', () => {
    const line = built([
      { x: 100, y: 100 },
      { x: 400, y: 500 },
    ]);
    const heading = Math.atan2(400, 300);
    expect(line.fit.start).toEqual({ x: 100, y: 100, heading });
    expect(line.fit.parts).toEqual([{ length: 500, curvature: 0 }]);
    const on = ahead(line);
    expect(on.start.x).toBeCloseTo(400, 6);
    expect(on.start.y).toBeCloseTo(500, 6);
    expect(on.start.heading).toBe(heading);
    expect(on.curvature).toBe(0);
  });

  it('make one arc through three clicks, which the projection follows', () => {
    const line = built([onArc(0), onArc(20), onArc(40)]);
    expect(line.fit.parts).toHaveLength(1);
    const [part] = line.fit.parts;
    expect(1 / part.curvature / G).toBeCloseTo(30, 6);
    expect(part.length / G).toBeCloseTo(40, 6);
    expect(line.fit.start.heading).toBeCloseTo(0.3, 6);
    expect(ahead(line).curvature).toBe(part.curvature);
  });
});

describe('a click within the tolerance', () => {
  it('continues a straight, refit over its clicks so their noise averages out', () => {
    const clicks = clicksAlong([{ straight: 40 }]);
    const line = built(clicks);
    expect(line.fit.parts).toHaveLength(1);
    expect(radii(line)[0]).toBeGreaterThan(200);
    expect(worst(line, clicks)).toBeLessThanOrEqual(0.5);
    // The refit heading is the straight's, not the first two clicks'.
    expect(line.fit.start.heading).toBeCloseTo(0.3, 2);
  });

  it('continues an arc, refit over its clicks to its radius', () => {
    const clicks = clicksAlong([{ radius: 30, turn: 120 }]);
    const line = built(clicks);
    expect(line.fit.parts).toHaveLength(1);
    expect(radii(line)[0]).toBeCloseTo(30, 0);
    expect(line.fit.parts[0].length / G).toBeCloseTo(Math.PI * 20, 0);
    expect(worst(line, clicks)).toBeLessThanOrEqual(0.5);
  });
});

describe('a click beyond the tolerance', () => {
  it('starts a new part at the last click, which one click bends and the projection follows', () => {
    const straight = clicksAlong([{ straight: 20 }], { noise: 0 });
    const into = along([{ straight: 20 }, { radius: 30, turn: 90 }], 26);
    const line = built([...straight, into]);
    expect(radii(line)).toHaveLength(2);
    expect(radii(line)[0]).toBe(Infinity);
    expect(radii(line)[1]).toBeCloseTo(30, 0);
    expect(line.fit.parts[1].length / G).toBeCloseTo(6, 2);
    expect(line.firstClick).toEqual([0, straight.length]);
    expect(ahead(line).curvature).toBe(line.fit.parts[1].curvature);
  });

  // Clicks where the curvature changes and about 10 G apart, as the rule
  // expects: radii in gauges, Infinity for a straight.
  const shapes: [string, Piece[], number[], number[]][] = [
    ['a straight into an arc', [{ straight: 20 }, { radius: 30, turn: 90 }], [0, 10, 20, 30, 40, 50, 60, 67.1], [Infinity, 30]],
    ['a reverse curve', [{ radius: 30, turn: 60 }, { radius: 30, turn: -60 }], [0, 10, 20, 31.4, 41.4, 51.4, 62.8], [30, 30]],
    [
      'a 180° curve',
      [{ straight: 15 }, { radius: 25, turn: 180 }, { straight: 15 }],
      [0, 7, 15, 25, 35, 45, 55, 65, 75, 85, 93.5, 100, 108.5],
      [Infinity, 25, Infinity],
    ],
  ];
  for (const [name, pieces, positions, expected] of shapes) {
    it(`traces ${name} as its parts, every click within the tolerance`, () => {
      const clicks = clicksAt(pieces, positions, { noise: 0 });
      const line = built(clicks);
      const got = radii(line);
      expect(got).toHaveLength(expected.length);
      got.forEach((r, i) => expect(r === expected[i] || Math.abs(r / expected[i] - 1) < 0.02).toBe(true));
      expect(worst(line, clicks)).toBeLessThanOrEqual(0.5);
    });
  }

  it('turns the way the track turns', () => {
    const line = built(clicksAt([{ radius: 30, turn: 60 }, { radius: 30, turn: -60 }], [0, 10, 20, 31.4, 41.4, 51.4, 62.8], { noise: 0 }));
    expect(line.fit.parts.map(p => Math.sign(p.curvature))).toEqual([1, -1]);
  });
});

describe('a click not ahead of the last click', () => {
  const straight = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 500, y: 100 },
  ];

  it('adds nothing: beside it, behind it, or on it', () => {
    const line = built(straight);
    for (const p of [{ x: 500, y: 140 }, { x: 400, y: 100 }, { x: 500, y: 100 }, { x: 100, y: 100 }]) {
      expect(extend(line, straight, p, opts)).toEqual({ kind: 'ignored' });
    }
  });

  it('adds nothing on an arc either, a click behind its start included', () => {
    const clicks = clicksAt(ARC, [0, 15, 30, 45], { noise: 0 });
    const line = built(clicks);
    expect(extend(line, clicks, onArc(40), opts)).toEqual({ kind: 'ignored' });
    expect(extend(line, clicks, along([{ radius: 30, turn: -120 }], 10), opts)).toEqual({ kind: 'ignored' });
  });

  it('goes on from the second click, which only a click on the first cannot', () => {
    expect(extend(null, [straight[0]], straight[0], opts)).toEqual({ kind: 'ignored' });
    expect(extend(null, [straight[0]], { x: 100, y: 300 }, opts).kind).toBe('added');
  });
});

describe('a click that needs a radius under the minimum', () => {
  it('is refused as the third click', () => {
    const clicks = [
      { x: 100, y: 100 },
      { x: 100 + 10 * G, y: 100 },
    ];
    const line = built(clicks);
    // The circle through the three has a radius of 7.5 G.
    expect(extend(line, clicks, { x: 100 + 11 * G, y: 100 + 10 * G }, opts)).toEqual({ kind: 'refused' });
    // Through a click farther on it has one of 35 G, which is allowed.
    expect(extend(line, clicks, { x: 100 + 40 * G, y: 100 + 30 * G }, opts).kind).toBe('added');
  });

  it('is refused as the first click of a new part, and the line stays as it was', () => {
    const clicks = clicksAt([{ straight: 30 }], [0, 10, 20, 30], { noise: 0 });
    const line = built(clicks);
    const tight = along([{ straight: 30 }, { radius: 10, turn: 90 }], 40);
    expect(extend(line, clicks, tight, opts)).toEqual({ kind: 'refused' });
    const wide = along([{ straight: 30 }, { radius: 20, turn: 90 }], 50);
    const step = extend(line, clicks, wide, opts);
    expect(step.kind).toBe('added');
    if (step.kind === 'added') expect(radii(step.line)).toEqual([Infinity, expect.closeTo(20, 1)]);
  });
});

describe('a loop of one radius', () => {
  it('clicked round 297° is one part', () => {
    const positions = Array.from({ length: 10 }, (_, i) => i * 19);
    const clicks = clicksAt([{ radius: 33, turn: 300 }], positions);
    const line = built(clicks);
    expect(radii(line)).toEqual([expect.closeTo(33, 0)]);
    expect((line.fit.parts[0].length / G / 33 / Math.PI) * 180).toBeCloseTo(297, 0);
    expect(worst(line, clicks)).toBeLessThanOrEqual(0.5);
  });
});

/**
 * A click set in tests/clickSets, the rule's regression suite: `gauge`,
 * `lines` of clicks `[x, y]` in image pixels in the order made, the part
 * count the rule gives each line, and a `note` saying where the clicks came
 * from. Today there is one set, synthetic. A set recorded in the editor is a
 * file dropped into the directory; the suite finds it.
 */
interface ClickSet {
  readonly note: string;
  readonly gauge: number;
  readonly lines: readonly (readonly [number, number])[][];
  readonly parts: readonly number[];
}

describe('the click sets in tests/clickSets', () => {
  const sets = import.meta.glob<ClickSet>('./clickSets/*.json', { eager: true, import: 'default' });

  it('are found', () => {
    expect(Object.keys(sets).length).toBeGreaterThan(0);
  });

  for (const [file, set] of Object.entries(sets)) {
    set.lines.forEach((raw, i) => {
      it(`${file} line ${i + 1}: ${set.parts[i]} parts over its ${raw.length} clicks, every one on the line within the tolerance`, () => {
        const t = Trace.replay(
          raw.map(([x, y]) => ({ x, y })),
          traceOptions(set.gauge)
        );
        expect(t.line?.fit.parts).toHaveLength(set.parts[i]);
        expect(t.clicks).toHaveLength(raw.length);
        expect(Math.max(...distances(t.line!, t.clicks)) / set.gauge).toBeLessThanOrEqual(0.5);
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
