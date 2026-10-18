import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { ReferencePoint, WorldPoint } from '@rails49/r49';
import { placeLabel } from './geometry.js';
import type { FrameSize } from './geometry.js';
import { HIGHLIGHT_CLASS } from './highlight.js';

/**
 * Calibration-point rendering for SVG: a crosshair labelled with its world
 * coordinate.
 *
 * A module rather than a custom element for the same reason `marker.ts` is —
 * custom elements break the SVG namespace when nested inside `<svg>`. Its two
 * exports **must be used together**: `calibrationMarkerStyles` in the host's
 * `static styles`, the renderer once per point.
 *
 * Why a crosshair and not another symbol from `marker.ts`: a calibration point
 * must be visually unmistakable from everything else the editor draws
 * (`SPEC.md` § Reference points), and the sensor tool that arrives next needs a
 * symbol that cannot be confused with this one. A crosshair also shows the
 * *exact* pixel it names, which a boxed icon does not.
 */

export const calibrationMarkerStyles: CSSResult = css`
  .calibration-point {
    /* One literal for the whole symbol. Not an --sl-* token: this is ink on an
       arbitrary photograph, not chrome, and it has to stay legible against both
       a dark tunnel mouth and a bright backdrop. */
    --calibration-ink: #22d3ee;
  }

  .calibration-point line,
  .calibration-point circle {
    stroke: var(--calibration-ink);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }

  .calibration-point circle {
    fill: none;
  }

  .calibration-point text {
    fill: var(--calibration-ink);
    /* The photograph underneath is arbitrary, so the label carries its own
       contrast rather than relying on what it happens to sit on. */
    stroke: rgba(0, 0, 0, 0.75);
    stroke-width: 3;
    paint-order: stroke;
    /* Monospace is what makes the label's width estimable without measuring
       it — placeLabel counts characters. Changing this face changes what the
       edge flip is deciding against. */
    font-family: var(--sl-font-mono, monospace);
    /* text-anchor and dominant-baseline are deliberately absent: the edge flip
       sets both per element, and a rule here would beat the presentation
       attribute and pin every label to one corner. */
  }
`;

/**
 * One millimetre value, at one decimal and without trailing-zero noise.
 *
 * Coordinates are typed by hand, so they are whole millimetres in practice; a
 * dragged point (issue #30) will not be, and `0.30000000000000004` in a label
 * reads as a bug in the editor rather than as arithmetic.
 */
function formatMm(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** `x, y, z mm` — the frame's origin is arbitrary, so only the numbers matter. */
function formatWorld(world: WorldPoint): string {
  return `${formatMm(world.x)}, ${formatMm(world.y)}, ${formatMm(world.z)} mm`;
}

/**
 * A calibration point as a crosshair labelled with its world coordinate.
 *
 * @param point The point, in image pixels and millimetres.
 * @param index Its position in `layout.calibration.points`. Points carry no
 *   `id` — nothing references one individually — so the index is the only
 *   handle a gesture has on one, and it is rendered as `data-calibration-index`
 *   for tests and for debugging.
 * @param size Symbol size in **image pixels**, which the viewer recomputes from
 *   the viewport so the crosshair stays a constant size on screen.
 * @param frame The image's bounds, `rr-viewer`'s `resolution`. Only the label
 *   reads it, to flip inwards at an edge instead of being clipped; the
 *   crosshair is drawn on its pixel wherever that pixel is.
 * @param highlighted Whether a reveal is pointing at this point (#37) — the
 *   shared glow from `highlight.ts`. The caller resolves *which* point that is
 *   by pixel rather than by this index, since an undo renumbers the list.
 */
export function renderCalibrationPoint(
  point: ReferencePoint,
  index: number,
  size: number,
  frame: FrameSize,
  highlighted = false
): SVGTemplateResult {
  const { x, y } = point.px;
  const arm = size / 2;
  const gap = size * 0.18;

  const label = formatWorld(point.world);
  const fontSize = size * 0.42;
  // Up and to the right when there is room, flipped inwards at the top or
  // right edge. The rule is shared with the sensor symbol (#31) and decided
  // from an *estimated* label width — see `placeLabel`.
  const placement = placeLabel({ x, y }, label, fontSize, gap * 1.6, frame);

  return svg`
    <g
      class="calibration-point ${highlighted ? HIGHLIGHT_CLASS : ''}"
      data-calibration-index="${index}"
    >
      <line x1="${x - arm}" y1="${y}" x2="${x + arm}" y2="${y}" />
      <line x1="${x}" y1="${y - arm}" x2="${x}" y2="${y + arm}" />
      <circle cx="${x}" cy="${y}" r="${gap}" />
      <text
        x="${placement.x}"
        y="${placement.y}"
        text-anchor="${placement.textAnchor}"
        dominant-baseline="${placement.dominantBaseline}"
        font-size="${fontSize}"
      >
        ${label}
      </text>
    </g>
  `;
}
