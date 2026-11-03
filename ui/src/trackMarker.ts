import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Point } from '@rails49/r49';
import { HIGHLIGHT_CLASS } from './highlight.js';
import { samePoint } from './geometry.js';
import { offsetPoints, trackPath } from './track.js';
import type { Track } from './track.js';

/**
 * Track rendering for SVG (#284): the centerline, and under the track tool
 * the two rails half a gauge to either side and a dot at each click, a
 * square at either end of a straight gap.
 *
 * A module rather than a custom element, like the other markers. Its exports
 * must be used together: `trackMarkerStyles` in the host's `static styles`,
 * `renderTrack` once per stored track and `renderPendingTrack` for the
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
  .track .rail {
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

function renderDot(p: Point, size: TrackSymbolSize, cls: string, square: boolean): SVGTemplateResult {
  if (square) {
    return svg`<rect
      class="${cls}"
      x="${p.x - size.dotPx / 2}"
      y="${p.y - size.dotPx / 2}"
      width="${size.dotPx}"
      height="${size.dotPx}"
      stroke-width="${size.strokePx / 2}"
    />`;
  }
  return svg`<circle
    class="${cls}"
    cx="${p.x}"
    cy="${p.y}"
    r="${size.dotPx / 2}"
    stroke-width="${size.strokePx / 2}"
  />`;
}

/**
 * One track. `highlighted` are the pixels of clicks a reveal points at (#37).
 */
export function renderTrack(
  track: Track,
  size: TrackSymbolSize,
  highlighted: readonly Point[] = []
): SVGTemplateResult {
  return renderLine(track, size, highlighted, 'track');
}

/**
 * The line a track chain is tracing, in the order it is traced: its rails,
 * centerline and a dot per click; the first click alone before the second.
 * A straight mark on the last click, the one the chain goes on from, draws
 * it as a square: the next gap is to be straight.
 */
export function renderPendingTrack(track: Track, size: TrackSymbolSize): SVGTemplateResult {
  return renderLine(track, { ...size, detail: true }, [], 'track track-pending');
}

function renderLine(track: Track, size: TrackSymbolSize, highlighted: readonly Point[], cls: string): SVGTemplateResult {
  const { nodes } = track;
  const gauge = size.dpt;
  const clicks = track.clicks ?? [];
  const dots = clicks.flatMap((p, i) => {
    const lit = highlighted.some(h => samePoint(h, p));
    if (!size.detail && !lit) return [];
    return [renderDot(p, size, lit ? `click ${HIGHLIGHT_CLASS}` : 'click', !!(p.straight || clicks[i - 1]?.straight))];
  });
  if (nodes.length < 2) return svg`<g class="${cls}">${dots}</g>`;
  return svg`<g class="${cls}">
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
