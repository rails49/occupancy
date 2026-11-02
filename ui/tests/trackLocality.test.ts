import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import type { Fit } from '../src/trackFit.js';
import { Trace, traceOptions } from '../src/trackTrace.js';

/**
 * The line is a function of its clicks in order, built by solving the window
 * at the end of the line for each click in turn (SPEC § Track centerlines).
 * These checks hold for every recorded click set, in track order.
 */
interface ClickSet {
  readonly gauge: number;
  readonly lines: readonly (readonly [number, number])[][];
}

const sets = import.meta.glob<ClickSet>('./clickSets/*.json', { eager: true, import: 'default' });

/** The line a trace draws. */
function line(t: Trace): Fit | null {
  return t.fit();
}

for (const [file, set] of Object.entries(sets)) {
  const opts = traceOptions(set.gauge);
  set.lines.forEach((raw, li) => {
    const clicks: Point[] = raw.map(([x, y]) => ({ x, y }));
    const name = `${file} line ${li + 1}`;

    it(`${name}: adding a click changes nothing but the last two parts`, () => {
      const t = new Trace();
      let before = line(t);
      for (const [i, p] of clicks.entries()) {
        t.add(p, opts);
        const now = line(t);
        if (before && before.parts.length > 2) {
          const kept = before.parts.length - 2;
          expect(now?.start, `start after click ${i + 1}`).toEqual(before.start);
          expect(now?.parts.slice(0, kept), `parts before the window after click ${i + 1}`).toEqual(before.parts.slice(0, kept));
        }
        before = now;
      }
    });

    it(`${name}: replaying the clicks gives the same line`, () => {
      expect(line(Trace.replay(clicks, opts))).toEqual(line(Trace.replay(clicks, opts)));
    });

    it(`${name}: moving a click gives the line of the moved clicks`, () => {
      const i = Math.floor(clicks.length / 2);
      const moved = clicks.map((p, k) => (k === i ? { x: p.x + set.gauge / 4, y: p.y } : p));
      const t = Trace.replay(clicks, opts);
      t.move(i, moved[i], opts);
      expect(t.clicks).toEqual(moved);
      expect(line(t)).toEqual(line(Trace.replay(moved, opts)));
    });

    it(`${name}: deleting a click gives the line of the remaining clicks`, () => {
      const i = Math.floor(clicks.length / 2);
      const left = clicks.filter((_, k) => k !== i);
      const t = Trace.replay(clicks, opts);
      t.remove(i, opts);
      expect(t.clicks).toEqual(left);
      expect(line(t)).toEqual(line(Trace.replay(left, opts)));
    });
  });
}

describe('the locality checks', () => {
  it('cover every click set', () => {
    expect(Object.keys(sets).length).toBeGreaterThan(0);
  });
});
