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
 */
export type UnknownReason = 'no-model' | 'no-calibration' | 'outside-frame' | 'drift';

/**
 * The [margin](../../GLOSSARY.md#occupancy), in track gauges: how far beyond a
 * car's end, along the track, a sensor still reads occupied.
 *
 * [ADR 0023](../../docs/adr/0023-occupied-has-a-two-gauge-margin.md). A miss
 * costs a collision, so a car *close to* a sensor counts; and one definition of
 * "close" lets the detector and the classifier be combined by "either says
 * occupied" and scored against the same ground truth.
 *
 * It is a count of gauges rather than of pixels because the quantity is a
 * distance on the layout. 1 G is `dpt` pixels, so the box tested is
 * `length + 4·dpt` long, and the same rule holds at DPT 8 and DPT 40.
 *
 * The margin also absorbs lean: seen from one camera a car's roof appears up to
 * about 2 G farther from the image centre than its wheels, which lengthens an
 * apparent span and never shortens it. No lean correction is made — car heights
 * vary too much for a single one, and correcting would turn some of this false
 * occupied into misses.
 */
export const MARGIN_G = 2;

/**
 * One sensor's L1 state.
 *
 * `occupied` carries the covering detection rather than a bare confidence:
 * nothing is lost (`detection.confidence`) and a consumer debugging a phantom
 * can highlight *which* box answered. `clear` carries no confidence at all —
 * absent, not `0.0` and not `1.0` — because nothing scored it; that is what
 * keeps a miss from arriving as a confident-looking number with no measurement
 * behind it.
 */
export type SensorState =
  | { readonly state: 'occupied'; readonly detection: Detection }
  | { readonly state: 'clear' }
  | { readonly state: 'unknown'; readonly reason: UnknownReason };

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
 * The box tested is **width-normalized**: centre, orientation and length come
 * from the detector, but `carWidthPx(dpt)` replaces the predicted width. Width
 * is a fit to a constant, so its deviation is pure error and directional: at
 * DPT 20 a car is ~42 px wide, so a centreline sensor sits ~21 px inside the
 * boundary, and an under-predicted 25 px width cuts that to ~12 px and can flip
 * a covered sensor to `clear`. Substituting the constant only ever widens an
 * under-predicted box, which is the safe direction.
 *
 * It is also **lengthened**, by {@link MARGIN_G} at each end along its long
 * axis ([ADR 0023](../../docs/adr/0023-occupied-has-a-two-gauge-margin.md)): a
 * sensor a car has not quite reached reads `occupied`, because a miss costs a
 * collision. Only the length moves — across the axis the half-width is
 * unchanged, so the margin never reaches a sensor on the next track. No
 * detection is matched to a centerline; the lengthened box is tested the way
 * the raw-length one was, and nothing here decides which track a detection is
 * on.
 *
 * Both changes are L1's geometry. L0 still reports the raw box — and the
 * `Detection` returned on `occupied` is the raw one, at its own length.
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
  const marginPx = MARGIN_G * dpt;

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

    states.set(sensor.id, best === null ? { state: 'clear' } : { state: 'occupied', detection: best });
  }

  return states;
}

function unknown(reason: UnknownReason): SensorState {
  return { state: 'unknown', reason };
}

/**
 * Whether an oriented box of the given width, lengthened by `marginPx` at each
 * end, **strictly contains** a point.
 *
 * Tested in the box's own axes rather than against its corners: a point is
 * inside when its along-axis and across-axis offsets from the centre are both
 * within the respective half-extents. Four corners and a winding rule would
 * answer the same question with more ways to be wrong. The margin is therefore
 * one addition to one half-extent, and lands along the **box's** axis at any
 * angle, with nothing to keep in step.
 *
 * The margin is handed in rather than derived here from DPT, so the two numbers
 * that shape the box arrive the same way and this stays the geometry with no
 * calibration in it. {@link occupancy} computes it once per frame as
 * {@link MARGIN_G} × DPT, and is the only caller.
 *
 * Still **strict**, and still with no tolerance epsilon, per SPEC — the margin
 * is not one. An epsilon would be an unvalidatable fudge at the boundary;
 * {@link MARGIN_G} is a stated distance with a reason, and the boundary it
 * moves to is as hard as the old one. At a coupler two boxes abut on a shared
 * endpoint, so a point between coupled cars was already inside one of them
 * before any margin existed.
 *
 * Exported for its tests only: `occupancy` is the only caller.
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
