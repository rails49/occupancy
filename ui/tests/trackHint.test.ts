import { describe, it, expect } from 'vitest';
import { trackHint } from '../src/trackHint.js';
import type { TraceView } from '../src/trackTrace.js';

/** A trace of one straight part, with `red` clicks. */
function tracing(red: readonly number[] = []): TraceView {
  return {
    clicks: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    fit: { start: { x: 0, y: 0, heading: 0 }, parts: [{ length: 100, curvature: 0 }] },
    red,
  };
}

describe('trackHint', () => {
  it('says how to start or go on a line with no trace, or how to fix red clicks on a stored line', () => {
    expect(trackHint(null, false)).toMatch(/^Click along the middle of a track/);
    expect(trackHint(null, true)).toMatch(/^Red points lie off their line/);
  });

  it('asks for the next click after the first', () => {
    const one: TraceView = { clicks: [{ x: 0, y: 0 }], fit: null, red: [] };
    expect(trackHint(one, false)).toMatch(/^Click farther along/);
  });

  it('says how to go on and how to end the line when nothing needs fixing', () => {
    const hint = trackHint(tracing(), false);
    expect(hint).toMatch(/^Click on along the track/);
    expect(hint).toMatch(/Right-click or Esc ends the line/);
  });

  it('asks for red clicks to be moved or deleted', () => {
    expect(trackHint(tracing([1]), false)).toMatch(/^Red points lie off the line/);
  });

  it('ignores red clicks on stored lines while a line is traced', () => {
    expect(trackHint(tracing(), true)).toMatch(/^Click on along the track/);
  });
});
