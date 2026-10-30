import type { GrayPlane } from '@occupancy/drift';
import type { Point } from '@rails49/r49';

/**
 * The snap: where the middle of the track is, from the image's own pixels.
 *
 * A pure function of the pixels, a point, a direction and the gauge in pixels
 * (#275). It reads a {@link GrayPlane} and nothing else — no canvas, no DOM, no
 * manifest — so a jsdom test can hand it a synthetic two-rail image and check
 * where it puts the point, which is the whole reason it is not inside the tool.
 * `@occupancy/drift`'s plane is the parameter type for the same reason that
 * package chose it: it exists in Node as well as a browser, so nothing here is
 * locked to the platform that happens to call it first.
 *
 * **Mirror symmetry, not a rail detector** (ADR 0021). Rails, ties and roadbed
 * are all symmetric about the centerline, so the middle of the track is the
 * offset where a cross-section most nearly equals its own reflection. Nothing
 * here looks for a rail, measures a rail's width, or assumes a railhead is
 * bright — which is what lets it work on ballast, on a tie plate and in shadow,
 * and what makes it fail honestly where the symmetry is genuinely gone.
 *
 * **The score is read off a band, not the whole section.** A single rail is
 * perfectly symmetric about *itself*, so a score taken across the full
 * cross-section would happily snap a point onto one rail with the other hidden
 * — half a gauge wrong, and confident. Excluding the middle
 * {@link SCORE_INNER_G} leaves the score reading the two railheads, the roadbed
 * shoulders and whatever else sits off-centre: structure that one rail cannot
 * fake, because the band on its far side is then plain ballast.
 *
 * **It sees every mirror symmetry, including the wrong ones.** A parallel pair
 * of tracks is symmetric about the midline *between* them, and that symmetry
 * scores as well as either track's own. {@link SNAP_RANGE_G} is what keeps it
 * out of reach, and the bound is real rather than lucky: the midline of a pair
 * is half their spacing away, so a pair would have to be closer than
 * `2 × SNAP_RANGE_G` — a gauge and a half — centre to centre, and two cars 2.09
 * gauges wide cannot pass on a pair that close. Turnouts and crossings have no
 * such bound, which is why they are not traced at all (ADR 0021).
 *
 * **{@link MIN_SYMMETRY} is not tuned.** It is a placeholder, set so the
 * synthetic cases in `tests/centerlineSnap.test.ts` come out right. Picking the
 * real one means trying the snap on the layout's own photographs and judging the
 * marks it leaves, which is a person's job and the reason #275 was not handed
 * to an agent whole. It errs **strict**: too high a floor leaves the tool
 * refusing visibly, and too low a one stores points half a gauge off without
 * saying anything.
 */

/** Width of the cross-section the score is read from, in gauges. */
export const CROSS_SECTION_G = 3;

/**
 * Radius around the candidate point left out of the score, in gauges.
 *
 * A quarter of a gauge — inside the rails. What is in there is the gap between
 * them, which carries little about where the middle is and would let a lone rail
 * pass as a track. See the module comment.
 */
export const SCORE_INNER_G = 0.25;

/**
 * How far the snap may move a point across the track, in gauges.
 *
 * Three quarters. It has to reach past a rail, since a rough click often lands
 * on one; it must **not** reach the next track's middle, which on parallel
 * sidings is as close as a gauge and a half, or the snap would quietly move a
 * run onto its neighbour.
 */
export const SNAP_RANGE_G = 0.75;

/**
 * Spacing of the samples across a section, and of the offsets searched, in
 * gauges.
 *
 * One number for both: the search is as fine as the measurement, and a finer
 * search would only interpolate between samples it cannot tell apart. A
 * sixteenth of a gauge is 2 px at the ceiling archives' DPT 34, well inside the
 * quarter gauge #275 holds the snap to.
 */
export const SNAP_PITCH_G = 1 / 16;

/** The least symmetry score accepted as the middle of a track. @see MIN_SYMMETRY */
export const MIN_SYMMETRY = 0.8;

/** How far apart the points of a traced run are, in gauges. */
export const TRACE_STEP_G = 1;

/** Where the snap put a point, and how sure it is. */
export interface SnapResult {
  /** The snapped point. Fractional: it is a measurement, not a clicked pixel. */
  readonly at: Point;
  /**
   * How far across the track the snap moved the point, in image pixels. Signed
   * along the left-hand normal of `direction`, so its sign is the side.
   */
  readonly offsetPx: number;
  /** The symmetry score there, `-1`…`1`. */
  readonly score: number;
}

