import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import fs from 'node:fs';
import path from 'node:path';
import { fitTrack, nearestParts, type Fit, type FitResult, type Join } from '../src/trackFit.js';
import { Trace, tailMarks, traceOptions } from '../src/trackTrace.js';
import { G, TEN_PARTS, clicksAlong, offLine } from './trackClicks.js';

const opts = traceOptions(G);
const clicks = clicksAlong([{ straight: 20 }, { radius: 30, turn: 90 }, { straight: 20 }]);

/** What a trace shows: its committed line and its live tail. */
function shown(t: Trace) {
  return { fit: t.committedFit(), joins: t.committedJoins, live: t.live?.fit ?? null, firstLive: t.firstLive };
}

/** A trace of `points`, clicked one by one, with what it showed after each click. */
function traced(points: readonly Point[]) {
  const t = new Trace();
  const after = points.map(p => {
    t.add(p, opts);
    return structuredClone(shown(t));
  });
  return { t, after };
}

describe('Trace while tracing', () => {
  it('commits joins in order, each once it and every join before it have σ under the commit σ, and never moves them', () => {
    const { after } = traced(clicks);
    let before = after[0];
    for (const now of after.slice(1)) {
      const n = before.fit?.parts.length ?? 0;
      expect(now.fit?.parts.length ?? 0).toBeGreaterThanOrEqual(n);
      if (before.fit) {
        expect(now.fit?.start).toEqual(before.fit.start);
        expect(now.fit?.parts.slice(0, n)).toEqual(before.fit.parts);
      }
      for (const j of now.joins.slice(1)) expect(j.sigma).toBeLessThanOrEqual(opts.commitSigma);
      before = now;
    }
    // The straight and the arc commit before the line ends.
    expect(before.fit?.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('shows after undo what it showed before the undone click', () => {
    const { after } = traced(clicks);
    for (let n = 2; n < clicks.length; n++) {
      expect(shown(Trace.replay(clicks.slice(0, n), opts))).toEqual(after[n - 1]);
    }
  });

  it('uncommits on undo a join that only the undone click pinned', () => {
    const { after } = traced(clicks);
    const k = after.findIndex(s => s.fit !== null);
    expect(k).toBeGreaterThan(0);
    const undone = Trace.replay(clicks.slice(0, k), opts);
    expect(undone.committedFit()).toBeNull();
  });
});

describe('Trace on a long line clicked every 2 G', () => {
  const line = clicksAlong(TEN_PARTS, { spacing: 2, seed: 7 });

  // Every tenth click and the last also time the whole-line fit its entry writes; every click would
  // take the test past a minute.
  it('commits joins in order, and takes under half a second a click with the whole-line fit', () => {
    expect(line).toHaveLength(166);
    const t = new Trace();
    for (const [i, p] of line.entries()) {
      const t0 = performance.now();
      t.add(p, opts);
      if (i % 10 === 0 || i === line.length - 1) fitTrack(t.clicks, opts);
      expect(performance.now() - t0).toBeLessThan(500);
      for (const j of t.committedJoins.slice(1)) expect(j.sigma).toBeLessThanOrEqual(opts.commitSigma);
    }
    const res = fitTrack(line, opts);
    expect(res?.fit.parts).toHaveLength(10);
    expect(res?.worst).toBeLessThanOrEqual(opts.tolerance);
    // Every join but the one before the last part has clicks enough on both sides to commit.
    expect(t.committed).toHaveLength(9);
  }, 20_000);
});

describe('Trace on a compound curve, arcs of 30, 34 and 38 G clicked every 5 G', () => {
  const clicks = clicksAlong([{ radius: 30, turn: 60 }, { radius: 34, turn: 60 }, { radius: 38, turn: 60 }], { spacing: 5 });

  it('commits the first two arcs, in order', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.committed).toHaveLength(2);
    for (const j of t.committedJoins.slice(1)) expect(j.sigma).toBeLessThanOrEqual(opts.commitSigma);
  });
});

describe('Trace on seven sparse clicks, 15 G apart, on a straight, a 90° curve and a straight', () => {
  const clicks = clicksAlong([{ straight: 25 }, { radius: 30, turn: 90 }, { straight: 25 }], { spacing: 15 });

  it('commits nothing, and draws every live part with a bar at each join', () => {
    const t = Trace.replay(clicks, opts);
    expect(t.committedFit()).toBeNull();
    const m = t.live?.fit.parts.length ?? 0;
    expect(m).toBeGreaterThanOrEqual(2);
    const { parts, bars } = tailMarks(t.live, opts.barCap);
    expect(parts).toHaveLength(m);
    expect(bars).toHaveLength(m - 1);
  });
});

describe('Trace on the real clicks in clickSets/real-ceiling-2026-10-29b.json', () => {
  const set = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'clickSets/real-ceiling-2026-10-29b.json'), 'utf8')) as {
    gauge: number;
    lines: [number, number][][];
  };
  const real = traceOptions(set.gauge);
  const clicks = set.lines[0].map(([x, y]) => ({ x, y }));

  // From click 8 the tail has two parts; before that the live line is one part from the free start.
  it('draws every live part after every click from the eighth on', () => {
    const t = new Trace();
    for (const [i, p] of clicks.entries()) {
      t.add(p, real);
      if (i < 7 || !t.live) continue;
      const { parts } = tailMarks(t.live, real.barCap);
      expect(parts, `after click ${i + 1}`).toHaveLength(t.live.fit.parts.length);
    }
  });
});

