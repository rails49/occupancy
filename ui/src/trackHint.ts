import { tailMarks, traceOptions } from './trackTrace.js';
import type { TraceView } from './trackTrace.js';

/**
 * The track tool's hint (#298): one sentence on what to do next, from what
 * the line being traced shows, or with none, from whether a stored line has
 * red clicks (`offLine`). The first that applies wins: a lone click, an end
 * not drawn, red clicks, bars, then the dashed end. Pure.
 */
export function trackHint(trace: TraceView | null, offLine: boolean, dpt: number): string {
  if (!trace) {
    return offLine
      ? 'Red points lie off their line. Drag each onto the middle of the track, or click on the line near it to add a point.'
      : "Click along the middle of a track to trace it. Click a line's end point to go on from it.";
  }
  if (!trace.live) {
    return 'Click farther along the middle of the track. Long steps are fine where it runs straight or curves evenly.';
  }
  const { parts, bars } = tailMarks(trace.live, traceOptions(dpt).barCap);
  if (parts.length < trace.live.fit.parts.length) {
    return 'The end of the line is not drawn: its points do not settle where it bends. Click more points along the track between the last ones.';
  }
  if (trace.flagged.length > 0) {
    return 'Red points lie off the line. Click more points along the track beside them, or drag a red point onto the middle of the track.';
  }
  if (bars.length > 0) {
    return 'A bar marks where two pieces of the line meet and the place is not settled. Click more points near a long bar.';
  }
  return 'The dashed end can still move. Click on along the track, or beside the line to add a point between. Shift-click always extends. Right-click or Esc ends the line.';
}