/**
 * The middle of the track nearest `at`, or `null` where the section is not
 * symmetric enough to say.
 *
 * `direction` is the way the track runs at `at`; it need not be a unit vector
 * and its sign does not matter. The section is taken perpendicular to it.
 *
 * `null` is the honest answer at a turnout, a crossing, clutter, an occluded
 * rail and the image edge, and the editor marks the spot rather than guessing
 * (#275). It is also the answer for a direction with no length — the first click
 * of a run has no direction yet, which is why it stays unsnapped until the
 * second click gives it one.
 *
 * Offsets are searched outwards from `at`, so the nearest of two equally
 * symmetric offsets wins: a tie means the image does not distinguish them, and
 * moving the point further than it has to would be a choice nothing supports.
 */
export function snapToTrack(
  plane: GrayPlane,
  at: Point,
  direction: Point,
  dpt: number
): SnapResult | null {
  const across = acrossAxis(direction);
  if (!across || !(dpt > 0)) return null;

  const pitch = SNAP_PITCH_G * dpt;
  const reach = Math.floor(SNAP_RANGE_G / SNAP_PITCH_G);
  let best: SnapResult | null = null;
  for (const step of outwards(reach)) {
    const offsetPx = step * pitch;
    const candidate = { x: at.x + across.x * offsetPx, y: at.y + across.y * offsetPx };
    const score = symmetryScore(plane, candidate, direction, dpt);
    if (score !== null && (best === null || score > best.score)) {
      best = { at: candidate, offsetPx, score };
    }
  }
  return best !== null && best.score >= MIN_SYMMETRY ? best : null;
}

/**
 * How nearly the cross-section at `at` equals its own reflection, `-1`…`1`.
 *
 * `1` is an exact mirror. The measure is the difference between the two halves
 * of the scored band against the spread of the band itself:
 *
 * ```
 * score = 1 − Σ(lᵢ − rᵢ)² / Σ((lᵢ − m)² + (rᵢ − m)²)
 * ```
 *
 * where `m` is the mean of every sample in the band. Both sums scale the same
 * way under a change of brightness or of contrast, so the score is unchanged by
 * either — one side of a layout is lit differently from the other, and a track
 * in shadow is still a track. Within a section three gauges wide, though, the
 * two halves of a real track are the *same* brightness as well as the same
 * shape, and this says so: a plain correlation would accept one half as any
 * positive multiple of the other, which is how a roadbed shoulder on one side
 * passes for a railhead on the other.
 *
 * `null` when the section leaves the image, or when the whole band is flat — a
 * reflection of nothing matches anything, and reporting 1 there would snap a
 * point onto blank sky.
 *
 * Exported because it is the measurement {@link MIN_SYMMETRY} is a threshold on,
 * and a threshold whose measurement cannot be inspected is untunable.
 */
export function symmetryScore(
  plane: GrayPlane,
  at: Point,
  direction: Point,
  dpt: number
): number | null {
  const across = acrossAxis(direction);
  if (!across || !(dpt > 0)) return null;

  const pitch = SNAP_PITCH_G * dpt;
  const inner = Math.ceil(SCORE_INNER_G / SNAP_PITCH_G);
  const outer = Math.floor(CROSS_SECTION_G / 2 / SNAP_PITCH_G);
  const left: number[] = [];
  const right: number[] = [];
  for (let i = inner; i <= outer; i++) {
    const d = i * pitch;
    const l = sample(plane, at.x - across.x * d, at.y - across.y * d);
    const r = sample(plane, at.x + across.x * d, at.y + across.y * d);
    if (l === null || r === null) return null;
    left.push(l);
    right.push(r);
  }
  return mirrorScore(left, right);
}

/** Why a trace between two clicks stopped where it did. */
export type TraceStop =
  /** It reached the closing click. The stretch is complete. */
  | 'reached'
  /** The snap found no symmetric section: a turnout, a crossing, clutter, the image edge. */
  | 'unclear'
  /** The next point would have fallen in a car's area. */
  | 'blocked'
  /** The rails led away from the closing click rather than towards it. */
  | 'astray';

/** The points a trace laid between two clicks, and where it stopped. */
export interface Trace {
  /**
   * The snapped points **between** the two clicks, in order, roughly
   * {@link TRACE_STEP_G} apart. Neither click is included: the caller owns those,
   * and the opening one may be unsnapped.
   */
  readonly points: readonly Point[];
  readonly stop: TraceStop;
  /**
   * Where stepping stopped short, for the editor to mark, or `null` when it
   * reached the click. The mark lasts the edit session and is not stored (#275).
   */
  readonly markAt: Point | null;
}

