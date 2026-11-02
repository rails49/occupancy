import { describe, it, expect } from 'vitest';
import type { Point } from '@rails49/r49';
import { Trace, traceOptions } from '../src/trackTrace.js';

/**
 * The line is a function of its clicks in order, each click going on the
 * end of the line as it stands (SPEC § Track centerlines). An edit changes no
 * part before the edited click's unless it moves a click across the
 * tolerance of the part before it, since the replay decides again which part
 * each click joins; the edits here stay within it. These checks hold for
 * every click set, in track order.
 */
interface ClickSet {
  readonly gauge: number;
  readonly lines: readonly (readonly [number, number])[][];
}

const sets = import.meta.glob<ClickSet>('./clickSets/*.json', { eager: true, import: 'default' });

for (const [file, set] of Object.entries(sets)) {
  const opts = traceOptions(set.gauge);
  set.lines.forEach((raw, li) => {
    const clicks: Point[] = raw.map(([x, y]) => ({ x, y }));
    const name = `${file} line ${li + 1}`;

    it(`${name}: adding a click changes nothing but the current part`, () => {
      const t = new Trace();
      let before = t.line;
      for (const [i, p] of clicks.entries()) {
        t.add(p, opts);
        const now = t.line;
        if (before && now) {
          const kept = before.fit.parts.length - 1;
          // The first part's heading is free while it is the current part.
          const { heading: _h, ...start } = before.fit.start;
          expect(now.fit.start, `start after click ${i + 1}`).toMatchObject(start);
          if (kept > 0) expect(now.fit.start.heading, `heading after click ${i + 1}`).toBe(before.fit.start.heading);
          expect(now.fit.parts.slice(0, kept), `parts before the current one after click ${i + 1}`).toEqual(before.fit.parts.slice(0, kept));
        }
        before = now;
      }
    });

    it(`${name}: replaying the clicks gives the same line`, () => {
      expect(Trace.replay(clicks, opts).view(opts)).toEqual(Trace.replay(clicks, opts).view(opts));
    });

    it(`${name}: repeating the last click adds nothing`, () => {
      const t = Trace.replay(clicks, opts);
      const before = t.view(opts);
      expect(t.add(t.clicks[t.clicks.length - 1], opts)).toBe('ignored');
      expect(t.view(opts)).toEqual(before);
    });

    it(`${name}: moving a click within its part's tolerance gives the line of the moved clicks, and changes no part before the click's`, () => {
      const t = Trace.replay(clicks, opts);
      const i = Math.floor(t.clicks.length / 2);
      const moved = t.clicks.map((p, k) => (k === i ? { x: p.x + set.gauge / 4, y: p.y } : p));
      const before = t.line!;
      const part = before.firstClick.filter(first => first <= i).length - 1;
      if (t.move(i, moved[i], opts) === 'refused') return;
      expect(t.clicks).toEqual(moved);
      expect(t.view(opts)).toEqual(Trace.replay(moved, opts).view(opts));
      expect(t.line?.fit.parts.slice(0, part)).toEqual(before.fit.parts.slice(0, part));
    });

    it(`${name}: deleting a click that leaves the others on their parts gives the line of the remaining clicks, and changes no part before the click's`, () => {
      const t = Trace.replay(clicks, opts);
      const i = Math.floor(t.clicks.length / 2);
      const left = t.clicks.filter((_, k) => k !== i);
      const before = t.line!;
      const part = before.firstClick.filter(first => first <= i).length - 1;
      if (t.remove(i, opts) === 'refused') return;
      expect(t.clicks).toEqual(left);
      expect(t.view(opts)).toEqual(Trace.replay(left, opts).view(opts));
      expect(t.line?.fit.parts.slice(0, part)).toEqual(before.fit.parts.slice(0, part));
    });
  });
}

describe('the locality checks', () => {
  it('cover every click set', () => {
    expect(Object.keys(sets).length).toBeGreaterThan(0);
  });
});
