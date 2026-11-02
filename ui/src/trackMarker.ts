import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Point } from '@rails49/r49';
import { HIGHLIGHT_CLASS } from './highlight.js';
import { clicksOff, offsetPoints, trackPath } from './track.js';
import type { Track } from './track.js';
import { TRACK_FIT, poses, sampleFit } from './trackFit.js';
import type { Fit, Join } from './trackFit.js';
import type { TraceView } from './trackTrace.js';

/**
 * Track rendering for SVG (#284, #298): the centerline, and under the track
 * tool the two rails half a gauge to either side and a dot at each click.
 *
 * A module rather than a custom element, like the other markers. Its exports
 * must be used together: `trackMarkerStyles` in the host's `static styles`,
 * `renderTrack` once per stored centerline and `renderPendingTrack` for the
 * line a track chain is tracing.
 *
 * The rails are what the person compares with the photograph. They are drawn
 * at ±G/2, where the inner faces of the rails are.
 *
 * Green, against the crosshair's cyan, the sensor's amber and the car's
 * magenta. Green is also a sensor's clear state, but only in the live view,
 * which draws no track.
 */

export const trackMarkerStyles: CSSResult = css`
  .track {
    --track-ink: #4ade80;
    fill: none;
    pointer-events: none;
  }

  .track .centerline,
  .track .rail,
  .track .bar {
    stroke: var(--track-ink);
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track .rail {
    opacity: 0.8;
  }

  .track .node,
  .track .click {
    fill: var(--track-ink);
    stroke: rgba(0, 0, 0, 0.75);
  }

  .track .click.outlier {
    fill: #ef4444;
  }
`;

/** The sizes a track is drawn at: the DPT the rails are spaced by, and screen-constant strokes. */
export interface TrackSymbolSize {
  /** `null` draws the centerline alone: there is no gauge to space the rails by. */
  readonly dpt: number | null;
  readonly strokePx: number;
  /** Diameter of a click dot. */
  readonly dotPx: number;
  /**
   * Whether to draw the rails and the click dots, or the centerline alone. A
   * node a reveal points at is drawn either way.
   */
  readonly detail: boolean;
}

/** Spacing, in image pixels, of the points a fitted part is drawn through. */
const SAMPLE_PX = 2;

function polyline(points: readonly Point[]): string {
  return points.map(p => `${p.x},${p.y}`).join(' ');
}

function renderDot(p: Point, size: TrackSymbolSize, cls: string): SVGTemplateResult {
  return svg`<circle
    class="${cls}"
    cx="${p.x}"
    cy="${p.y}"
    r="${size.dotPx / 2}"
    stroke-width="${size.strokePx / 2}"
  />`;
}

function renderClicks(clicks: readonly Point[], size: TrackSymbolSize, flagged: readonly number[] = []) {
  return clicks.map((p, i) => renderDot(p, size, flagged.includes(i) ? 'click outlier' : 'click'));
}

/** The flagged clicks of each track drawn, kept until the track is written again. */
const offCache = new WeakMap<Track, { readonly dpt: number; readonly off: readonly number[] }>();

/** The clicks of `track` past the tolerance from its line, which `gauge` sets. */
function flagged(track: Track, gauge: number | null): readonly number[] {
  if (gauge === null) return [];
  const cached = offCache.get(track);
  if (cached?.dpt === gauge) return cached.off;
  const off = clicksOff(track, TRACK_FIT.tolerance * gauge);
  offCache.set(track, { dpt: gauge, off });
  return off;
}

/**
 * One centerline. A click past the tolerance from the line drawn takes the
 * danger ink. `highlighted` are the pixels of nodes a reveal points at (#37).
 */
export function renderTrack(
  track: Track,
  size: TrackSymbolSize,
  highlighted: readonly Point[] = []
): SVGTemplateResult {
  const { nodes } = track;
  const gauge = size.dpt;
  const lit = nodes.filter(n => highlighted.some(p => p.x === n.x && p.y === n.y));
  return svg`<g class="track">
    ${
      gauge === null || !size.detail
        ? ''
        : [gauge / 2, -gauge / 2].map(
            offset => svg`<polyline
              class="rail"
              points="${polyline(offsetPoints(nodes, offset))}"
              stroke-width="${size.strokePx}"
            />`
          )
    }
    <path class="centerline" d="${trackPath(nodes)}" stroke-width="${size.strokePx}" />
    ${size.detail ? renderClicks(track.clicks ?? [], size, flagged(track, gauge)) : ''}
    ${lit.map(n => renderDot(n, size, `node ${HIGHLIGHT_CLASS}`))}
  </g>`;
}

/** A fitted line `offset` image pixels to its left, as an SVG polyline. */
function renderFit(fit: Fit, offset: number, cls: string, size: TrackSymbolSize, dashed = false) {
  const stroke = size.strokePx;
  return svg`<polyline
    class="${cls}"
    points="${polyline(sampleFit(fit, SAMPLE_PX, offset))}"
    stroke-width="${stroke}"
    stroke-dasharray="${dashed ? `${stroke * 4} ${stroke * 3}` : 'none'}"
  />`;
}

/** A bar across the track at `join`, half-length its σ, held to `cap`. */
function renderBar(join: Join, cap: number, size: TrackSymbolSize): SVGTemplateResult {
  const h = Math.min(join.sigma, cap);
  const dx = -h * Math.sin(join.heading);
  const dy = h * Math.cos(join.heading);
  return svg`<line
    class="bar"
    x1="${join.x - dx}"
    y1="${join.y - dy}"
    x2="${join.x + dx}"
    y2="${join.y + dy}"
    stroke-width="${size.strokePx}"
  />`;
}

/**
 * The line a track chain is tracing (#298). Committed track draws its rails
 * and a solid centerline. The live tail draws a dashed centerline, a part only
 * when both its joins have σ under the bar cap, and a bar across each
 * uncommitted join of a drawn part but the last. Every click is a dot; a
 * flagged one takes the danger ink.
 */
export function renderPendingTrack(view: TraceView, size: TrackSymbolSize): SVGTemplateResult {
  const { committed, live } = view;
  const gauge = size.dpt;
  const cap = gauge === null ? Infinity : TRACK_FIT.barCap * gauge;
  const parts = live?.fit.parts ?? [];
  const joins = live?.joins ?? [];
  const starts = live ? poses(live.fit) : [];
  const drawn = parts.map((_, i) => joins[i].sigma < cap && joins[i + 1].sigma < cap);
  // A live tail starts at the last committed join once anything is committed.
  const firstLoose = committed ? 1 : 0;
  const barred = joins.filter((_, i) => i >= firstLoose && i < parts.length && (drawn[i] || drawn[i - 1]));
  return svg`<g class="track track-pending">
    ${
      committed
        ? [
            ...(gauge === null ? [] : [gauge / 2, -gauge / 2].map(o => renderFit(committed, o, 'rail', size))),
            renderFit(committed, 0, 'centerline', size),
          ]
        : ''
    }
    ${parts.map((part, i) =>
      drawn[i] ? renderFit({ start: starts[i], parts: [part] }, 0, 'centerline tail', size, true) : ''
    )}
    ${barred.map(j => renderBar(j, cap, size))}
    ${renderClicks(view.clicks, size, view.flagged)}
  </g>`;
}
