import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Point } from '@rails49/r49';
import { offsetPoints, trackPath } from './track.js';
import type { Track, TrackNode } from './track.js';

/**
 * Track rendering for SVG (#284): the centerline, the two rails half a gauge to
 * either side, and a dot at each node.
 *
 * A module rather than a custom element, like the other markers. Its exports
 * must be used together: `trackMarkerStyles` in the host's `static styles`,
 * `renderTrack` once per centerline and `renderPendingTrack` for the trace in
 * flight.
 *
 * The rails are what the person compares with the photograph. They are drawn
 * at ±G/2, where the inner faces of the rails are.
 *
 * Violet, against the crosshair's cyan, the sensor's amber and the car's
 * magenta.
 */

export const trackMarkerStyles: CSSResult = css`
  .track {
    --track-ink: #a78bfa;
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

  .track .node {
    fill: var(--track-ink);
    stroke: rgba(0, 0, 0, 0.75);
  }

  .track .refused {
    stroke: #ef4444;
  }
`;

/** The sizes a track is drawn at: the DPT the rails are spaced by, and screen-constant strokes. */
export interface TrackSymbolSize {
  /** `null` draws the centerline alone: there is no gauge to space the rails by. */
  readonly dpt: number | null;
  readonly strokePx: number;
  readonly nodePx: number;
}

/** The trace in flight: what it has placed, with the pointer's next node if a click there adds one. */
export interface PendingTrack {
  readonly start: Point;
  readonly nodes: readonly TrackNode[];
  /** The pointer, or null before it has moved. */
  readonly cursor: Point | null;
  /** Whether a click at the cursor would be refused. */
  readonly refused: boolean;
}

function polyline(points: readonly Point[]): string {
  return points.map(p => `${p.x},${p.y}`).join(' ');
}

function renderLine(nodes: readonly TrackNode[], size: TrackSymbolSize): SVGTemplateResult {
  const gauge = size.dpt;
  return svg`
    ${
      gauge === null
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
    ${nodes.map(
      n => svg`<circle
        class="node"
        cx="${n.x}"
        cy="${n.y}"
        r="${size.nodePx / 2}"
        stroke-width="${size.strokePx / 2}"
      />`
    )}
  `;
}

export function renderTrack(track: Track, size: TrackSymbolSize): SVGTemplateResult {
  return svg`<g class="track">${renderLine(track.nodes, size)}</g>`;
}

/**
 * The trace in flight. A refused click shows as a straight red line from the
 * last node to the pointer.
 */
export function renderPendingTrack(pending: PendingTrack, size: TrackSymbolSize): SVGTemplateResult {
  const { start, nodes, cursor, refused } = pending;
  const last = nodes[nodes.length - 1] ?? start;
  return svg`
    <g class="track track-pending">
      ${
        nodes.length >= 2
          ? renderLine(nodes, size)
          : svg`<circle
              class="node"
              cx="${start.x}"
              cy="${start.y}"
              r="${size.nodePx / 2}"
              stroke-width="${size.strokePx / 2}"
            />`
      }
      ${
        refused && cursor
          ? svg`<line
              class="refused"
              x1="${last.x}"
              y1="${last.y}"
              x2="${cursor.x}"
              y2="${cursor.y}"
              stroke-width="${size.strokePx}"
            />`
          : ''
      }
    </g>
  `;
}
