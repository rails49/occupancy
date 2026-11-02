import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import fs from 'node:fs';
import path from 'node:path';
import { fitTrack, nearestParts } from '../src/trackFit.js';
import { Trace, traceOptions } from '../src/trackTrace.js';
import { G, clicksAlong, offLine } from './trackClicks.js';

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
  it('commits up to a join once its σ is under the commit σ, and never moves what it committed', () => {
    const { after } = traced(clicks);
    let before = after[0];
    for (const now of after.slice(1)) {
      const n = before.fit?.parts.length ?? 0;
      expect(now.fit?.parts.length ?? 0).toBeGreaterThanOrEqual(n);
      if (before.fit) {
        expect(now.fit?.start).toEqual(before.fit.start);
        expect(now.fit?.parts.slice(0, n)).toEqual(before.fit.parts);
      }
      if (now.joins.length > 1) expect(now.joins[now.joins.length - 1].sigma).toBeLessThanOrEqual(opts.commitSigma);
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
  // Ten parts, 330 G: a click every 2 G is 166 clicks.
  const line = clicksAlong(
    [
      { straight: 35 },
      { radius: 20, turn: 90 },
      { straight: 30 },
      { radius: 30, turn: -60 },
      { straight: 40 },
      { radius: 40, turn: 45 },
      { radius: 15, turn: -120 },
      { straight: 35 },
      { radius: 25, turn: 72 },
      { straight: 33 },
    ],
    { spacing: 2, seed: 7 }
  );

  it('leaves no join under the commit σ uncommitted, and commits all but its last part or two', () => {
    expect(line).toHaveLength(166);
    const t = new Trace();
    for (const p of line) {
      t.add(p, opts);
      const loose = t.live?.joins.slice(1, -1) ?? [];
      expect(loose.every(j => j.sigma > opts.commitSigma)).toBe(true);
    }
    expect(t.committed.length).toBeGreaterThanOrEqual(8);
    expect(t.live?.fit.parts.length).toBeLessThanOrEqual(2);
  });

  it('takes under 100 ms a click to trace it and to fit the whole line', () => {
    /** The least of three timings of `f`, so a pause of the test runner does not count. */
    const timed = (f: () => void) =>
      Math.min(
        ...[0, 1, 2].map(() => {
          const t0 = performance.now();
          f();
          return performance.now() - t0;
        })
      );
    const t = new Trace();
    for (const p of line) {
      const t0 = performance.now();
      t.add(p, opts);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(timed(() => t.lineFit(opts))).toBeLessThan(100);
    }
    const res = t.lineFit(opts);
    expect(res?.fit.parts).toHaveLength(10);
    expect(res?.worst).toBeLessThanOrEqual(opts.tolerance);
  });
});

describe('Trace edits to committed clicks', () => {
  // The last part of a tail never commits, so five parts commit three.
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

  it('has three parts committed to edit', () => {
    expect(fit.parts).toHaveLength(3);
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
    const t = Trace.replay(clicks, opts, true);
    expect(t.committedFit()).toEqual(fitTrack(clicks, opts)?.fit);
    expect(t.live).toBeNull();
  });

  it('gives the same line for the same clicks', () => {
    const a = Trace.replay(clicks, opts, true);
    // Deleted, then clicked again on the line: inserted where it projects, so the clicks are the same.
    const b = Trace.replay(clicks, opts, true);
    b.remove(5, opts);
    b.add(clicks[5], opts);
    expect(b.clicks).toEqual(a.clicks);
    expect(b.committedFit()).toEqual(a.committedFit());
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
