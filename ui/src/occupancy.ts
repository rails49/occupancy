import { carWidthPx } from '@rails49/detector';
import type { Detection, Frame } from '@rails49/detector';
import type { Point, Sensor } from '@rails49/r49';

/**
 * Why a sensor could not be answered.
 *
 * `drift` is the one that is a **refusal** rather than an absence: a model is
 * loaded, calibration resolves, the sensor is in frame, and the answer is still
 * withheld because the camera no longer sees what the archive was authored
 * against. It was omitted from this union until `@occupancy/drift` could produce
 * it (issue #12 → #94); the other three describe missing capability, and this
 * one describes measurement that would be wrong.
 *
 * `no-service` and `not-reported` are this page's findings about an occupancy
 * service (#331): its answer could not be read, or it named no state for a
 * sensor in its manifest. A cause the service itself reports is its own words,
 * in `serviceReason`.
 */
export type UnknownReason =
  | 'no-model'
  | 'no-calibration'
  | 'outside-frame'
  | 'drift'
  | 'no-service'
  | 'not-reported';

/**
 * One sensor's L1 state.
 *
 * `occupied` carries `confidence`, and the covering `detection` where there
 * is one: geometry over L0 answers with a box, and a classifier answers with
 * P(occupied) and no box at all (ADR 0022), so the number is the part every
 * occupied state has. Where the box is there too nothing is lost, and a
 * consumer debugging a phantom can still highlight *which* box answered.
 * `clear` carries no confidence at all — absent, not `0.0` and not `1.0` —
 * because nothing scored it; that is what keeps a miss from arriving as a
 * confident-looking number with no measurement behind it.
 *
 * `unknown` comes in two shapes, and the split is a compile-time check rather
 * than a style. A cause this page found is one of a closed set, so
 * `sensorMarker.ts` words each one in a total `Record` and a new cause is a
 * type error there. A cause an occupancy service found is the service's, which
 * this page cannot enumerate and must not reword, so it arrives as
 * `serviceReason` and is shown as sent (#331).
 */
export type SensorState =
  | { readonly state: 'occupied'; readonly confidence: number; readonly detection?: Detection }
  | { readonly state: 'clear' }
  | { readonly state: 'unknown'; readonly reason: UnknownReason }
  | { readonly state: 'unknown'; readonly serviceReason: string };

/**
 * The margin, in gauges: how far beyond a car's end, along the track, a sensor
 * still reads occupied (`GLOSSARY.md` § Margin).
 *
 * Two, from [ADR 0023](../../docs/adr/0023-occupied-has-a-two-gauge-margin.md).
 * A miss costs a collision, so a car that comes within 2 G of a sensor counts
 * as occupying it; and one definition for the detector and the classifier is
 * what lets the two be combined by "either says occupied" and scored against
 * the same ground truth. It is also what the occupancy service defaults to, so
 * a number here is the page agreeing with the service rather than each holding
 * its own.
 *
 * It is a count of *gauges*, not pixels: 1 G is `dpt` pixels, so `occupancy()`
 * multiplies it by the layout's DPT and that is the only place the conversion
 * happens — the same shape `driftSession.ts`'s `MAX_DRIFT_TRACK_FRACTION`
 * takes. Not an input to `occupancy()`: the margin is SPEC's number for this
 * page, and a caller choosing its own would be a second answer for one
 * question.
 */
export const MARGIN_GAUGES = 2;

/**
 * L1: per-sensor occupancy, as a pure function of L0.
 *
 * Never calls a second model, so it cannot contradict the boxes drawn beside
 * it, needs no second inference, and costs the same whether a layout has three
 * sensors or three hundred — the detector runs once per frame regardless.
 *
 * **Total**: one entry per sensor, always. `detections` and `dpt` are nullable
 * because three of SPEC's `unknown` causes are conditions of the *system*, not
 * of the geometry, and folding them in here is what stops the live view and the
 * diagnostics view from each building unknown-maps in their own branches —
 * three places that would have to agree about a contract SPEC wrote once.
 *
 * The box tested is **lengthened by the margin**: {@link MARGIN_GAUGES} at
 * each end along its long axis, so a box of `length` is tested as
 * `length + 4 × dpt` (ADR 0023). A sensor a car is about to reach reads
 * occupied, because a miss costs a collision. Across the axis nothing is added.
 *
 * It is also **width-normalized**: centre, orientation and length come
 * from the detector, but `carWidthPx(dpt)` replaces the predicted width. Width
 * is a fit to a constant, so its deviation is pure error and directional: at
 * DPT 20 a car is ~42 px wide, so a centreline sensor sits ~21 px inside the
 * boundary, and an under-predicted 25 px width cuts that to ~12 px and can flip
 * a covered sensor to `clear`. Substituting the constant only ever widens an
 * under-predicted box, which is the safe direction. L0 still reports the raw
 * box — and the `Detection` returned on `occupied` is the raw one.
 *
 * @param input.detections L0 for this frame, or `null` when no model is loaded.
 * @param input.sensors    The layout's sensors, in `frame` coordinates.
 * @param input.dpt        Resolution in dots per track, or `null` when the
 *                         layout is uncalibrated.
 * @param input.frame      The frame sensors and detections are expressed in —
 *                         `camera.resolution`, normally.
 * @param input.drifted    Whether the camera has moved away from the pose the
 *                         archive was authored against — `@occupancy/drift`
 *                         measured against a fraction of a track width
 *                         (`MAX_DRIFT_TRACK_FRACTION` in `driftSession.ts`). Optional,
 *                         defaulting to `false`, because a caller with no drift
 *                         check running is not asserting that the camera is
 *                         steady — it is saying it does not know, and that was
 *                         every caller before #94.
 */
