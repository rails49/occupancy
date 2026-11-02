import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TRACK_FIT, distances } from '../src/trackFit.js';
import { Trace, traceOptions } from '../src/trackTrace.js';
import { G, along, clicksAt } from './trackClicks.js';

const opts = traceOptions(G);
const PIECES = [{ straight: 20 }, { radius: 30, turn: 90 }, { straight: 20 }];
const clicks = clicksAt(PIECES, [0, 10, 20, 30, 40, 50, 60, 67.1, 77, 87.1], { noise: 0 });

describe('traceOptions', () => {
  it("converts the fit's three constants through DPT", () => {
    expect(opts).toEqual({ tolerance: 0.5 * G, minRadius: 15 * G, projection: 20 * G });
    expect(TRACK_FIT).toEqual({ tolerance: 0.5, minRadius: 15, projection: 20, startDistance: 1 });
  });
});

describe('Trace while tracing', () => {
  it('shows the first click alone, then the line of its clicks with the projection ahead', () => {
    const t = new Trace();
    expect(t.add(clicks[0], opts)).toBe('added');
    expect(t.view(opts)).toEqual({ clicks: [clicks[0]], fit: null, projection: null });
    expect(t.add(clicks[1], opts)).toBe('added');
    const view = t.view(opts);
    expect(view.clicks).toEqual(clicks.slice(0, 2));
    expect(view.fit?.parts).toEqual([{ length: expect.closeTo(10 * G, 6), curvature: 0 }]);
    expect(view.projection?.parts).toEqual([{ length: 20 * G, curvature: 0 }]);
    expect(view.projection?.start.x).toBeCloseTo(clicks[1].x, 6);
    expect(view.projection?.start.y).toBeCloseTo(clicks[1].y, 6);
  });

  it('shows after each click the line a replay of the clicks so far gives', () => {
    const t = new Trace();
    for (const [i, p] of clicks.entries()) {
      t.add(p, opts);
      expect(t.view(opts), `after click ${i + 1}`).toEqual(Trace.replay(clicks.slice(0, i + 1), opts).view(opts));
    }
  });

  it('traces the straight, the arc and the straight as three parts, every click within the tolerance', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.line?.fit.parts).toHaveLength(3);
    expect(t.line?.firstClick).toEqual([0, 3, 8]);
    expect(Math.max(...distances(t.line!, t.clicks))).toBeLessThanOrEqual(opts.tolerance);
  });

  it('adds nothing for a click on the last click, beside it or behind it', () => {
    const t = Trace.replay(clicks, opts);
    const last = clicks[clicks.length - 1];
    const before = t.view(opts);
    for (const p of [last, { x: last.x + 30, y: last.y - 100 }, clicks[clicks.length - 2]]) {
      expect(t.add(p, opts)).toBe('ignored');
    }
    expect(t.view(opts)).toEqual(before);
  });

  it('refuses a click that needs an arc tighter than the minimum, and keeps the line', () => {
    const t = Trace.replay(clicks, opts);
    const before = t.view(opts);
    expect(t.add(along(PIECES.concat({ radius: 8, turn: 90 }), 93), opts)).toBe('refused');
    expect(t.view(opts)).toEqual(before);
  });
});

describe('Trace edits', () => {
  it('builds the line again from the moved clicks', () => {
    const t = Trace.replay(clicks, opts);
    const moved = clicks.map((p, i) => (i === 5 ? { x: p.x + 3, y: p.y - 4 } : p));
    expect(t.move(5, moved[5], opts)).toBe(true);
    expect(t.clicks).toEqual(moved);
    expect(t.view(opts)).toEqual(Trace.replay(moved, opts).view(opts));
  });

  it('builds the line again from the remaining clicks', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.remove(5, opts)).toBe(true);
    expect(t.clicks).toEqual(clicks.filter((_, i) => i !== 5));
    expect(t.view(opts)).toEqual(Trace.replay(t.clicks, opts).view(opts));
  });

  it('refuses a move that leaves a click off the line, and keeps the line', () => {
    const t = Trace.replay(clicks, opts);
    const before = t.view(opts);
    // The fourth click 4 G across, 10 G on from the straight's end: a 13 G arc, which the fifth click then cannot follow.
    const across = along([{ straight: 20 }, { radius: 13, turn: 90 }], 30);
    expect(t.move(3, across, opts)).toBe(false);
    expect(t.view(opts)).toEqual(before);
  });

  it('refuses a delete the same way', () => {
    const tight = clicksAt([{ straight: 20 }, { radius: 16, turn: 90 }], [0, 10, 20, 28, 36, 44], { noise: 0 });
    const t = Trace.replay(tight, opts);
    expect(t.clicks).toHaveLength(6);
    const before = t.view(opts);
    // Without the click where the curve starts, the first click into it bends a wide arc from the straight's
    // last click, and the next needs an arc of 8 G from where that one ends.
    expect(t.remove(2, opts)).toBe(false);
    expect(t.view(opts)).toEqual(before);
  });

  it('has no line once fewer than two clicks are left', () => {
    const t = Trace.replay(clicks.slice(0, 2), opts);
    expect(t.remove(1, opts)).toBe(true);
    expect(t.view(opts)).toEqual({ clicks: [clicks[0]], fit: null, projection: null });
  });

  it('leaves a clone where it was', () => {
    const t = Trace.replay(clicks, opts);
    const kept = t.clone();
    t.remove(5, opts);
    expect(kept.clicks).toEqual(clicks);
    expect(kept.view(opts)).toEqual(Trace.replay(clicks, opts).view(opts));
  });
});

describe('Trace on the real clicks in clickSets/real-ceiling-2026-10-29b.json', () => {
  const set = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'clickSets/real-ceiling-2026-10-29b.json'), 'utf8')) as {
    gauge: number;
    lines: [number, number][][];
    clickOrder: (number[] | null)[];
  };
  const real = traceOptions(set.gauge);

  it('adds nothing for the two clicks back along the second line, in the order they were made', () => {
    const line2 = set.lines[1].map(([x, y]) => ({ x, y }));
    const order = set.clickOrder[1]!;
    const t = Trace.replay(
      order.slice(0, -2).map(k => line2[k]),
      real
    );
    const before = t.view(opts);
    expect(order.slice(-2).map(k => t.add(line2[k], real))).toEqual(['ignored', 'ignored']);
    expect(t.view(opts)).toEqual(before);
  });
});

describe('the fit and trace modules', () => {
  it('import nothing but the r49 types and each other, so no DOM and no Lit', () => {
    for (const file of ['trackFit.ts', 'trackTrace.ts', 'track.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8');
      const from = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
      for (const f of from) expect(['@rails49/r49', './track.js', './trackFit.js']).toContain(f);
    }
  });
});
