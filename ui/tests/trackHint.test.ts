import { describe, it, expect } from 'vitest';
import { trackHint } from '../src/trackHint.js';
import type { Track } from '../src/track.js';

/** A line of two clicks being traced. */
const tracing: Track = {
  nodes: [
    { x: 0, y: 0, heading: 0 },
    { x: 100, y: 0, heading: 0 },
  ],
  clicks: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
};

const IDLE = "Click at least a gauge from any track to start a line, or on a line's end to go on.";
const TRACING = 'Click ahead on the track centre; right-click or Escape ends the line.';
const REFUSED = 'Needs an arc tighter than 15 G: click farther ahead, or end the line.';

describe('trackHint', () => {
  it('says how to start a line or go on with one when nothing is traced', () => {
    expect(trackHint(null, false)).toBe(IDLE);
  });

  it('asks for the next click and says how to end while tracing, from the first click on', () => {
    expect(trackHint({ nodes: [], clicks: [{ x: 0, y: 0 }] }, false)).toBe(TRACING);
    expect(trackHint(tracing, false)).toBe(TRACING);
  });

  it('says why the last click was refused, and what to do', () => {
    expect(trackHint(tracing, true)).toBe(REFUSED);
  });

  it('has no sentence about red clicks', () => {
    for (const trace of [null, tracing]) for (const refused of [false, true]) expect(trackHint(trace, refused)).not.toMatch(/red/i);
  });
});
