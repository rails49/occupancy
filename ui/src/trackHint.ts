import type { TraceView } from './trackTrace.js';

/**
 * The track tool's hint (#298): one sentence on what to do next, from what
 * the line being traced shows, or with none, from whether a stored line has
 * red clicks (`offLine`). The first that applies wins: a lone click, red
 * clicks, then how to go on. Pure.
 */
export function trackHint(trace: TraceView | null, offLine: boolean): string {
  if (!trace) {
    return offLine
      ? 'Red points lie off their line. Drag each onto the middle of the track, or delete it.'
      : "Click along the middle of a track to trace it. Click a line's end point to go on from it.";
  }
  if (!trace.fit) {
    return 'Click farther along the middle of the track. Long steps are fine where it runs straight or curves evenly.';
  }
  if (trace.red.length > 0) {
    return 'Red points lie off the line. Drag a red point onto the middle of the track, or delete it.';
  }
  return 'Click on along the track. Right-click or Esc ends the line.';
}
