import type { Track } from './track.js';
import { TRACK_FIT } from './trackFit.js';
import type { Refusal } from './trackFit.js';

/** Why a click or an edit was refused, and what to do. */
const REFUSED: Record<Refusal, string> = {
  behind: 'Behind the click before it: click farther along the track.',
  tight: `Needs an arc tighter than ${TRACK_FIT.minRadius} G: click farther along the track.`,
};

/**
 * The track tool's hint (#317): what to do next. After a refusal: why, and
 * what to do. While tracing: the next click, and how to end. Otherwise: how
 * to start, continue or change a line. Pure.
 */
export function trackHint(trace: Track | null, refusal: Refusal | null): string {
  if (refusal) return REFUSED[refusal];
  if (trace) return 'Click along the middle of the track. Double-click where a straight starts. Right-click or Escape ends.';
  return 'Click to start a line, click an end dot to continue one, click a line to add a click. Right-click a gap to make it straight or free.';
}