export interface TraceOptions {
  /**
   * Whether a point falls somewhere a trace may not go. Today that is a car's
   * area — `geometry.ts`'s `inCarArea` over the labels of the image being traced
   * — and the predicate keeps the rule about cars out of a module that reads
   * pixels.
   */
  readonly blocked?: (at: Point) => boolean;
}

/**
 * Fills the stretch between two clicks: a step of one gauge along the track,
 * snapped, repeated until the closing click is within a step.
 *
 * Predictor then corrector. The step goes along the direction the run is already
 * heading, which on a curve is the chord of the last step; the snap then puts
 * the point back on the middle of the track, which is what stops the error of
 * one step from becoming the error of the next. The direction of the first step
 * is the chord between the two clicks, since nothing else is known yet.
 *
 * It stops rather than guessing, four ways, and every stop short names a spot
 * for the editor to mark. `astray` is the turnout case the other way round: the
 * sections stayed symmetric but led down the other route, so the run is no
 * longer going where the click asked. Without it a trace could circle a loop
 * forever.
 */
export function traceAlong(
  plane: GrayPlane,
  from: Point,
  to: Point,
  dpt: number,
  options: TraceOptions = {}
): Trace {
  const points: Point[] = [];
  let direction = unitVector({ x: to.x - from.x, y: to.y - from.y });
  if (!direction || !(dpt > 0)) return { points, stop: 'reached', markAt: null };

  const step = TRACE_STEP_G * dpt;
  let previous = from;
  let closest = distance(from, to);
  // A backstop on the loop. The divergence test below is what actually ends a
  // run that wanders, but a cap means no image can hang the editor.
  const cap = Math.ceil(closest / step) * 2 + 2;

  for (let i = 0; i < cap; i++) {
    if (distance(previous, to) <= step) return { points, stop: 'reached', markAt: null };

    const ahead = {
      x: previous.x + direction.x * step,
      y: previous.y + direction.y * step,
    };
    const snapped = snapToTrack(plane, ahead, direction, dpt);
    if (!snapped) return { points, stop: 'unclear', markAt: ahead };
    if (options.blocked?.(snapped.at)) return { points, stop: 'blocked', markAt: snapped.at };

    const remaining = distance(snapped.at, to);
    // One whole gauge of slack: a step on a curve may hold its distance for a
    // moment without the run having gone anywhere else.
    if (remaining > closest + step) return { points, stop: 'astray', markAt: snapped.at };

    points.push(snapped.at);
    closest = Math.min(closest, remaining);
    direction =
      unitVector({ x: snapped.at.x - previous.x, y: snapped.at.y - previous.y }) ?? direction;
    previous = snapped.at;
  }
  return { points, stop: 'astray', markAt: previous };
}

/** `-reach…reach`, nearest first, so a tie in the score keeps the smaller move. */
function* outwards(reach: number): Generator<number> {
  yield 0;
  for (let k = 1; k <= reach; k++) {
    yield -k;
    yield k;
  }
}

/** The unit normal of `direction` — the across-track axis a section is taken on. */
function acrossAxis(direction: Point): Point | null {
  const along = unitVector(direction);
  return along && { x: along.y, y: -along.x };
}

function unitVector(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? null : { x: v.x / length, y: v.y / length };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The plane's value at a fractional position, bilinear, or `null` outside it.
 *
 * Outside is `null` rather than a clamp or a zero: a section that runs off the
 * frame has not been measured, and an invented edge pixel is exactly the
 * symmetry a point at the image's border would snap to.
 */
function sample(plane: GrayPlane, x: number, y: number): number | null {
  if (!(x >= 0 && y >= 0 && x <= plane.width - 1 && y <= plane.height - 1)) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, plane.width - 1);
  const y1 = Math.min(y0 + 1, plane.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const { data, width } = plane;
  const top = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
  const bottom = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * How nearly two equal-length series are each other, against their own spread,
 * or `null` when they carry no spread at all. See {@link symmetryScore}.
 */
function mirrorScore(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n === 0) return null;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] + b[i];
  const mean = sum / (2 * n);

  let difference = 0;
  let spread = 0;
  for (let i = 0; i < n; i++) {
    difference += (a[i] - b[i]) ** 2;
    spread += (a[i] - mean) ** 2 + (b[i] - mean) ** 2;
  }
  return spread === 0 ? null : 1 - difference / spread;
}
