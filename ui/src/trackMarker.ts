import { svg, css, nothing } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Point } from '@rails49/r49';
import { HIGHLIGHT_CLASS } from './highlight.js';
import { samePoint } from './geometry.js';
import { SAMPLE_PX, offsetPoints, trackPath } from './track.js';
import type { Track } from './track.js';
import { sampleFit } from './trackFit.js';
import type { Fit } from './trackFit.js';
import type { TraceView } from './trackTrace.js';

/**
 * Track rendering for SVG (#284, #311): the centerline, and under the track
 * tool the two rails half a gauge to either side, a dot at each click and,
 * ahead of the line being traced, the projection as a dashed centerline.
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
  .track .projection {
    stroke: var(--track-ink);
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .track .rail {
    opacity: 0.8;
  }

  .track .click {
    fill: var(--track-ink);
    stroke: rgba(0, 0, 0, 0.75);
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
   * click a reveal points at is drawn either way.
   */
  readonly detail: boolean;
}

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

/**
 * One centerline. `highlighted` are the pixels of clicks a reveal points at (#37).
 */
export function renderTrack(
  track: Track,
  size: TrackSymbolSize,
  highlighted: readonly Point[] = []
): SVGTemplateResult {
  const { nodes } = track;
  const gauge = size.dpt;
  const dots = (track.clicks ?? []).flatMap(p => {
    const lit = highlighted.some(h => samePoint(h, p));
    if (!size.detail && !lit) return [];
    return [renderDot(p, size, lit ? `click ${HIGHLIGHT_CLASS}` : 'click')];
  });
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
    ${dots}
  </g>`;
}

/** A fitted line `offset` image pixels to its left, as an SVG polyline. */
function renderFit(fit: Fit, offset: number, cls: string, size: TrackSymbolSize, dashed = false) {
  return svg`<polyline
    class="${cls}"
    points="${polyline(sampleFit(fit, SAMPLE_PX, offset))}"
    stroke-width="${size.strokePx}"
    stroke-dasharray="${dashed ? `${4 * size.strokePx} ${4 * size.strokePx}` : nothing}"
  />`;
}

/**
 * The line a track chain is tracing (#311): its rails and centerline from the
 * fit, the projection ahead of it dashed, and a dot per click.
 */
export function renderPendingTrack(view: TraceView, size: TrackSymbolSize): SVGTemplateResult {
  const { fit, projection } = view;
  const gauge = size.dpt;
  return svg`<g class="track track-pending">
    ${
      fit
        ? [
            ...(gauge === null ? [] : [gauge / 2, -gauge / 2].map(o => renderFit(fit, o, 'rail', size))),
            renderFit(fit, 0, 'centerline', size),
          ]
        : ''
    }
    ${projection ? renderFit(projection, 0, 'projection', size, true) : ''}
    ${view.clicks.map(p => renderDot(p, size, 'click'))}
  </g>`;
}
