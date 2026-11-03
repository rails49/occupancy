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

const IDLE =
  'Click to start a line, click an end dot to continue one, click a line to add a click. Right-click a gap to make it straight or free.';
const TRACING = 'Click along the middle of the track. Double-click where a straight starts. Right-click or Escape ends.';

describe('trackHint', () => {
  it('says how to start a line, go on with one or change one when nothing is traced', () => {
    expect(trackHint(null, null)).toBe(IDLE);
  });

  it('asks for the next click and says how to end while tracing, from the first click on', () => {
    expect(trackHint({ nodes: [], clicks: [{ x: 0, y: 0 }] }, null)).toBe(TRACING);
    expect(trackHint(tracing, null)).toBe(TRACING);
  });

  it('says why the last click or edit was refused, and what to do, traced or not', () => {
    for (const trace of [null, tracing]) {
      expect(trackHint(trace, 'behind')).toBe('Behind the click before it: click farther along the track.');
      expect(trackHint(trace, 'tight')).toBe('Needs an arc tighter than 10 G: click farther along the track.');
    }
  });
});
