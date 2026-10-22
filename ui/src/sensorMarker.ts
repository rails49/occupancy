import { svg, css } from 'lit';
import type { SVGTemplateResult, CSSResult } from 'lit';
import type { Sensor } from '@rails49/r49';
import type { SensorState, UnknownReason } from './occupancy.js';
import { placeLabel } from './geometry.js';
import type { FrameSize } from './geometry.js';
import { HIGHLIGHT_CLASS } from './highlight.js';

/**
 * Sensor rendering for SVG: a ringed diamond labelled with its name, or with
 * its id when it has none.
 *
 * A module rather than a custom element, like `marker.ts` and
 * `calibrationMarker.ts` — custom elements break the SVG namespace when nested
 * inside `<svg>`. `sensorMarkerStyles` and `renderSensor` **must be used
 * together**: the styles in the host's `static styles`, the renderer once per
 * sensor. `sensorLabelText` is separable — it answers what a sensor is called,
 * which a consumer may want without drawing anything.
 *
 * **The symbol is deliberately unlike the calibration crosshair** in shape and
 * in colour: `SPEC.md` § Reference points requires calibration points to be
 * placed with a tool distinct from the sensor tool and to be visually
 * unmistakable from one. A crosshair is two crossing arms in cyan; a sensor is a
 * closed amber diamond, so the two are told apart at a glance and by shape alone
 * on a photograph that happens to be cyan or amber.
 *
 * The diamond is also honest about what a sensor *is*: a single query point
 * (`SPEC.md` § Location Data), so the symbol closes around the pixel it names
 * rather than extending arms that could be read as an extent.
 */

