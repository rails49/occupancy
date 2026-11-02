import type { TraceView } from './trackTrace.js';

/**
 * The track tool's hint (#298, #307): one of three sentences on what to do
 * next. With red clicks, on the line being traced or, with none traced, on
 * a stored line (`offLine`): move or delete them. While tracing: the next
 * click, and how to end. Otherwise: how to start a line or go on with one.
 * Pure.
 */
export function trackHint(trace: TraceView | null, offLine: boolean): string {
  if (trace ? trace.red.length > 0 : offLine) {
    return 'Red points lie off the line. Drag each onto the middle of the track, or delete it.';
  }
  if (trace) return 'Click on along the middle of the track. Right-click or Esc ends the line.';
  return "Click along the middle of a track to trace it. Click a line's end point to go on from it.";
}
