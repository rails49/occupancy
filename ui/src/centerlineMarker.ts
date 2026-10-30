import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Point, Sensor } from '@rails49/r49';
import { patchCorners, sensorTrack } from './geometry.js';
import type { Centerline, CarCorners } from './geometry.js';
import { HIGHLIGHT_CLASS } from './highlight.js';

/**
 * Centerline rendering for SVG: the traced polylines, a sensor's patch outline,
 * the two sensor marks, and the spots where a trace stopped short (#275).
 *
 * A module rather than a custom element, like `sensorMarker.ts` and
 * `carMarker.ts` — custom elements break the SVG namespace when nested inside
 * `<svg>`. `centerlineMarkerStyles` and the renderers **must be used
 * together**: the styles in the host's `static styles`, a renderer per object.
 *
 * **Everything here is an outline, never a fill.** A centerline lies on the
 * track the photograph is of, and the whole reason to draw it is to check it
 * against the rails underneath — ink that covered them would hide the only
 * evidence the author has. The patch is the same argument one step out: it is
 * drawn so a bad fit shows (ADR 0021), and a tinted rectangle over the track
 * would be the thing hiding it.
 *
 * **Green, which is a fourth ink.** A crosshair is cyan, a sensor amber, a car
 * white-ish; a centerline had to be none of those, because `SPEC.md` §
 * Reference points makes "unmistakable from the other tools' objects" a
 * requirement rather than taste, and a centerline runs *through* sensors and
 * cars rather than beside them. The two marks reuse the warning and danger
 * hues a photograph already carries for refusals, and they are strokes on the
 * image rather than filled bars in a pane, so they are judged the way a marker
 * ink is (`ui/CLAUDE.md` § Shoelace).
 */

export const centerlineMarkerStyles: CSSResult = css`
  .centerline {
    /* One literal for the whole layer, as the crosshair and the sensor each
       have one: this is ink on an arbitrary photograph, not chrome, and it has
       to stay legible over ballast, over rail and over a dark tunnel mouth. */
    --centerline-ink: #22c55e;
    --centerline-stop-ink: #ef4444;
    --centerline-warn-ink: #f59e0b;
  }

  .centerline .line {
    fill: none;
    stroke: var(--centerline-ink);
    /* Constant on screen: the line annotates the track rather than measuring
       it, so zooming in must not thicken it over the rails it is checked
       against. */
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
  }

  .centerline .line.selected {
    stroke-width: 2.5;
  }

  .centerline .handle {
    fill: var(--centerline-ink);
    stroke: none;
  }

  .centerline .pending {
    stroke-dasharray: 6 4;
  }

  .patch {
    fill: none;
    stroke: #22c55e;
    stroke-width: 1;
    stroke-dasharray: 4 3;
    vector-effect: non-scaling-stroke;
  }

  .sensor-mark {
    fill: none;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .sensor-mark[data-mark='no-track'] {
    stroke: #ef4444;
  }

  .sensor-mark[data-mark='second-centerline'] {
    stroke: #f59e0b;
  }

  .trace-stop {
    fill: none;
    stroke: #ef4444;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
`;

/** How big the screen-constant parts of this layer are drawn, in image pixels. */
export interface CenterlineSymbolSize {
  /** A point handle's radius, and the arm of a mark's cross. */
  readonly handlePx: number;
}

/**
 * One traced centerline.
 *
 * @param line The centerline, in image pixels.
 * @param size The screen-constant handle radius, in image pixels —
 *   `rr-viewer`'s `symbolSize` scaled, so handles stay the same size at any
 *   zoom.
 * @param selected Whether its points are shown. **Points are drawn only when
 *   selected**: a run carries one every gauge, so drawing every handle of every
 *   line would bury the photograph under dots and make the line itself
 *   unreadable. Selecting is what "shows its points" means (#275).
 * @param highlighted Whether a reveal points at this line — the shared glow,
 *   on the group.
 */
export function renderCenterline(
  line: Centerline,
  size: CenterlineSymbolSize,
  selected = false,
  highlighted = false
): SVGTemplateResult {
  return svg`
    <g class="centerline ${highlighted ? HIGHLIGHT_CLASS : ''}" data-centerline-id="${line.id}">
      <polyline class="line ${selected ? 'selected' : ''}" points="${pointsAttr(line.points)}" />
      ${selected
        ? line.points.map(
            (point, index) => svg`<circle
              class="handle"
              data-point-index="${index}"
              cx="${point.x}"
              cy="${point.y}"
              r="${size.handlePx}"
            />`
          )
        : ''}
    </g>
  `;
}