export function occupancy(input: {
  detections: readonly Detection[] | null;
  sensors: readonly Sensor[];
  dpt: number | null;
  frame: Frame;
  drifted?: boolean;
}): ReadonlyMap<string, SensorState> {
  const { detections, sensors, dpt, frame, drifted = false } = input;
  const states = new Map<string, SensorState>();

  // Precedence: the whole-system conditions first, then the per-sensor one.
  // A sensor outside the frame of a layout with no model loaded is unanswerable
  // for both reasons; reporting the system-wide cause is the one that tells a
  // human what to fix.
  //
  // Drift comes first of all, and that ordering is the refusal. The other three
  // reasons say a measurement could not be made; this one says a measurement
  // could, and must not be trusted — so it outranks them rather than waiting
  // behind a missing model for its turn. It is also the only one that survives
  // being fixed elsewhere: build the model, calibrate the layout, and a drifted
  // camera is still drifted.
  if (drifted) {
    for (const sensor of sensors) states.set(sensor.id, unknown('drift'));
    return states;
  }
  if (detections === null) {
    for (const sensor of sensors) states.set(sensor.id, unknown('no-model'));
    return states;
  }
  if (dpt === null) {
    for (const sensor of sensors) states.set(sensor.id, unknown('no-calibration'));
    return states;
  }

  const widthPx = carWidthPx(dpt);
  const marginPx = MARGIN_GAUGES * dpt;

  for (const sensor of sensors) {
    if (sensor.x < 0 || sensor.x > frame.width || sensor.y < 0 || sensor.y > frame.height) {
      states.set(sensor.id, unknown('outside-frame'));
      continue;
    }

    // Where several boxes cover the point the highest-confidence one wins, per
    // SPEC. Every covering detection makes the sensor `occupied` — including
    // low-confidence ones; the threshold was already applied during decoding,
    // and `unknown` is never a confidence outcome.
    let best: Detection | null = null;
    for (const detection of detections) {
      if (!covers(detection, widthPx, marginPx, sensor)) continue;
      if (best === null || detection.confidence > best.confidence) best = detection;
    }

    states.set(
      sensor.id,
      best === null
        ? { state: 'clear' }
        : { state: 'occupied', confidence: best.confidence, detection: best }
    );
  }

  return states;
}

function unknown(reason: UnknownReason): SensorState {
  return { state: 'unknown', reason };
}

/**
 * Whether an oriented box of the given width, lengthened by the margin at both
 * ends, **strictly contains** a point.
 *
 * Tested in the box's own axes rather than against its corners: a point is
 * inside when its along-axis and across-axis offsets from the centre are both
 * within the respective half-extents. Four corners and a winding rule would
 * answer the same question with more ways to be wrong.
 *
 * The margin lengthens the box **along its long axis only** — half-extent
 * `length / 2 + marginPx` — and the across-axis extent stays the half-width it
 * was handed. Lengthening the sides as well would reach the next track over,
 * where parallel sidings sit ~60 px apart at DPT 20, and that direction already
 * carries ~1.4 m prototype of slack from the derived width.
 *
 * No tolerance epsilon on top of the margin, per SPEC: the margin is the
 * tolerance, it is a measured number (ADR 0023), and a second one would not be.
 * So containment is strict at the lengthened boundary, and a gap between
 * uncoupled cars wider than two margins — over 4 G — still reads `clear`. At a
 * coupler the two boxes already abut on a shared endpoint, and with the margin
 * they overlap, so a point between coupled cars is inside both.
 *
 * The margin is passed in rather than derived here from DPT, because this
 * function knows pixels and nothing else: `occupancy` holds the one conversion
 * from gauges, beside the width constant it resolves from the same DPT.
 *
 * Exported for its tests only: `occupancy` is the only caller.
 *
 * @param widthPx  The box's full width in pixels — `carWidthPx(dpt)`, not the
 *                 detector's predicted width.
 * @param marginPx How far past each end still counts, in pixels:
 *                 {@link MARGIN_GAUGES} gauges, which is `MARGIN_GAUGES * dpt`.
 */
export function covers(
  detection: Detection,
  widthPx: number,
  marginPx: number,
  point: Point
): boolean {
  const dx = point.x - detection.centre.x;
  const dy = point.y - detection.centre.y;
  const ux = Math.cos(detection.angle);
  const uy = Math.sin(detection.angle);

  const along = dx * ux + dy * uy;
  const across = -dx * uy + dy * ux;

  return Math.abs(along) < detection.length / 2 + marginPx && Math.abs(across) < widthPx / 2;
}