describe('Trace edits to committed clicks', () => {
  // The last part of a tail never commits, so five parts commit four.
  const clicks = clicksAlong([
    { straight: 20 },
    { radius: 30, turn: 90 },
    { straight: 20 },
    { radius: 30, turn: -90 },
    { straight: 20 },
  ]);
  const before = Trace.replay(clicks, opts);
  const fit = before.committedFit();
  if (!fit) throw new Error('nothing committed');
  /** The middle committed click of committed part 2, the second straight. */
  const owners = nearestParts(fit, clicks.slice(0, before.firstLive));
  const onPart2 = owners.indexOf(2) + Math.floor(owners.filter(o => o === 2).length / 2);

  it('has four parts committed to edit', () => {
    expect(fit.parts).toHaveLength(4);
    expect(owners.indexOf(2)).toBeGreaterThan(0);
  });

  /** Committed part 0 stays; part 1 on is refit. */
  function expectUncommittedFromPart1(t: Trace) {
    const now = t.committedFit();
    expect(now?.start).toEqual(fit?.start);
    expect(now?.parts[0]).toEqual(fit?.parts[0]);
    expect(t.committed[1]).not.toEqual(fit?.parts[1]);
  }

  it('uncommits back to the part before a moved click', () => {
    const t = Trace.replay(clicks, opts);
    t.move(onPart2, offLine(clicks[onPart2], clicks[onPart2 - 1], clicks[onPart2 + 1], 0.2), opts);
    expectUncommittedFromPart1(t);
  });

  it('uncommits back to the part before a deleted click', () => {
    const t = Trace.replay(clicks, opts);
    t.remove(onPart2, opts);
    expect(t.clicks).toHaveLength(clicks.length - 1);
    expectUncommittedFromPart1(t);
  });

  it('keeps every committed part when a live click moves', () => {
    const t = Trace.replay(clicks, opts);
    const last = clicks.length - 1;
    t.move(last, offLine(clicks[last], clicks[last - 1], clicks[last], 0.1), opts);
    expect(t.committedFit()?.start).toEqual(fit.start);
    expect(t.committed.slice(0, fit.parts.length)).toEqual(fit.parts);
  });
});

describe('Trace when finished', () => {
  it('is the whole-line fit of its clicks', () => {
    const t = Trace.finished(clicks, opts);
    expect(t.committedFit()).toEqual(fitTrack(clicks, opts)?.fit);
    expect(t.live).toBeNull();
  });

  it('gives the same line for the same clicks', () => {
    const a = Trace.finished(clicks, opts);
    // Deleted, then clicked again on the line: inserted where it projects, so the clicks are the same.
    const b = Trace.finished(clicks, opts);
    b.remove(5, opts);
    b.add(clicks[5], opts);
    expect(b.clicks).toEqual(a.clicks);
    expect(b.committedFit()).toEqual(a.committedFit());
  });
});

describe('tailMarks', () => {
  /** A straight tail from (x, 0) heading along +x, one part per length, its joins carrying `sigmas`. */
  function tail(x: number, lengths: readonly number[], sigmas: readonly number[]): FitResult {
    const fit: Fit = { start: { x, y: 0, heading: 0 }, parts: lengths.map(length => ({ length, curvature: 0 })) };
    const joins: Join[] = sigmas.map((sigma, i) => ({ x: x + lengths.slice(0, i).reduce((a, b) => a + b, 0), y: 0, heading: 0, sigma, margin: 0 }));
    return { fit, residuals: [], partOf: [], worst: 0, rms: 0, joins, outliers: [] };
  }

  it('draws nothing with no tail', () => {
    expect(tailMarks(null, 40)).toEqual({ parts: [], bars: [] });
  });

  it('draws each part whose joins both have σ under the cap', () => {
    const { parts } = tailMarks(tail(0, [100, 100, 100], [1, 3, 40, 2]), 40);
    expect(parts).toEqual([{ start: { x: 0, y: 0, heading: 0 }, parts: [{ length: 100, curvature: 0 }] }]);
  });

  it('puts a bar across each join where two parts meet, half-length σ, none at the start or end', () => {
    const { bars } = tailMarks(tail(0, [100, 100, 100], [5, 3, 4, 2]), 40);
    expect(bars).toEqual([
      { from: { x: 100, y: -3 }, to: { x: 100, y: 3 } },
      { from: { x: 200, y: -4 }, to: { x: 200, y: 4 } },
    ]);
  });

  it('puts no bar at a join neither of whose parts is drawn', () => {
    const { bars } = tailMarks(tail(0, [100, 100, 100], [5, 3, 50, 2]), 40);
    expect(bars).toEqual([{ from: { x: 100, y: -3 }, to: { x: 100, y: 3 } }]);
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
