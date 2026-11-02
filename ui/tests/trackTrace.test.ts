import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TRACK_FIT, distances, fitTrack } from '../src/trackFit.js';
import { Trace, traceOptions } from '../src/trackTrace.js';
import { G, clicksAlong, offLine } from './trackClicks.js';

const opts = traceOptions(G);
const clicks = clicksAlong([{ straight: 20 }, { radius: 30, turn: 90 }, { straight: 20 }]);

describe('traceOptions', () => {
  it('converts the fit constants through DPT', () => {
    expect(opts).toEqual({ tolerance: TRACK_FIT.tolerance * G, minRadius: TRACK_FIT.minRadius * G });
  });
});

describe('Trace while tracing', () => {
  it('shows nothing but the click before the second, then the line of its clicks', () => {
    const t = new Trace();
    t.add(clicks[0], opts);
    expect(t.view(opts)).toEqual({ clicks: [clicks[0]], fit: null, red: [] });
    t.add(clicks[1], opts);
    expect(t.fit()?.parts).toHaveLength(1);
    expect(t.view(opts).clicks).toEqual(clicks.slice(0, 2));
  });

  it('shows after each click the line a replay of the clicks so far gives', () => {
    const t = new Trace();
    for (const [i, p] of clicks.entries()) {
      t.add(p, opts);
      expect(t.fit(), `after click ${i + 1}`).toEqual(Trace.replay(clicks.slice(0, i + 1), opts).fit());
    }
  });

  it('fits the straight, the arc and the straight within the tolerance, none red', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.fit()?.parts).toHaveLength(3);
    expect(t.view(opts).red).toEqual([]);
  });

  it('marks a click farther than the tolerance from the line red', () => {
    const t = Trace.replay(clicks, opts);
    const last = clicks.length - 1;
    // A click a gauge beside the line, on the end, where nothing reaches it.
    const stray = offLine(clicks[last], clicks[last - 1], clicks[last], 1);
    t.add({ x: clicks[last].x + 40, y: clicks[last].y }, opts);
    const n = t.clicks.length;
    t.add(stray, opts);
    const d = distances(t.fit()!, t.clicks);
    expect(t.view(opts).red).toEqual(d.flatMap((x, i) => (Math.abs(x) > opts.tolerance ? [i] : [])));
    expect(t.clicks).toHaveLength(n + 1);
  });
});

describe('Trace edits', () => {
  it('builds the line again from the moved clicks', () => {
    const t = Trace.replay(clicks, opts);
    const moved = clicks.map((p, i) => (i === 5 ? offLine(p, clicks[4], clicks[6], 0.2) : p));
    t.move(5, moved[5], opts);
    expect(t.clicks).toEqual(moved);
    expect(t.fit()).toEqual(fitTrack(moved, opts)?.fit);
  });

  it('builds the line again from the remaining clicks', () => {
    const t = Trace.replay(clicks, opts);
    t.remove(5, opts);
    expect(t.clicks).toEqual(clicks.filter((_, i) => i !== 5));
    expect(t.fit()).toEqual(fitTrack(t.clicks, opts)?.fit);
  });

  it('has no line once fewer than two clicks are left', () => {
    const t = Trace.replay(clicks.slice(0, 2), opts);
    t.remove(1, opts);
    expect(t.fit()).toBeNull();
    expect(t.view(opts)).toEqual({ clicks: [clicks[0]], fit: null, red: [] });
  });

  it('leaves a clone where it was', () => {
    const t = Trace.replay(clicks, opts);
    const kept = t.clone();
    t.remove(5, opts);
    expect(kept.clicks).toEqual(clicks);
    expect(kept.fit()).toEqual(Trace.replay(clicks, opts).fit());
  });
});

describe('Trace on the real clicks in clickSets/real-ceiling-2026-10-29b.json', () => {
  const set = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'clickSets/real-ceiling-2026-10-29b.json'), 'utf8')) as {
    gauge: number;
    lines: [number, number][][];
    clickOrder: (number[] | null)[];
  };
  const real = traceOptions(set.gauge);

  it('leaves no click red on either line in track order', () => {
    for (const line of set.lines) {
      const t = Trace.replay(
        line.map(([x, y]) => ({ x, y })),
        real
      );
      expect(t.view(real).red).toEqual([]);
    }
  });

  it('folds the second line back on itself in the order it was clicked, and marks clicks red', () => {
    const line2 = set.lines[1].map(([x, y]) => ({ x, y }));
    const t = Trace.replay(
      set.clickOrder[1]!.map(k => line2[k]),
      real
    );
    expect(t.view(real).red.length).toBeGreaterThan(0);
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