export const sensorMarkerStyles: CSSResult = css`
  .sensor {
    /* One literal for the whole symbol, for the same reason the crosshair has
       one: this is ink on an arbitrary photograph rather than chrome, and it
       must stay legible over both a dark tunnel mouth and a bright backdrop.
       Amber against the crosshair's cyan — the two symbols never read as the
       same object. */
    --sensor-ink: #f59e0b;
  }

  /* L1, as colour on the symbol the sensor already is (#85). **Shape carries
     identity and colour carries state** — a diamond is a sensor whatever it
     reads, so a state that changed the glyph would make a sensor stop looking
     like one at exactly the moment it is being watched. Only the ink literal
     moves, so the diamond, its core and its label recolour together, the same
     one-override mechanism .car.unknown-class uses.

     Red for occupied and green for clear rather than the reverse: this mirrors
     prototype signalling and the deliberate bias of SPEC.md § The vocabulary,
     where a failure shows occupied. Grey for unknown because it is the
     absence of an answer — "I was unable to look" — and a third saturated
     colour would read as a third measurement. An **unstated** state keeps the
     authored amber: that is the editor, where a sensor is a thing being placed
     rather than a thing being read. */
  .sensor[data-state='occupied'] {
    --sensor-ink: #ef4444;
  }

  .sensor[data-state='clear'] {
    --sensor-ink: #22c55e;
  }

  .sensor[data-state='unknown'] {
    --sensor-ink: #94a3b8;
  }

  .sensor polygon {
    stroke: var(--sensor-ink);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    /* Translucent rather than hollow: the fill is what makes the diamond read
       as one closed symbol at thumbnail size, and it still shows the track
       underneath, which is what the sensor is placed against.

       The ink and an opacity rather than one rgba() literal, so the fill
       follows the state override above — a literal would leave an occupied
       sensor outlined in red and washed in amber. */
    fill: var(--sensor-ink);
    fill-opacity: 0.18;
  }

  .sensor circle {
    fill: var(--sensor-ink);
    stroke: none;
  }

  .sensor text {
    fill: var(--sensor-ink);
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
 * What a sensor is labelled with: its `name`, or its `id` when it has none.
 *
 * `name` is optional, free text, not unique, and **never auto-generated**;
 * consumers key on `id` (`SPEC.md` § Occupancy Output). So the fallback is the
 * id itself rather than an invented "Sensor 3", which would be indistinguishable
 * from a name a human chose and would silently stop matching as sensors come and
 * go. A blank or whitespace-only name is treated as no name — it identifies
 * nothing, and showing it would leave the symbol looking unlabelled.
 */
/**
 * Smallest the centre dot is drawn, in image pixels.
 *
 * The diamond is a world size and can be genuinely tiny — a track at DPT 18 is
 * 18 image pixels across, and less on a wider frame — but the dot names the
 * pixel the sensor *is*, which has to stay findable at any scale. A stroke
 * would not do: the diamond's outline is already non-scaling, and two
 * non-scaling strokes at a small size merge into a blob.
 */
const MIN_CORE_RADIUS_PX = 1.5;

export function sensorLabelText(sensor: Sensor): string {
  const name = sensor.name?.trim();
  return name ? name : sensor.id;
}

/**
 * How big to draw a sensor, in image pixels — **two independent sizes, and the
 * split is the point.**
 *
 * The diamond is a **world** size: one track width across (`geometry.ts`'s
 * `trackWidthPx`), so it shrinks with the photograph and a sensor's footprint
 * is directly comparable to the cars around it. The label is a **screen** size,
 * held constant by the viewer's `symbolSize`: it is annotation about the
 * sensor, not a measurement of it, and a name scaled to the track would be
 * illegible at the DPT 18–19 the fixture corpus sits at.
 */
export interface SensorSymbolSize {
  /** Diameter of the diamond, corner to corner — one track width. */
  readonly diameterPx: number;
  /** Label font size, constant on screen at any zoom. */
  readonly labelPx: number;
}

/**
 * Why the system could not answer, in words.
 *
 * A total `Record` rather than a `switch` with a default: `UnknownReason` grows,
 * and a default would render a new reason as whatever the fallback string says
 * while typechecking cleanly. This way adding one is a compile error here — as
 * `drift` was when it landed (#94), which is the mechanism working.
 */
const UNKNOWN_REASONS: Record<UnknownReason, string> = {
  'no-model': 'no model loaded',
  'no-calibration': 'no calibration — DPT does not resolve',
  'outside-frame': 'outside the frame',
  // The only refusal in the set: everything needed to answer is present, and
  // the answer is withheld because the camera moved. The banner carries the
  // number and the override; a tooltip is not where a user acts on either.
  drift: 'camera has drifted — refusing to classify',
};

/**
 * The state as a tooltip: the word, and for `unknown` what stopped it.
 *
 * `occupied` names its evidence — a covering detection's confidence — and
 * `clear` deliberately names none. That asymmetry is `SPEC.md` § Confidence
 * verbatim: `clear` is the *absence* of evidence and nothing scored it, so a
 * number here would be the confident-looking miss the spec exists to prevent.
 */
function stateTooltip(state: SensorState): string {
  switch (state.state) {
    case 'occupied':
      return `occupied — ${Math.round(state.detection.confidence * 100)}% confidence`;
    case 'clear':
      return 'clear';
    case 'unknown':
      return `unknown — ${UNKNOWN_REASONS[state.reason]}`;
  }
}

/**
 * A sensor as a ringed diamond labelled with its name or id.
 *
 * @param sensor The sensor, in image pixels.
 * @param size The diamond's diameter and the label's font size, both in image
 *   pixels and deliberately unrelated — see {@link SensorSymbolSize}.
 * @param frame The image's bounds, `rr-viewer`'s `resolution`. Only the label
 *   reads it, to flip inwards at an edge instead of being clipped; the diamond
 *   is drawn on its pixel wherever that pixel is.
 * @param highlighted Whether a reveal is pointing at this sensor (#37) — the
 *   shared glow from `highlight.ts`, on the group so the label is lit with it.
 * @param state This sensor's L1 state, or `null` where nothing is reading it —
 *   the editor, which authors sensors rather than answering them. Passed as the
 *   whole {@link SensorState} rather than the bare tag so `unknown` can say
 *   *why* in its tooltip: "outside the frame" and "no model loaded" want
 *   different things done about them, and the colour cannot tell them apart.
 */
export function renderSensor(
  sensor: Sensor,
  size: SensorSymbolSize,
  frame: FrameSize,
  highlighted = false,
  state: SensorState | null = null
): SVGTemplateResult {
  const { x, y } = sensor;
  const arm = size.diameterPx / 2;
  // The core marks the exact pixel and must stay visible when the track is a
  // few pixels across, so it is a floor rather than a fraction of the diamond.
  const core = Math.max(size.diameterPx * 0.12, MIN_CORE_RADIUS_PX);

  const label = sensorLabelText(sensor);
  // The gap follows the label, not the diamond: it separates text from symbol,
  // and a world-scaled gap would put the name inside a large sensor and a track
  // away from a small one.
  const placement = placeLabel({ x, y }, label, size.labelPx, size.labelPx * 0.7, frame);

  return svg`
    <g
      class="sensor ${highlighted ? HIGHLIGHT_CLASS : ''}"
      data-sensor-id="${sensor.id}"
      data-state="${state ? state.state : ''}"
    >
      ${state ? svg`<title>${stateTooltip(state)}</title>` : ''}
      <polygon points="${x},${y - arm} ${x + arm},${y} ${x},${y + arm} ${x - arm},${y}" />
      <circle cx="${x}" cy="${y}" r="${core}" />
      <text
        x="${placement.x}"
        y="${placement.y}"
        text-anchor="${placement.textAnchor}"
        dominant-baseline="${placement.dominantBaseline}"
        font-size="${size.labelPx}"
      >
        ${label}
      </text>
    </g>
  `;
}
