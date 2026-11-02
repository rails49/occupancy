import { describe, it, expect } from 'vitest';
import type { FitResult } from '../src/trackFit.js';
import { trackHint } from '../src/trackHint.js';
import type { TraceView } from '../src/trackTrace.js';
import { G } from './trackClicks.js';

/** A trace of straight parts 10 G long whose inner joins have σ `sigmas` (gauges), flagging `flagged`. */
function tracing(sigmas: readonly number[], flagged: readonly number[] = []): TraceView {
  const sigma = [0, ...sigmas, 0].map(s => s * G);
  const parts = sigma.slice(1).map(() => ({ length: 10 * G, curvature: 0 }));
  const live: FitResult = {
    fit: { start: { x: 0, y: 0, heading: 0 }, parts },
    residuals: [],
    partOf: [],
    worst: 0,
    rms: 0,
    joins: sigma.map((s, i) => ({ x: i * 10 * G, y: 0, heading: 0, sigma: s, margin: 20 })),
    outliers: [],
  };
  return { clicks: [], committed: null, live, flagged };
}

describe('trackHint', () => {
  it('says how to start or go on a line with no trace, or how to fix red clicks on a stored line', () => {
    expect(trackHint(null, false, G)).toMatch(/^Click along the middle of a track/);
    expect(trackHint(null, true, G)).toMatch(/^Red points lie off their line/);
  });

  it('asks for the next click after the first', () => {
    const one: TraceView = { clicks: [{ x: 0, y: 0 }], committed: null, live: null, flagged: [] };
    expect(trackHint(one, false, G)).toMatch(/^Click farther along/);
  });

  it('names the dashed end, insertion, Shift and how to end the line when nothing needs fixing', () => {
    const hint = trackHint(tracing([]), false, G);
    expect(hint).toMatch(/^The dashed end can still move/);
    expect(hint).toMatch(/Shift-click always extends/);
    expect(hint).toMatch(/Right-click or Esc ends the line/);
  });

  it('points at a bar, then at red clicks, then at an end not drawn, each over the one before', () => {
    expect(trackHint(tracing([1]), false, G)).toMatch(/^A bar marks/);
    expect(trackHint(tracing([1], [1]), false, G)).toMatch(/^Red points lie off the line/);
    expect(trackHint(tracing([5], [1]), false, G)).toMatch(/^The end of the line is not drawn/);
  });

  it('ignores red clicks on stored lines while a line is traced', () => {
    expect(trackHint(tracing([]), true, G)).toMatch(/^The dashed end/);
  });
});