/**
 * The run being traced: its points so far, dashed, with a handle on each.
 *
 * Dashed because it is not stored yet — the same thing a rubber band says for a
 * chain of cars. Every point gets a handle whatever the selection, because this
 * is the object the person is looking at.
 */
export function renderPendingRun(
  points: readonly Point[],
  size: CenterlineSymbolSize
): SVGTemplateResult {
  return svg`
    <g class="centerline">
      <polyline class="line pending" points="${pointsAttr(points)}" />
      ${points.map(
        point => svg`<circle class="handle" cx="${point.x}" cy="${point.y}" r="${size.handlePx}" />`
      )}
    </g>
  `;
}

/** A sensor's patch outline: the rectangle the classifier will judge. */
export function renderPatch(corners: CarCorners): SVGTemplateResult {
  return svg`<polygon class="patch" points="${pointsAttr(corners)}" />`;
}

/** Which mark a sensor carries. */
export type SensorMark = 'no-track' | 'second-centerline';

/**
 * A sensor's mark: a cross for no track under it, a ring for a second
 * centerline within reach of its patch.
 *
 * Two shapes rather than two colours alone, for the reason every marker here is
 * told apart by shape: the ink lands on an arbitrary photograph, and a
 * red-on-red tunnel mouth must still read.
 */
export function renderSensorMark(
  sensor: Sensor,
  mark: SensorMark,
  size: CenterlineSymbolSize
): SVGTemplateResult {
  const arm = size.handlePx * 2.5;
  const { x, y } = sensor;
  return svg`
    <g class="sensor-mark" data-mark="${mark}" data-sensor-id="${sensor.id}">
      ${mark === 'no-track'
        ? svg`<path d="M ${x - arm} ${y - arm} L ${x + arm} ${y + arm} M ${x + arm} ${y - arm} L ${x - arm} ${y + arm}" />`
        : svg`<circle cx="${x}" cy="${y}" r="${arm}" />`}
    </g>
  `;
}

/**
 * A spot where a trace stopped short: a turnout, a crossing, clutter, the frame
 * edge, or a car standing on the track.
 *
 * Not stored and not undoable (#275) — it is a fact about the photograph rather
 * than an edit — so it is drawn from the session's own list and vanishes with
 * the session.
 */
export function renderTraceStop(at: Point, size: CenterlineSymbolSize): SVGTemplateResult {
  const arm = size.handlePx * 1.8;
  return svg`
    <path
      class="trace-stop"
      d="M ${at.x - arm} ${at.y - arm} L ${at.x + arm} ${at.y + arm} M ${at.x + arm} ${at.y - arm} L ${at.x - arm} ${at.y + arm}"
    />
  `;
}

/**
 * What the centerlines say about one sensor, as the two things a renderer needs:
 * the patch to outline and the mark to put on it.
 *
 * Derived here rather than passed in, the way `rr-viewer` derives couplings: the
 * inputs are the sensor, the lines and the DPT, all of which the viewer already
 * holds, and a caller computing it would be a second place for the patch's size
 * and the marks' thresholds to be decided.
 *
 * **Nothing is answered while no centerline is traced.** With an empty list
 * every sensor is more than half a gauge from every centerline and would wear a
 * no-track cross, which on a freshly opened archive is a hundred crosses saying
 * nothing. A mark is a claim that *this tracing* missed a sensor, and there is
 * no tracing to have missed one. It is also what keeps the live view clear: it
 * passes no centerlines, so it draws none of this (#275).
 */
export interface SensorPatch {
  readonly patch: CarCorners | null;
  readonly mark: SensorMark | null;
}

export function sensorPatch(
  sensor: Sensor,
  centerlines: readonly Centerline[],
  dpt: number | null
): SensorPatch {
  if (centerlines.length === 0 || dpt === null) return { patch: null, mark: null };
  const track = sensorTrack({ x: sensor.x, y: sensor.y }, centerlines, dpt);
  return {
    // No patch where no track is under the sensor: there is no direction to
    // turn one to, and a sensor with no centerline under it reads unknown.
    patch: track.noTrack
      ? null
      : patchCorners({ x: sensor.x, y: sensor.y }, track.nearest?.direction ?? { x: 0, y: 0 }, dpt),
    // No track wins: a sensor that is on no track has no second one to warn
    // about, and two marks on one symbol would read as two problems.
    mark: track.noTrack ? 'no-track' : track.secondCenterline ? 'second-centerline' : null,
  };
}

/** `x,y x,y …` for a `points` attribute. */
function pointsAttr(points: readonly Point[]): string {
  return points.map(point => `${point.x},${point.y}`).join(' ');
}
