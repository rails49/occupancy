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

const START = /^Click along the middle of a track to trace it\. Click a line's end point to go on from it\.$/;
const NEXT = /^Click on along the middle of the track\. Right-click or Esc ends the line\.$/;
const RED = /^Red points lie off the line\. Drag each onto the middle of the track, or delete it\.$/;

describe('trackHint', () => {
  it('says how to start a line or go on with one when nothing is traced', () => {
    expect(trackHint(null, false)).toMatch(START);
  });

  it('asks for the next click and says how to end while tracing, from the first click on', () => {
    expect(trackHint({ clicks: [{ x: 0, y: 0 }], fit: null, red: [] }, false)).toMatch(NEXT);
    expect(trackHint(tracing(), false)).toMatch(NEXT);
  });

  it('asks for red clicks to be moved or deleted, on the traced line or on a stored one', () => {
    expect(trackHint(tracing([1]), false)).toMatch(RED);
    expect(trackHint(null, true)).toMatch(RED);
  });

  it('ignores red clicks on stored lines while a line is traced', () => {
    expect(trackHint(tracing(), true)).toMatch(NEXT);
  });
});
