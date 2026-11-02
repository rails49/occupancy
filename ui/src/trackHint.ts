import { TRACK_FIT } from './trackFit.js';
import type { TraceView } from './trackTrace.js';

/**
 * The track tool's hint (#311): one of three sentences on what to do next.
 * With the last click refused: why, and what to do. While tracing: the next
 * click, and how to end. Otherwise: how to start a line or go on with one.
 * Pure.
 */
export function trackHint(trace: TraceView | null, refused: boolean): string {
  if (refused) return `Needs an arc tighter than ${TRACK_FIT.minRadius} G: click farther ahead, or end the line.`;
  if (trace) return 'Click ahead on the track centre; right-click or Escape ends the line.';
  return "Click at least a gauge from any track to start a line, or on a line's end to go on.";
}
