import { describe, it, expect } from 'vitest';
import { trackHint } from '../src/trackHint.js';
import type { TraceView } from '../src/trackTrace.js';

/** A trace of one straight part. */
const tracing: TraceView = {
  clicks: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
  partStarts: [],
  fit: { start: { x: 0, y: 0, heading: 0 }, parts: [{ length: 100, curvature: 0 }] },
  projection: { start: { x: 100, y: 0, heading: 0 }, parts: [{ length: 200, curvature: 0 }] },
};

const IDLE = "Click at least a gauge from any track to start a line, or on a line's end to go on.";
const TRACING = 'Click ahead on the track centre; right-click or Escape ends the line.';
const REFUSED = 'Needs an arc tighter than 15 G: click farther ahead, or end the line.';

describe('trackHint', () => {
  it('says how to start a line or go on with one when nothing is traced', () => {
    expect(trackHint(null, false)).toBe(IDLE);
  });

  it('asks for the next click and says how to end while tracing, from the first click on', () => {
    expect(trackHint({ clicks: [{ x: 0, y: 0 }], partStarts: [], fit: null, projection: null }, false)).toBe(TRACING);
    expect(trackHint(tracing, false)).toBe(TRACING);
  });

  it('says why the last click was refused, and what to do', () => {
    expect(trackHint(tracing, true)).toBe(REFUSED);
  });

  it('has no sentence about red clicks', () => {
    for (const trace of [null, tracing]) for (const refused of [false, true]) expect(trackHint(trace, refused)).not.toMatch(/red/i);
  });
});
