import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TRACK_FIT, distances } from '../src/trackFit.js';
import { Trace, traceOptions } from '../src/trackTrace.js';
import { G, along, clicksAt, tightClicks, tooTight } from './trackClicks.js';

const opts = traceOptions(G);
const PIECES = [{ straight: 20 }, { radius: 30, turn: 90 }, { straight: 20 }];
const clicks = clicksAt(PIECES, [0, 10, 20, 30, 40, 50, 60, 67.1, 77, 87.1], { noise: 0 });

describe('traceOptions', () => {
  it("converts the fit's two constants through DPT", () => {
    expect(opts).toEqual({ tolerance: 0.5 * G, minRadius: 15 * G });
    expect(TRACK_FIT).toEqual({ tolerance: 0.5, minRadius: 15, startDistance: 1 });
  });
});

describe('Trace while tracing', () => {
  it('shows the first click alone, then the line of its clicks and where it goes on from', () => {
    const t = new Trace();
    expect(t.add(clicks[0], opts)).toBe('added');
    expect(t.view()).toEqual({ clicks: [clicks[0]], partStarts: [], fit: null, ahead: null });
    expect(t.add(clicks[1], opts)).toBe('added');
    const view = t.view();
    expect(view.clicks).toEqual(clicks.slice(0, 2));
    expect(view.partStarts).toEqual([]);
    expect(view.fit?.parts).toEqual([{ length: expect.closeTo(10 * G, 6), curvature: 0 }]);
    expect(view.ahead?.curvature).toBe(0);
    expect(view.ahead?.start.x).toBeCloseTo(clicks[1].x, 6);
    expect(view.ahead?.start.y).toBeCloseTo(clicks[1].y, 6);
  });

  it('shows after each click the line a replay of the clicks so far gives', () => {
    const t = new Trace();
    for (const [i, p] of clicks.entries()) {
      t.add(p, opts);
      expect(t.view(), `after click ${i + 1}`).toEqual(Trace.replay(clicks.slice(0, i + 1), opts).view());
    }
  });

  it('traces the straight, the arc and the straight as three parts, every click within the tolerance', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.line?.fit.parts).toHaveLength(3);
    expect(t.line?.firstClick).toEqual([0, 3, 8]);
    expect(t.view().partStarts).toEqual([3, 8]);
    expect(Math.max(...distances(t.line!, t.clicks))).toBeLessThanOrEqual(opts.tolerance);
  });

  it('adds nothing for a click on the last click, beside it or behind it', () => {
    const t = Trace.replay(clicks, opts);
    const last = clicks[clicks.length - 1];
    const before = t.view();
    for (const p of [last, { x: last.x + 30, y: last.y - 100 }, clicks[clicks.length - 2]]) {
      expect(t.add(p, opts)).toBe('ignored');
    }
    expect(t.view()).toEqual(before);
  });

  it('refuses a click that needs an arc tighter than the minimum, and keeps the line', () => {
    const t = Trace.replay(clicks, opts);
    const before = t.view();
    expect(t.add(along(PIECES.concat({ radius: 8, turn: 90 }), 93), opts)).toBe('refused');
    expect(t.view()).toEqual(before);
  });
});

describe('Trace edits', () => {
  it('builds the line again from the moved clicks', () => {
    const t = Trace.replay(clicks, opts);
    const moved = clicks.map((p, i) => (i === 5 ? { x: p.x + 3, y: p.y - 4 } : p));
    expect(t.move(5, moved[5], opts)).toBe('added');
    expect(t.clicks).toEqual(moved);
    expect(t.view()).toEqual(Trace.replay(moved, opts).view());
  });

  it('builds the line again from the remaining clicks', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.remove(5, opts)).toBe('added');
    expect(t.clicks).toEqual(clicks.filter((_, i) => i !== 5));
    expect(t.view()).toEqual(Trace.replay(t.clicks, opts).view());
  });

  it('refuses a move that leaves a click off the line, and keeps the line', () => {
    const t = Trace.replay(clicks, opts);
    const before = t.view();
    expect(t.move(3, tooTight(), opts)).toBe('refused');
    expect(t.view()).toEqual(before);
  });

  it('refuses a delete the same way', () => {
    const t = Trace.replay(tightClicks(), opts);
    expect(t.clicks).toHaveLength(6);
    const before = t.view();
    expect(t.remove(2, opts)).toBe('refused');
    expect(t.view()).toEqual(before);
  });

  it('has no line once fewer than two clicks are left', () => {
    const t = Trace.replay(clicks.slice(0, 2), opts);
    expect(t.remove(1, opts)).toBe('added');
    expect(t.view()).toEqual({ clicks: [clicks[0]], partStarts: [], fit: null, ahead: null });
  });

  it('leaves a clone where it was', () => {
    const t = Trace.replay(clicks, opts);
    const kept = t.clone();
    t.remove(5, opts);
    expect(kept.clicks).toEqual(clicks);
    expect(kept.view()).toEqual(Trace.replay(clicks, opts).view());
  });
});

describe('Trace on clicks back along the line', () => {
  it('adds nothing for two clicks between earlier clicks, made after the far end', () => {
    const t = Trace.replay(clicks, opts);
    const before = t.view();
    expect([along(PIECES, 72), along(PIECES, 25)].map(p => t.add(p, opts))).toEqual(['ignored', 'ignored']);
    expect(t.view()).toEqual(before);
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
