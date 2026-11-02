import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import type { Part, Pose } from '../src/trackFit.js';
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

/** The whole line a trace draws, committed and live alike. */
function line(t: Trace): { start: Pose | null; parts: Part[] } {
  return { start: t.origin ?? t.live?.fit.start ?? null, parts: [...t.committed, ...(t.live?.fit.parts ?? [])] };
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
        if (before.parts.length > 2) {
          const kept = before.parts.length - 2;
          expect(now.start, `start after click ${i + 1}`).toEqual(before.start);
          expect(now.parts.slice(0, kept), `parts before the window after click ${i + 1}`).toEqual(before.parts.slice(0, kept));
        }
        before = now;
      }
    });

    it(`${name}: ending the line changes nothing`, () => {
      const t = Trace.replay(clicks, opts);
      const before = line(t);
      t.finish(opts);
      expect(line(t)).toEqual(before);
    });

    it(`${name}: moving a click gives the line of the moved clicks`, () => {
      const i = Math.floor(clicks.length / 2);
      const moved = clicks.map((p, k) => (k === i ? { x: p.x + set.gauge / 4, y: p.y } : p));
      const t = Trace.replay(clicks, opts);
      t.move(i, moved[i], opts);
      expect(line(t)).toEqual(line(Trace.replay(moved, opts)));
    });
  });
}

describe('the locality checks', () => {
  it('cover every click set', () => {
    expect(Object.keys(sets).length).toBeGreaterThan(0);
  });
});
