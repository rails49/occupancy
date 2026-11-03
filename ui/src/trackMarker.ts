import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Point } from '@rails49/r49';
import { HIGHLIGHT_CLASS } from './highlight.js';
import { samePoint } from './geometry.js';
import { offsetPoints, squareAt, trackPath } from './track.js';
import type { Track } from './track.js';
import type { TrackHover, TrackPreview } from './trackChain.js';

/**
 * Track rendering for SVG (#284): the centerline, and under the track tool
 * the two rails half a gauge to either side and a dot at each click, a
 * square at either end of a straight gap.
 *
 * A module rather than a custom element, like the other markers. Its exports
 * must be used together: `trackMarkerStyles` in the host's `static styles`,
 * `renderTrack` once per stored track, `renderPendingTrack` for the line
 * a track chain is tracing or a drag is changing, and `renderTrackCues`
 * over them for what follows the pointer.
 *
 * The rails are what the person compares with the photograph. They are drawn
 * at ±G/2, where the inner faces of the rails are.
 *
 * Green, against the crosshair's cyan, the sensor's amber and the car's
 * magenta. Green is also a sensor's clear state, but only in the live view,
 * which draws no track. The line being traced or changed is blue (#324), and
 * a preview the rule refuses red, like the car's refused band.
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

  .track .click.end,
  .track .ring {
    fill: none;
    stroke: var(--track-ink);
  }

  .track-pending {
    --track-ink: #60a5fa;
  }

  .track-preview.refused {
    --track-ink: #ef4444;
  }

  .track-insert {
    opacity: 0.5;
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
  /** Whether a line's two end dots are drawn hollow: no line is traced (#324). */
  readonly hollowEnds?: boolean;
}

/** What the track tool draws over the tracks (#324). */
export interface TrackCues {
  /** Whether a line is traced. */
  readonly tracing: boolean;
  /** The next gap to the pointer while a line is traced, or null. */
  readonly preview: TrackPreview | null;
  /** What the pointer is over with no line traced, or null. */
  readonly hover: TrackHover | null;
}

function polyline(points: readonly Point[]): string {
  return points.map(p => `${p.x},${p.y}`).join(' ');
}

function renderDot(p: Point, size: TrackSymbolSize, cls: string, square: boolean): SVGTemplateResult {
  return renderMark(p, size.dotPx, size.strokePx / 2, cls, square);
}

/** The ring on the end a click goes on from: twice a dot's size, a square on a straight end. */
function renderRing(p: Point, size: TrackSymbolSize, square: boolean): SVGTemplateResult {
  return renderMark(p, 2 * size.dotPx, size.strokePx, 'ring', square);
}

function renderMark(p: Point, sizePx: number, strokePx: number, cls: string, square: boolean): SVGTemplateResult {
  if (square) {
    return svg`<rect
      class="${cls}"
      x="${p.x - sizePx / 2}"
      y="${p.y - sizePx / 2}"
      width="${sizePx}"
      height="${sizePx}"
      stroke-width="${strokePx}"
    />`;
  }
  return svg`<circle
    class="${cls}"
    cx="${p.x}"
    cy="${p.y}"
    r="${sizePx / 2}"
    stroke-width="${strokePx}"
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
 * The line a track chain is tracing, in the order it is traced, or a line a
 * drag is changing, in blue: its rails, centerline and a dot per click; the
 * first click alone before the second. A straight mark on the last click,
 * the one the chain goes on from, draws it as a square: the next gap is to
 * be straight. With `ring`, the last click has the ring.
 */
export function renderPendingTrack(track: Track, size: TrackSymbolSize, ring = false): SVGTemplateResult {
  return renderLine(track, { ...size, detail: true }, [], 'track track-pending', ring);
}

/**
 * What follows the pointer under the track tool: the preview, dashed blue,
 * or red where the rule refuses a click; the ring on an end dot under the
 * pointer; or a faint dot where a click would insert one.
 */
export function renderTrackCues(cues: TrackCues, size: TrackSymbolSize): SVGTemplateResult {
  const { preview, hover } = cues;
  return svg`${
    preview
      ? svg`<g class="track track-pending track-preview${preview.refusal ? ' refused' : ''}">
          <path
            class="centerline"
            d="${trackPath(preview.nodes)}"
            stroke-width="${size.strokePx}"
            stroke-dasharray="${size.strokePx * 3} ${size.strokePx * 2}"
          />
        </g>`
      : ''
  }${hover?.kind === 'end' ? svg`<g class="track">${renderRing(hover.at, size, hover.square)}</g>` : ''}${
    hover?.kind === 'insert' ? svg`<g class="track track-insert">${renderDot(hover.at, size, 'click', false)}</g>` : ''
  }`;
}

function renderLine(
  track: Track,
  size: TrackSymbolSize,
  highlighted: readonly Point[],
  cls: string,
  ring = false
): SVGTemplateResult {
  const { nodes } = track;
  const gauge = size.dpt;
  const clicks = track.clicks ?? [];
  const last = clicks.length - 1;
  const dots = clicks.flatMap((p, i) => {
    const lit = highlighted.some(h => samePoint(h, p));
    if (!size.detail && !lit) return [];
    const cls = lit ? `click ${HIGHLIGHT_CLASS}` : 'click';
    if (size.hollowEnds && (i === 0 || i === last)) return [renderMark(p, size.dotPx, size.strokePx, `${cls} end`, squareAt(clicks, i))];
    return [renderDot(p, size, cls, squareAt(clicks, i))];
  });
  if (ring && last >= 0) dots.push(renderRing(clicks[last], size, squareAt(clicks, last)));
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
