import { carWidthPx } from '@rails49/detector';
import type { ReferencePoint, CarLabel, Point, Sensor } from '@rails49/r49';

/**
 * The editor's geometry, as pure functions.
 *
 * A plain module, not an element, and deliberately outside every component:
 * jsdom neither lays out nor paints, so `getBoundingClientRect()` is all zeros
 * and SVG geometry is absent. Arithmetic left inside a Lit element is therefore
 * not covered by anything, and nothing is coming to cover it — jsdom is the
 * whole automated story here by decision (#109). The same arithmetic in this
 * file is covered today, which is the entire reason the file exists. Every
 * editor-spec ticket that draws or grabs an object reads its numbers from here.
 *
 * It is **outside** `@rails49/r49` for the same reason `history.ts` is: that
 * package parses and serializes archives, and a grab radius is an editing
 * concept the training exporter and the Node classifier have no use for.
 *
 * @see SPEC.md § Location Data: Cars and Sensors
 */

/**
 * Track width in image pixels — which **is** DPT, and this function exists to
 * say so once.
 *
 * `DPT = px_per_mm × gauge_mm` (`@rails49/r49`'s `getDPT`), so the number
 * already is the track gauge measured in the image's own pixels. Callers that
 * need to draw something a track wide would otherwise pass `dpt` around with a
 * comment claiming the identity, and the identity would be re-derived, or
 * doubted, at every call site.
 *
 * A **sensor** is drawn at this diameter: it is a point on the track, and the
 * only honest sense of how big it is comes from the track it sits on. It is
 * therefore a **world** size and not a screen one — it shrinks with the
 * photograph's scale, exactly as the cars around it do, which is what makes a
 * sensor's footprint comparable to a car's.
 *
 * Callers hold a DPT that may be `null` on an uncalibrated archive and must
 * resolve that first, as {@link carWidthPx} says.
 */
export function trackWidthPx(dpt: number): number {
  return dpt;
}

/**
 * Size of a screen-constant symbol, in **screen** pixels.
 *
 * Markers, crosshairs and every label are drawn this big however far the
 * photograph is zoomed — they annotate the image rather than measure it. It
 * lives here rather than in `rr-viewer` because the hit-test needs the same
 * number: a sensor with no DPT is drawn at this size, and what is drawn is what
 * must be grabbable.
 */
export const SYMBOL_SIZE_SCREEN_PX = 36;

/**
 * The diameter a sensor is **drawn** at, in image pixels — the one place that
 * decides it.
 *
 * Shared by the renderer and the hit-test on purpose. The grab radius is
 * derived from this same number, so "what I can see" and "what I can grab"
 * cannot drift apart; two independent copies of the sizing rule is exactly how
 * a symbol ends up looking bigger than it is clickable.
 *
 * One track width when the layout is calibrated. With no DPT it falls back to
 * the screen-constant size: an archive can carry sensors and no calibration —
 * deleting a calibration point is allowed at any time — and a symbol sized from
 * a number that does not exist would vanish.
 */
export function sensorDiameterPx(dpt: number | null, imagePxPerScreenPx: number): number {
  return dpt === null ? SYMBOL_SIZE_SCREEN_PX * imagePxPerScreenPx : trackWidthPx(dpt);
}

/**
 * Car width in image pixels, derived from DPT rather than stored per label.
 *
 * **Re-exported from `@rails49/detector`, not implemented here** (#85). It
 * was a second copy of `DPT * STANDARD_WIDTH / STANDARD_GAUGE` until the live
 * view started drawing detections beside labels, at which point the two copies
 * became one picture: L1 replaces a predicted width with this constant before
 * testing a sensor, so a rectangle drawn from a different one would put a
 * sensor visibly outside a box that reads `occupied`. Issue #83 moved it out of
 * the training-data export for exactly this reason and missed the editor's copy.
 *
 * Kept as a name in this module rather than imported at each call site because
 * "no scale lookup belongs anywhere in the editor" is a rule about this file:
 * `geometry.ts` is where the editor's arithmetic lives, and a caller reaching
 * past it for gauge constants is the thing to notice.
 *
 * The same world-size argument as {@link trackWidthPx}, one multiply along: a
 * car is drawn 2.09 track widths across, so a sensor and the car covering it
 * are directly comparable on the photograph. `STANDARD_WIDTH` is the widest
 * real prototype rather than a typical one, so the rectangle errs wide — the
 * direction occupancy output deliberately errs in.
 *
 * Callers hold a DPT that may be `null` (an uncalibrated archive) and must
 * resolve that before calling: an uncalibrated layout has no car width, which
 * is why calibration gates car labeling.
 */
export { carWidthPx };

/** The four corners of a car's rectangle, in polygon order starting at `p0`. */
export type CarCorners = readonly [Point, Point, Point, Point];

/**
 * The oriented rectangle a car's centerline span covers: the `p0`–`p1` chord
 * offset by *half* of {@link carWidthPx} to either side, so the rectangle is
 * one car width across.
 *
 * Returned in polygon order — `p0` side, `p1` side, `p1` other side, `p0` other
 * side — so the four points feed an SVG `polygon` directly.
 *
 * A zero-length span collapses all four corners onto the point. The first click
 * of a chain has no second point yet, so the axis is genuinely undefined;
 * picking an arbitrary one would draw a rectangle the user did not describe.
 */
export function carCorners(p0: Point, p1: Point, dpt: number): CarCorners {
  return orientedRect(p0, p1, carWidthPx(dpt) / 2);
}

/** The image the editor draws into, in image pixels — `rr-viewer`'s `resolution`. */
export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How the authored frame maps onto the media's own pixel grid.
 *
 * `sx`/`sy` are what the overlay's content is scaled by, so a coordinate
 * authored in `camera.resolution` pixels lands on the pixel of the photograph
 * it names. They are equal in every well-formed archive.
 */
export interface OverlayFit {
  readonly sx: number;
  readonly sy: number;
  /**
   * The media's shape is not the authored frame's, so `sx !== sy` and the
   * overlay is **stretched** rather than scaled. Something is wrong with the
   * archive; the flag is what lets the editor say so.
   */
  readonly aspectMismatch: boolean;
}

/**
 * How far apart two aspect ratios may be before they are different shapes.
 *
 * A resize rounds to whole pixels, so 1920×1080 re-encoded at width 1919 is
 * the same photograph and not an inconsistent archive. Half a percent is
 * comfortably above any rounding and far below any real crop.
 */
const ASPECT_TOLERANCE = 0.005;

/**
 * The transform that puts the authored frame over the photograph.
 *
 * `camera.resolution` is the frame every coordinate in the manifest is written
 * in (`SPEC.md` § Output encoding) — but the images are per-image bytes, and
 * nothing makes one match the other. So the overlay **follows the media**: its
 * viewBox is the media's own size, and the authored frame is scaled into it.
 *
 * The two-element form matters only when the shapes disagree. For a photograph
 * of the frame's shape at any pixel count — the well-formed case, and the only
 * one the six fixture archives contain — `sx === sy` and this is the uniform
 * scale that was implicit before. When the shapes disagree there is no correct
 * answer, because nothing records how the photo was cropped; the frame is
 * stretched to cover the photograph, which keeps every authored object *on* it,
 * and `aspectMismatch` says the mapping was a guess.
 *
 * `null` media — nothing loaded yet — is the identity, so the first paint draws
 * in the authored frame rather than at NaN.
 */
export function overlayFit(media: FrameSize | null, frame: FrameSize): OverlayFit {
  const identity = { sx: 1, sy: 1, aspectMismatch: false };
  if (!media || media.width <= 0 || media.height <= 0) return identity;
  if (frame.width <= 0 || frame.height <= 0) return identity;

  const sx = media.width / frame.width;
  const sy = media.height / frame.height;
  return { sx, sy, aspectMismatch: Math.abs(sx - sy) > ASPECT_TOLERANCE * sy };
}

/** Where a symbol's text label goes, as the SVG attributes that place it. */
export interface LabelPlacement {
  readonly x: number;
  readonly y: number;
  /** `end` means the label runs leftwards from `x` — the right-edge flip. */
  readonly textAnchor: 'start' | 'end';
  /** `text-before-edge` means it hangs below `y` — the top-edge flip. */
  readonly dominantBaseline: 'text-after-edge' | 'text-before-edge';
}

/**
 * Advance width per character, as a fraction of the font size.
 *
 * Every label the editor draws is monospace (`--sl-font-mono`), where one
 * character is one advance; 0.6em is the advance of the common monospace faces
 * and errs slightly wide, which is the safe direction for a flip test.
 */
const MONOSPACE_ADVANCE_EM = 0.6;

/**
 * An **estimate** of a rendered label's width, not a measurement.
 *
 * Nothing here measures text: `measureText` and `getBBox` need layout, jsdom
 * performs none, and a placement rule that depended on them would be untestable
 * — the reason this module exists at all. So the width is derived from what is
 * known without laying anything out: the label is monospace and its content is
 * in hand, so it is character count × advance. Naming it an estimate is the
 * point — a caller must not treat the number as a box the glyphs are inside.
 */
export function estimateLabelWidthPx(text: string, fontSizePx: number): number {
  return text.length * fontSizePx * MONOSPACE_ADVANCE_EM;
}

/**
 * Where to put a symbol's label so it does not run off the frame.
 *
 * The preferred placement is **up and to the right** of the point, which is
 * what every labelled symbol in the editor uses when it has room. Near the
 * right edge the label flips to the left of the point, near the top it flips
 * below: it is drawn on the inside, where a clipped label was.
 *
 * Only the axis that overflows flips, and it flips **only when the other side
 * actually fits** — a frame narrower than the label overflows either way, and
 * flipping there would trade a clipped tail for a clipped head, losing the
 * leading digits that identify the point.
 *
 * Shared rather than inlined in a renderer because the sensor symbol (#31)
 * carries a name in the same frame against the same edges. Its geometry differs;
 * this decision does not.
 *
 * @param at The symbol's anchor, in image pixels.
 * @param text The label's exact content — the width estimate reads it.
 * @param fontSizePx Label font size in image pixels.
 * @param offsetPx Gap between the anchor and the label, on both axes.
 * @param frame The image bounds the flip is decided against.
 */
export function placeLabel(
  at: Point,
  text: string,
  fontSizePx: number,
  offsetPx: number,
  frame: FrameSize
): LabelPlacement {
  const width = estimateLabelWidthPx(text, fontSizePx);

  const overflowsRight = at.x + offsetPx + width > frame.width;
  const flipLeft = overflowsRight && at.x - offsetPx - width >= 0;

  // One line of text sits a font size above the baseline; `text-after-edge` is
  // close enough to that for a flip test, and errs tall.
  const overflowsTop = at.y - offsetPx - fontSizePx < 0;
  const flipDown = overflowsTop && at.y + offsetPx + fontSizePx <= frame.height;

  return {
    x: flipLeft ? at.x - offsetPx : at.x + offsetPx,
    y: flipDown ? at.y + offsetPx : at.y - offsetPx,
    textAnchor: flipLeft ? 'end' : 'start',
    dominantBaseline: flipDown ? 'text-before-edge' : 'text-after-edge',
  };
}

/**
 * A rectangle's extent, in whatever frame the caller is working in.
 *
 * Distinct from {@link FrameSize}, which is the image: this one measures a
 * thing placed *on* the screen, and the two are never in the same units.
 */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Moves a box of `size` at `at` so it sits inside `viewport`, keeping `margin`
 * from every edge.
 *
 * The one piece of editor arithmetic in **screen** coordinates, because it
 * positions the context menu on the glass rather than on the photograph. It
 * lives here for the same reason everything else does — a clamp left inside a
 * Lit element is untestable, since jsdom neither lays out nor paints.
 *
 * A box larger than the viewport is pinned to the top-left margin rather than
 * pushed off the opposite edge: the head of a menu is the part worth keeping,
 * exactly as {@link placeLabel} keeps a label's leading digits.
 */
export function clampToViewport(at: Point, size: Size, viewport: Size, margin: number): Point {
  return {
    x: Math.max(margin, Math.min(at.x, viewport.width - size.width - margin)),
    y: Math.max(margin, Math.min(at.y, viewport.height - size.height - margin)),
  };
}

/** One end of one car, keyed by label `id` — never by object identity. */
export interface CarEnd {
  readonly id: string;
  readonly end: 'p0' | 'p1';
}

/**
 * What the pointer found, as the editor's own vocabulary.
 *
 * A coupler is a distinct kind because the context menu and the drag path treat
 * it differently, but every car-side hit carries the same `ends` array, so a
 * drag handler can move whatever it grabbed without narrowing the union first.
 */
export type HitTarget =
  /** A free car end. */
  | { readonly kind: 'car-endpoint'; readonly ends: readonly [CarEnd] }
  /**
   * Two or more car ends at exactly the same pixel — a coupling. Nothing about
   * it is stored; it is derived from the coincidence, and dragging it must move
   * every end listed so the train survives the edit.
   */
  | { readonly kind: 'coupler'; readonly ends: readonly [CarEnd, CarEnd, ...CarEnd[]] }
  /** A sensor, keyed by its own id — a separate namespace from label ids. */
  | { readonly kind: 'sensor'; readonly id: string }
  /**
   * A calibration point, keyed by position in `layout.calibration.points`.
   * Points carry no id because nothing references one individually.
   */
  | { readonly kind: 'calibration'; readonly index: number };

/** Everything a pointer can land on, for one image of one layout. */
export interface HitScene {
  /** The current image's car labels — cars are per-image. */
  readonly cars: readonly CarLabel[];
  /** The layout's sensors — sensors are per-layout and show on every image. */
  readonly sensors: readonly Sensor[];
  /** The layout's calibration points. */
  readonly calibrationPoints: readonly ReferencePoint[];
  /**
   * The layout's DPT, or `null` when calibration resolves none.
   *
   * Not an object to hit: it is the **scale the world-sized objects are drawn
   * at**, and a hit-test that did not know it would grab a sensor at a radius
   * unrelated to the one on screen. It belongs to the scene rather than to the
   * tolerance because it describes the layout, not the pointing device.
   */
  readonly dpt: number | null;
}

/**
 * How close counts as a hit.
 *
 * The radius is expressed in **screen** pixels, because a grab radius is a
 * property of the finger and the mouse, not of the photograph: an 8-megapixel
 * image and a 720p one must feel identical. `imagePxPerScreenPx` converts it —
 * `rr-viewer` puts the current factor in every pointer event's detail.
 */
export interface HitTolerance {
  /** Grab radius, in screen pixels. */
  readonly screenPx: number;
  /** Image pixels per screen pixel, from the viewer's pointer event. */
  readonly imagePxPerScreenPx: number;
}

/**
 * The grab radius every editor tool uses, in **screen** pixels.
 *
 * One number rather than one per tool: the radius describes the pointing
 * device, and a sensor that grabs at a different distance than a calibration
 * point would feel like a bug. Sized for a fingertip on the phone the labeling
 * is done on, not for a mouse.
 *
 * It is a **floor, not a cap**. An object drawn larger than this is grabbable
 * across what is drawn — see {@link hitTest} — because the visible symbol is
 * the editor's promise about where the object is, and a symbol wider than its
 * own hit area breaks that promise the first time a click on it misses. The
 * floor is what keeps the promise from shrinking below a fingertip when the
 * object itself is tiny.
 */
export const DEFAULT_GRAB_RADIUS_SCREEN_PX = 14;

/**
 * How far a pointer may travel between press and release and still be a click,
 * in **screen** pixels.
 *
 * Smaller than the grab radius: this is hand tremor, not aim. Without it every
 * swipe over the image is a click, and the labeling device is a phone.
 */
export const CLICK_SLOP_SCREEN_PX = 5;

/**
 * Whether a gesture that started at `from` and ended at `to` is a click.
 *
 * Expressed as a distance in screen pixels, like every other tolerance here,
 * and evaluated against the same `HitTolerance` shape so the conversion happens
 * in one place. A gesture that is not a click is a drag — which nothing acts on
 * yet.
 */
export function isClick(from: Point, to: Point, tolerance: HitTolerance): boolean {
  const reach = tolerance.screenPx * tolerance.imagePxPerScreenPx;
  return distanceSq(from, to) <= reach * reach;
}

/**
 * The squared distance between two pixels — squared because every comparison
 * here is against a radius, and a square root would buy nothing but rounding.
 */
function distanceSq(a: Point, b: Point): number {
  return (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
}

/**
 * Rank used only to break an exact distance tie, densest geometry first.
 *
 * Couplers are absent because they are never candidates: a coincidence is
 * recognised after the nearest car end has already won.
 */
const KIND_RANK: Record<'car-endpoint' | 'sensor' | 'calibration', number> = {
  'car-endpoint': 0,
  sensor: 1,
  calibration: 2,
};

/** What can be *found* directly. A coupler is derived, never a candidate. */
type CandidateTarget = Extract<HitTarget, { kind: keyof typeof KIND_RANK }>;

/**
 * A kind of object {@link hitTest} looks for. A coupler is absent because it is
 * derived from a car end that has already won, never searched for.
 */
export type HitKind = CandidateTarget['kind'];

/** Every kind, which is what a caller that says nothing means. */
const ALL_HIT_KINDS: readonly HitKind[] = ['car-endpoint', 'sensor', 'calibration'];

interface Candidate {
  readonly target: CandidateTarget;
  readonly at: Point;
  readonly distanceSq: number;
}

/**
 * The object under `at`, or `null` when nothing is within the tolerance.
 *
 * **Nearest wins**, whatever its kind; an exact tie goes to the denser geometry
 * (car ends, then sensors, then calibration points). Only handles are hit — the
 * body of a car is not grabbable, because the only edits a span supports are to
 * its two ends.
 *
 * **A sensor is grabbable across the whole symbol**, not just at its centre.
 * Every other target is a point wearing an annotation, so the pointing device's
 * radius is the whole story; a sensor is a drawn *footprint* one track wide,
 * and a symbol visibly larger than its own hit area reads as a bug the first
 * time a click on it misses. Its reach is therefore the larger of the two —
 * never smaller, so a sensor on a distant track stays as easy to hit as
 * anything else. Being a circle of the diamond's half-diagonal, it also extends
 * a little past the diamond's edges, which is the forgiving direction.
 *
 * Coincidence for couplers is **exact equality**, not a tolerance: chaining and
 * the shared handle both write the identical value to every end they join, so
 * anything that merely looks close is two objects the user placed separately,
 * and fusing them would move geometry they never joined.
 *
 * `kinds` narrows what is looked *for*, and a caller that wants fewer kinds must
 * say so here rather than filter the answer: nearest-wins has already discarded
 * everything the winner beat, so a sensor a few pixels behind a car end comes
 * back as the car end, and a caller dropping that finds nothing where it can see
 * a sensor. It is not a filter on the scene either — the objects excluded are
 * still *there*, and a later question (`carUnderPointer`) still sees them.
 */
export function hitTest(
  scene: HitScene,
  at: Point,
  tolerance: HitTolerance,
  kinds: readonly HitKind[] = ALL_HIT_KINDS
): HitTarget | null {
  const pointerReach = tolerance.screenPx * tolerance.imagePxPerScreenPx;
  const sensorReach = Math.max(
    pointerReach,
    sensorDiameterPx(scene.dpt, tolerance.imagePxPerScreenPx) / 2
  );

  const candidates: Candidate[] = [];
  const push = (target: CandidateTarget, point: Point, reach: number) => {
    const distance = distanceSq(point, at);
    if (distance <= reach * reach) candidates.push({ target, at: point, distanceSq: distance });
  };

  if (kinds.includes('car-endpoint')) {
    for (const label of scene.cars) {
      push({ kind: 'car-endpoint', ends: [{ id: label.id, end: 'p0' }] }, label.p0, pointerReach);
      push({ kind: 'car-endpoint', ends: [{ id: label.id, end: 'p1' }] }, label.p1, pointerReach);
    }
  }
  if (kinds.includes('sensor')) {
    for (const s of scene.sensors) {
      push({ kind: 'sensor', id: s.id }, { x: s.x, y: s.y }, sensorReach);
    }
  }
  if (kinds.includes('calibration')) {
    scene.calibrationPoints.forEach((p, index) => {
      push({ kind: 'calibration', index }, p.px, pointerReach);
    });
  }

  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.distanceSq < best.distanceSq ||
      (candidate.distanceSq === best.distanceSq &&
        KIND_RANK[candidate.target.kind] < KIND_RANK[best.target.kind])
    ) {
      best = candidate;
    }
  }
  if (best === null) return null;
  if (best.target.kind !== 'car-endpoint') return best.target;

  // A car end that shares its exact pixel with another is a coupling.
  const ends = coincidentEnds(scene.cars, best.at);
  return ends.length > 1
    ? { kind: 'coupler', ends: ends as [CarEnd, CarEnd, ...CarEnd[]] }
    : best.target;
}

/**
 * The car whose rectangle covers `at`, or `null` when none does.
 *
 * A claim about the **image**, deliberately kept apart from the other two
 * questions and reading the same `HitScene` so all three see one set of objects.
 * {@link hitTest} answers "what can this gesture grab", and a car's body grabs
 * nothing — the only edits a span supports are to its two ends;
 * {@link carUnderPointer} answers "which car is this gesture aimed at", which is
 * about the pointer and is therefore floored at a fingertip. This one answers
 * "is this pixel already labelled", which only the car tool's **first** click
 * asks (#43), to refuse stacking a second box on a car that already carries
 * one — so it is **not** widened, or the refusal would cover a band of
 * demonstrable background. Nothing here rejects an *archive*: cars already
 * overlapping open, render and edit exactly as before.
 *
 * Measured in the span's own frame rather than against the corners
 * {@link carCorners} returns, so a diagonal car is tested across its own axis
 * and not across a bounding box half again too big. The **boundary is inside**:
 * a click on the rectangle's edge is refused, which errs in the same direction
 * the width itself errs in.
 *
 * With no DPT there is **no rectangle**, so nothing covers anything — the same
 * answer `renderCar` gives by drawing none. The car tool is gated on DPT
 * resolving, so this branch is the uncalibrated archive rather than a state the
 * refusal has an opinion about.
 *
 * A car with no length has no axis and so no rectangle; it covers only the
 * exact point it sits on, matching {@link carCorners} collapsing to that point.
 * The editor refuses to author such a car, so it can only arrive from outside.
 *
 * Where several cars cover the pixel the first in scene order wins. Nothing
 * distinguishes them for the caller's purpose — one is enough to refuse — but
 * the answer is the scene's own order rather than an arbitrary one.
 */
export function carCovering(scene: HitScene, at: Point): CarLabel | null {
  if (scene.dpt === null) return null;
  const half = carWidthPx(scene.dpt) / 2;
  for (const car of scene.cars) {
    const inside = withinSpan(car.p0, car.p1, at, half);
    // No axis, so no rectangle: it covers the one pixel it sits on.
    if (inside === null ? samePoint(at, car.p0) : inside) return car;
  }
  return null;
}

/**
 * The car a **gesture aimed at `at`** means, or `null` when it means none.
 *
 * The **third** question, alongside {@link hitTest}'s "what can this gesture
 * grab" and {@link carCovering}'s "is this pixel already labelled" — not a
 * variant of either. This one is about the **pointer**, and the answer is a car
 * the user is pointing *at*; `carCovering` is about the **image**, and its
 * answer is a claim that a pixel carries a label. Sharing one widened test would
 * make the car tool refuse to start a chain across a fingertip's band of
 * demonstrable background, which in a yard photo eats the gaps between parallel
 * tracks.
 *
 * It exists because a car's **body** is what a right-click can name (#45). The
 * shared coupler handle cannot: two cars end on the identical pixel, so a
 * gesture there names both, which is why the menu used to name them by the way
 * each ran. Coupled rectangles **abut** rather than overlap — `along` is bounded
 * by the span's own ends — so an area test is unambiguous everywhere except a
 * zero-area seam, and the direction naming dissolves with it.
 *
 * The rectangle is **floored at a fingertip**: half a car width, or the
 * tolerance's reach where that is larger. Not a special case —
 * {@link DEFAULT_GRAB_RADIUS_SCREEN_PX} is a floor rather than a cap, and
 * `hitTest` already floors a sensor the same way. It is what keeps a car with
 * **no DPT** reachable: there is no width to derive, `renderCar` draws the chord
 * and handles anyway (an authored car must stay visible after a calibration
 * point is deleted), and without the floor that would be a car you can see and
 * cannot delete.
 *
 * Where several cars cover the pixel the **first in scene order** wins, as
 * `carCovering` does: it is the seam of a coupling, or genuinely overlapping
 * cars, and neither is something a user can aim at on purpose.
 */
export function carUnderPointer(
  scene: HitScene,
  at: Point,
  tolerance: HitTolerance
): CarLabel | null {
  const reach = tolerance.screenPx * tolerance.imagePxPerScreenPx;
  const half = Math.max(scene.dpt === null ? 0 : carWidthPx(scene.dpt) / 2, reach);
  for (const car of scene.cars) {
    const inside = withinSpan(car.p0, car.p1, at, half);
    // No axis and so no rectangle: what is left is the same half-width as a
    // radius, which is the one point the car is drawn as, reachable. The editor
    // refuses to author such a car, so it can only arrive from outside.
    if (inside === null ? distanceSq(at, car.p0) <= half * half : inside) return car;
  }
  return null;
}

/**
 * Whether `at` is inside the rectangle `half` either side of the chord `p0`–`p1`,
 * or `null` when the span has no axis and there is no rectangle to be inside of.
 *
 * The **boundary is inside**, and the rectangle is capped at the two ends.
 * Shared by every area question so they can differ in their half-width, in their
 * span and in nothing else — the arithmetic that makes a diagonal car measure
 * across its own axis rather than across a bounding box half again too big is
 * written once.
 *
 * It takes a **span** rather than a `CarLabel` because a car's area for tracing
 * is the label's span lengthened at both ends ({@link inCarArea}), which is not
 * a `CarLabel` and must not be measured by a second copy of this.
 */
function withinSpan(p0: Point, p1: Point, at: Point, half: number): boolean | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const ax = at.x - p0.x;
  const ay = at.y - p0.y;
  // Both distances scaled by the span's length rather than divided by it:
  // a point exactly on the edge must read as exactly on the edge, and a
  // division introduces the rounding that would put it just outside.
  const along = ax * dx + ay * dy;
  const across = ax * dy - ay * dx;
  return along >= 0 && along <= length * length && Math.abs(across) <= half * length;
}

/**
 * What a drag handle addresses in the manifest.
 *
 * Keyed the way the rest of the editor keys — label `id` for a car, sensor `id`,
 * position for a calibration point, which carries no id because nothing
 * references one individually. **Never an object reference**: applying a history
 * snapshot replaces the objects wholesale.
 */
export type HandleRef =
  | { readonly kind: 'calibration'; readonly index: number }
  | { readonly kind: 'car-end'; readonly id: string; readonly end: 'p0' | 'p1' }
  | { readonly kind: 'sensor'; readonly id: string };

/** One point a drag moves, and where it sat when the gesture began. */
export interface DragHandle {
  readonly ref: HandleRef;
  /**
   * Position at pointer-down. Deltas apply to **this**, not to the live value:
   * accumulating them onto the current position drifts under rounding, and
   * snapping the object to the pointer instead would discard the grab offset.
   */
  readonly from: Point;
}

/**
 * The handles a grab moves — one per object, and **more than one for a
 * coupler**.
 *
 * This is where a drag stops being about the thing under the cursor and becomes
 * a list, which is what lets one history entry cover several objects: a coupler
 * drag moves both cars' ends by the same delta, and dropping either one would
 * silently uncouple the train. A handle whose object is not in the scene is
 * dropped rather than faked.
 */
export function dragHandles(hit: HitTarget, scene: HitScene): readonly DragHandle[] {
  switch (hit.kind) {
    case 'calibration': {
      const point = scene.calibrationPoints[hit.index];
      return point ? [{ ref: { kind: 'calibration', index: hit.index }, from: point.px }] : [];
    }
    case 'sensor': {
      const found = scene.sensors.find((s) => s.id === hit.id);
      return found ? [{ ref: { kind: 'sensor', id: hit.id }, from: { x: found.x, y: found.y } }] : [];
    }
    case 'car-endpoint':
    case 'coupler': {
      const handles: DragHandle[] = [];
      for (const end of hit.ends) {
        const label = scene.cars.find((c) => c.id === end.id);
        if (label) handles.push({ ref: { kind: 'car-end', ...end }, from: label[end.end] });
      }
      return handles;
    }
  }
}

/**
 * Where a handle lands for a given drag delta, in whole image pixels.
 *
 * Rounded because a handle names a pixel, and applied to `from` so every handle
 * in one gesture takes the identical translation — which is what keeps a
 * coupler's two ends on the *same* pixel, and a coupling is exact coincidence.
 */
export function dragTo(handle: DragHandle, delta: Point): Point {
  return { x: Math.round(handle.from.x + delta.x), y: Math.round(handle.from.y + delta.y) };
}

/**
 * Every pixel where two or more car ends meet — the couplings of a scene,
 * derived rather than read, because nothing about a coupling is stored.
 *
 * The renderer's half of what {@link hitTest} answers for the pointer, and by
 * the same rule: **exact coincidence**, never proximity. That shared rule is
 * what makes the shared handle honest — the one place a click lands on two
 * cars is the one place one handle is drawn.
 *
 * Each coupling appears **once**, however many ends meet there, which is what
 * "renders as one shared handle" comes down to. In scene order, so a chained
 * train's couplings come back in the order it was authored.
 *
 * A car whose two ends are the same pixel counts as a coupling of itself: there
 * is one point on screen, so there is one handle. The editor refuses to author
 * such a car, so it can only arrive from outside.
 */
export function couplerPoints(cars: readonly CarLabel[]): readonly Point[] {
  const seen = new Map<string, { readonly at: Point; ends: number }>();
  for (const car of cars) {
    for (const end of [car.p0, car.p1]) {
      const key = `${end.x},${end.y}`;
      const found = seen.get(key);
      if (found) found.ends += 1;
      else seen.set(key, { at: { x: end.x, y: end.y }, ends: 1 });
    }
  }
  return [...seen.values()].filter(entry => entry.ends > 1).map(entry => entry.at);
}

/**
 * Whether two pixels are the same pixel.
 *
 * The **one** encoding of the coincidence rule, shared by everything that has
 * to agree on what a coupling is: the hit-test, the renderer's list, and the
 * staleness guards. Exact, never a tolerance — see {@link hitTest}.
 */
export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Whether `at` is exactly one of `points` — how a renderer asks whether an end
 * is coupled, against the list {@link couplerPoints} returned.
 */
export function isCoincident(at: Point, points: readonly Point[]): boolean {
  return points.some(point => samePoint(point, at));
}

/**
 * Which of a car's ends are coupled, and so are drawn once as a shared handle
 * rather than twice as two ends.
 *
 * Here rather than in the renderer that needs it, like every other piece of
 * editor geometry: a coupling is a property of the *scene*, and one car cannot
 * see it on its own.
 */
export interface CoupledEnds {
  readonly p0: boolean;
  readonly p1: boolean;
}

/** {@link CoupledEnds} for one car, against the scene's {@link couplerPoints}. */
export function coupledEnds(car: CarLabel, couplers: readonly Point[]): CoupledEnds {
  return { p0: isCoincident(car.p0, couplers), p1: isCoincident(car.p1, couplers) };
}

/** Every car end sitting exactly on `at`, in scene order. */
function coincidentEnds(cars: readonly CarLabel[], at: Point): CarEnd[] {
  const ends: CarEnd[] = [];
  for (const label of cars) {
    if (samePoint(label.p0, at)) ends.push({ id: label.id, end: 'p0' });
    if (samePoint(label.p1, at)) ends.push({ id: label.id, end: 'p1' });
  }
  return ends;
}

/**
 * A rectangle in **authored-frame** pixels — the region of the photograph the
 * editor is zoomed into (#44).
 *
 * The frame rather than the image's own pixels, like every other coordinate the
 * editor holds (`SPEC.md` § Output encoding): a zoom is per **layout**, and the
 * images of one archive need not all be the same pixel size, so a rect in an
 * image's own grid would name a different region on the next frame.
 *
 * Distinct from {@link Size} and {@link FrameSize}, which measure a thing and
 * not a place.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The tightest zoom the format can record: one authored-frame pixel across
 * {@link DEFAULT_GRAB_RADIUS_SCREEN_PX} screen pixels.
 *
 * **Derived, not chosen.** Coordinates are stored as whole pixels — the click
 * path rounds, and so does {@link dragTo} — so once one stored pixel is about a
 * fingertip wide, further zoom buys precision the manifest cannot hold. Reusing
 * the grab radius rather than introducing a constant is the point: the two
 * numbers answer the same question, "how big is the thing doing the pointing".
 *
 * It is also what disposes of the accidental two-pixel drag, with no second
 * threshold: a rect a few pixels across is grown to this scale instead of
 * landing at 200×.
 */
export const MAX_ZOOM_SCREEN_PX_PER_FRAME_PX = DEFAULT_GRAB_RADIUS_SCREEN_PX;

/** The rectangle two corners describe, in either order and either direction. */
export function rectBetween(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Grows `rect` about its centre until zooming to it would not exceed
 * {@link MAX_ZOOM_SCREEN_PX_PER_FRAME_PX}.
 *
 * The rect is fitted into the viewport by the **meet** rule, so the scale it
 * produces is the *smaller* of the two axis ratios — which is why the growth
 * factor is the smaller of the two shortfalls: the axis that reaches its
 * minimum first is the one that governs what is on screen.
 *
 * Both axes grow by the same factor, so the rect keeps its shape and the region
 * the user drew stays centred in what they get.
 *
 * An unmeasured viewport — jsdom, a pane that has never laid out — caps
 * nothing: there is no screen to be too close to.
 */
export function capZoomRect(rect: Rect, viewport: Size): Rect {
  if (viewport.width <= 0 || viewport.height <= 0) return rect;

  const minWidth = viewport.width / MAX_ZOOM_SCREEN_PX_PER_FRAME_PX;
  const minHeight = viewport.height / MAX_ZOOM_SCREEN_PX_PER_FRAME_PX;
  // A rect with no area at all has no shape to keep, so it becomes the smallest
  // rect the cap allows. It arrives only from a drag that never moved, which
  // the click slop already answers — this is the floor under that, not a case
  // the editor produces.
  if (rect.width <= 0 && rect.height <= 0) {
    return {
      x: rect.x - minWidth / 2,
      y: rect.y - minHeight / 2,
      width: minWidth,
      height: minHeight,
    };
  }

  const factor = Math.min(
    rect.width > 0 ? minWidth / rect.width : Infinity,
    rect.height > 0 ? minHeight / rect.height : Infinity
  );
  if (factor <= 1) return rect;

  const width = rect.width * factor;
  const height = rect.height * factor;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

/**
 * Moves `rect` so it sits inside the frame, keeping its size.
 *
 * The same rule {@link clampToViewport} sets, one frame along: a rect smaller
 * than the image is kept inside it, and a rect larger than the image is
 * **centred** rather than pushed off the opposite edge. That is what stops a
 * pan from walking the photograph out of the viewport entirely.
 */
export function clampZoomRect(rect: Rect, frame: FrameSize): Rect {
  return {
    ...rect,
    x: clampZoomAxis(rect.x, rect.width, frame.width),
    y: clampZoomAxis(rect.y, rect.height, frame.height),
  };
}

/** One axis of {@link clampZoomRect}: inside where it fits, centred where not. */
function clampZoomAxis(position: number, size: number, extent: number): number {
  if (size >= extent) return (extent - size) / 2;
  return Math.max(0, Math.min(position, extent - size));
}

/**
 * The zoom a drag from `from` to `to` asks for, or `null` when it asks for the
 * unzoomed view.
 *
 * Capped before it is clamped, because the cap changes the size and the clamp
 * answers where a rect of that size can sit.
 *
 * **A rect that spans the frame on *either* axis is `null`**, not a rect: fit is
 * the absence of a zoom (`rr-viewer` then draws exactly what it drew before zoom
 * existed), and the meet rule takes the *smaller* of the two axis ratios — so a
 * rect as wide as the photograph and only a little tall is already fitted by its
 * width, and one **wider** than the photograph would be scaled *down*, showing
 * less than fit. A drag can produce either: the overlay covers the letterbox
 * bars and `rr-viewer` captures the pointer, so a rect may legitimately run off
 * both edges. Either axis, therefore, and not both: what is left is strictly
 * inside the frame on both axes, which is the invariant that keeps every zoom at
 * least as close as fit.
 */
export function zoomRectFromDrag(
  from: Point,
  to: Point,
  frame: FrameSize,
  viewport: Size
): Rect | null {
  const capped = capZoomRect(rectBetween(from, to), viewport);
  if (capped.width >= frame.width || capped.height >= frame.height) return null;
  return clampZoomRect(capped, frame);
}

/**
 * Where a pan puts the zoom rect: the pointer's travel, applied to the rect the
 * gesture started on.
 *
 * `delta` is how far the **pointer** has moved since the press, in frame pixels,
 * so the rect moves the opposite way — the photograph follows the finger, which
 * is the only direction a drag on an image can mean.
 *
 * Measured from the press and applied to the starting rect for the same reason
 * {@link dragTo} is: accumulating per-event deltas drifts, and re-reading the
 * live rect would feed the transform its own output.
 */
export function panZoomRect(from: Rect, delta: Point, frame: FrameSize): Rect {
  return clampZoomRect({ ...from, x: from.x - delta.x, y: from.y - delta.y }, frame);
}

/**
 * The CSS transform that puts a zoom rect on screen: `translate(x, y)` then
 * `scale(scale)`, about an origin at the top-left of the viewport.
 *
 * In **screen** pixels, because it is applied to the layer that carries the
 * media and the overlay together — which is the whole mechanism (#44). One
 * transform above both keeps them one box by construction, exactly as #41 left
 * them, and it is what makes every screen-pixel tolerance in this file
 * zoom-aware without a line of arithmetic changing: `getScreenCTM` walks up
 * through it, so `imagePxPerScreenPx` already knows.
 */
export interface ZoomTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** No zoom: what the viewer renders when `zoom` is null, and the fit view. */
const IDENTITY_ZOOM: ZoomTransform = { scale: 1, x: 0, y: 0 };

/**
 * The transform for `zoom`, or the identity when there is none to apply.
 *
 * Composed of the two mappings that already exist rather than a third one: the
 * media letterboxes into the viewport by **meet** (`object-fit: contain`, and
 * `preserveAspectRatio="xMidYMid meet"` over the same box), and the authored
 * frame covers that box through {@link overlayFit}'s scale. So a frame rect
 * becomes a viewport rect, and the transform is what fits *that* into the
 * viewport — again by meet, so a rect whose aspect ratio differs from the
 * viewport's shows **more** than was asked for on one axis and never less.
 *
 * `media` is passed rather than assumed equal to `frame` because the two can
 * disagree in shape, and it is the media that decides where the letterbox is.
 * The identity is returned wherever there is nothing to compute from — no zoom,
 * an unmeasured viewport, a frame with no extent — so a caller can apply the
 * result unconditionally.
 */
export function zoomTransform(
  zoom: Rect | null,
  media: FrameSize | null,
  frame: FrameSize,
  viewport: Size
): ZoomTransform {
  if (!zoom) return IDENTITY_ZOOM;
  if (viewport.width <= 0 || viewport.height <= 0) return IDENTITY_ZOOM;
  if (frame.width <= 0 || frame.height <= 0) return IDENTITY_ZOOM;

  // Where the photograph sits inside the viewport, letterbox bars excluded.
  const content = media && media.width > 0 && media.height > 0 ? media : frame;
  const fit = Math.min(viewport.width / content.width, viewport.height / content.height);
  const boxWidth = content.width * fit;
  const boxHeight = content.height * fit;
  const boxX = (viewport.width - boxWidth) / 2;
  const boxY = (viewport.height - boxHeight) / 2;

  // The rect, in the viewport's own pixels. The authored frame covers the
  // photograph's box whatever its own shape — that is `overlayFit`'s stretch,
  // and dividing by the frame is the same scale read the other way round.
  const x = boxX + (zoom.x / frame.width) * boxWidth;
  const y = boxY + (zoom.y / frame.height) * boxHeight;
  const width = (zoom.width / frame.width) * boxWidth;
  const height = (zoom.height / frame.height) * boxHeight;

  const scale = Math.min(
    width > 0 ? viewport.width / width : Infinity,
    height > 0 ? viewport.height / height : Infinity
  );
  if (!Number.isFinite(scale) || scale <= 0) return IDENTITY_ZOOM;

  return {
    scale,
    x: viewport.width / 2 - scale * (x + width / 2),
    y: viewport.height / 2 - scale * (y + height / 2),
  };
}

/**
 * The smallest rectangle covering every point, or `null` for none.
 *
 * A zero-area rect for a single point is the right answer rather than a
 * degenerate one: it is a place, and the reveal rule below asks only whether it
 * fits inside the current zoom.
 */
export function boundsOfPoints(points: readonly Point[]): Rect | null {
  if (points.length === 0) return null;
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Where the zoom must be for a reveal to be visible: unchanged, panned, or gone.
 *
 * The navigation invariant, under zoom (`SPEC.md` § Undo and redo): *undo may
 * move the user; it may never change something they cannot see*. Selecting the
 * entry's image covers the case where the change is on another frame; this
 * covers the one that only exists once the view can be a corner of a frame —
 * zoomed into one corner, undoing an edit in another corner of the **same**
 * image.
 *
 * Three answers, in order:
 *
 * * Already inside the rect, or no zoom at all: **unchanged**. An undo that
 *   changes what the user is looking at must not move them as well.
 * * Fits at this zoom level: **panned** to centre it, then clamped like any
 *   other pan. Keeping the level is what makes zoom worth persisting — a zoom
 *   that survives nineteen image changes and dies on every undo is not persistent.
 * * Does not fit: **`null`**, the unzoomed view, which shows everything.
 */
export function revealZoom(zoom: Rect | null, bounds: Rect | null, frame: FrameSize): Rect | null {
  if (zoom === null || bounds === null) return zoom;
  if (rectContains(zoom, bounds)) return zoom;
  if (bounds.width > zoom.width || bounds.height > zoom.height) return null;

  return clampZoomRect(
    {
      ...zoom,
      x: bounds.x + bounds.width / 2 - zoom.width / 2,
      y: bounds.y + bounds.height / 2 - zoom.height / 2,
    },
    frame
  );
}

/** Whether `inner` lies wholly within `outer`, boundary included. */
function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * One run of track, as a polyline along the middle between its rails, in image
 * pixels.
 *
 * Centerlines belong to the **archive**, not to an image: an archive's images
 * share one pose, so one tracing serves all of them
 * ([ADR 0021](../../docs/adr/0021-track-centerlines-are-stored.md)).
 *
 * **This is the editor's shape, and not yet the format's.** ADR 0021 makes
 * centerlines an optional field of `.r49`, and that field arrives with
 * rails49/r49#52; the pinned `@rails49/r49` refuses `layout.centerlines` as
 * `manifest/unknown-key`, so nothing in `ui/` writes one into a manifest today
 * and nothing here reads one out. The shape is deliberately the one the format
 * will carry — an id and its points in order — so the arithmetic below survives
 * the bump as a changed import.
 *
 * Only polylines. Splines were rejected because every reader of the format would
 * have to implement the curve, and snapping takes away the tedium they were for
 * (ADR 0021).
 */
export interface Centerline {
  /** Stable across every save, like a sensor's or a car label's. */
  readonly id: string;
  /**
   * In order along the run, every one a click or a 1 G step between two clicks.
   * Fewer than two is not a run, and the editor stores none.
   *
   * Not thinned: the points are the measurement, and a thinning rule would be a
   * second opinion about where the track is.
   */
  readonly points: readonly Point[];
}

/**
 * The patch the classifier judges, across the track and along it, in **gauges**.
 *
 * **A placeholder in one named place**, until rails49/classifier#4 picks the
 * size from what the model actually needs. It is one place rather than two
 * because the same number sizes the outline drawn at a sensor *and* the reach
 * that earns a second-centerline warning ({@link secondCenterlineReachPx}) —
 * the warning says "a car on that track could reach into this patch", which is
 * a claim about this rectangle and is wrong the moment it is measured against a
 * different one.
 *
 * Gauges rather than pixels for the same reason a car is 2.09 track widths: the
 * patch is a piece of track, so its size in pixels is a DPT multiply away and
 * no scale lookup is involved.
 */
export const PATCH_ACROSS_G = 3;
/** @see PATCH_ACROSS_G */
export const PATCH_ALONG_G = 5;

/**
 * How far from every centerline a sensor is marked as having no track, in
 * gauges.
 *
 * Half a gauge: a sensor further off than the rail it would sit on is not on
 * that track, and a sensor with no centerline under it reads **unknown**
 * (`GLOSSARY.md` § Occupancy), which is what the mark warns the author about
 * before the live view says it.
 */
export const NO_TRACK_G = 0.5;

/**
 * How far a car's area reaches past the ends of its label's span, in gauges.
 *
 * Half a gauge at each end, because a label is the *visible* car and a coupler,
 * a step and a shadow are not labeled. Track inside this is not traced: the
 * rails under a car are not visible, so the snap would read the car's own
 * symmetry and place a point on it.
 */
export const CAR_AREA_MARGIN_G = 0.5;

/** Where a point sits against one centerline. */
export interface CenterlineHit {
  /** The centerline this measures against. */
  readonly id: string;
  /** Distance from the point to the polyline, in image pixels. */
  readonly distancePx: number;
  /** The closest point on the polyline. */
  readonly at: Point;
  /**
   * Unit direction of the segment the closest point fell on, pointing the way
   * the run was traced. Zero for a centerline of one point, which has no
   * direction and so cannot turn a patch.
   */
  readonly direction: Point;
}

/**
 * The nearest centerline to `at`, or `null` when the archive has none.
 *
 * Nearest by distance to the **polyline**, not to its points: the points are 1 G
 * apart and a sensor between two of them is on the track, not half a gauge off
 * it.
 *
 * It answers however far away the nearest one is. The *verdict* — that a sensor
 * is too far from all of them to be on track — is {@link sensorTrack}'s, which
 * needs the distance this reports in order to reach it.
 */
export function nearestCenterline(
  at: Point,
  centerlines: readonly Centerline[]
): CenterlineHit | null {
  let best: CenterlineHit | null = null;
  for (const hit of centerlineHits(at, centerlines)) {
    if (!best || hit.distancePx < best.distancePx) best = hit;
  }
  return best;
}

/**
 * What the centerlines say about one sensor: which one its patch is turned to,
 * and the two marks the editor draws on it.
 *
 * Both marks are **markers on the photograph**, not toasts: they are a standing
 * property of where the sensor is, and a toast is for something that just
 * happened.
 *
 * Neither mark moves the sensor and neither moves its patch onto the line.
 * Snapping sensors onto centerlines is out of scope: a sensor is where the
 * author wants an answer, and the editor does not get to disagree about where
 * that is.
 */
export interface SensorTrack {
  /**
   * The centerline the patch is turned to, or `null` with no centerlines at all.
   * Still reported when `noTrack` is set, so the editor can say what it measured
   * against.
   */
  readonly nearest: CenterlineHit | null;
  /** Further than {@link NO_TRACK_G} from every centerline: the no-track mark. */
  readonly noTrack: boolean;
  /**
   * A centerline other than the nearest comes within
   * {@link secondCenterlineReachPx}: the warning mark. A car on that track could
   * reach into this sensor's patch, so the classifier would be judging two
   * tracks at once.
   */
  readonly secondCenterline: boolean;
}

/**
 * {@link SensorTrack} for a point, which is what a sensor is.
 *
 * Takes the point rather than the `Sensor` so the same question can be asked of
 * a pixel the author is only hovering over.
 */
export function sensorTrack(
  at: Point,
  centerlines: readonly Centerline[],
  dpt: number
): SensorTrack {
  const hits = centerlineHits(at, centerlines);
  let nearest: CenterlineHit | null = null;
  for (const hit of hits) {
    if (!nearest || hit.distancePx < nearest.distancePx) nearest = hit;
  }
  const reach = secondCenterlineReachPx(dpt);
  return {
    nearest,
    noTrack: nearest === null || nearest.distancePx > NO_TRACK_G * dpt,
    secondCenterline: hits.some(hit => hit !== nearest && hit.distancePx <= reach),
  };
}

/**
 * How close a second centerline may come to a sensor before its patch is
 * warned about, in image pixels.
 *
 * Half the patch's width plus half a car's: the question is whether a car
 * standing on that other track could put pixels inside this patch, and a car is
 * centred on its own centerline. With the placeholder patch that is
 * `1.5 + 1.045 = 2.545` gauges.
 *
 * It is a **radius**, so it is measured the same way in every direction and
 * {@link PATCH_ALONG_G} does not enter. That under-warns along the patch: a
 * centerline crossing the patch's long axis between this radius and
 * `PATCH_ALONG_G/2 + carWidthPx/2` — 2.545 to 3.545 gauges out with the
 * placeholder — earns no warning, yet a car on it is 2.09 gauges wide and so
 * still reaches inside the 2.5-gauge-long patch. The rule as a radius is what
 * [#275](https://github.com/rails49/occupancy/issues/275) decided, and widening
 * it to the patch rectangle would change which sensors get flagged — a policy
 * call, not arithmetic, and one to make when rails49/classifier#4 sets the real
 * patch. `tests/geometry.test.ts` pins the gap so it stays a decision.
 *
 * > The brief on #275 called it "about 2.7 G". The rule it states is the one
 * > implemented here, and 3 G across with a 2.09 G car gives 2.545 — so the
 * > number is derived rather than written down, which is also what keeps it
 * > right when rails49/classifier#4 replaces {@link PATCH_ACROSS_G}.
 */
export function secondCenterlineReachPx(dpt: number): number {
  return (PATCH_ACROSS_G * dpt) / 2 + carWidthPx(dpt) / 2;
}

/**
 * The four corners of a sensor's patch, in polygon order, or `null` when
 * `direction` has no length.
 *
 * Centred on the sensor and **turned** to the direction of the nearest
 * centerline — the sensor is not moved onto the line, and neither is the patch.
 * Drawing it along the track is what makes a bad tracing show: a patch square to
 * the frame on diagonal track is the one picture that cannot be mistaken for
 * working.
 */
export function patchCorners(at: Point, direction: Point, dpt: number): CarCorners | null {
  const along = unitVector(direction);
  if (!along) return null;
  const half = (PATCH_ALONG_G * dpt) / 2;
  return orientedRect(
    { x: at.x - along.x * half, y: at.y - along.y * half },
    { x: at.x + along.x * half, y: at.y + along.y * half },
    (PATCH_ACROSS_G * dpt) / 2
  );
}

/**
 * Whether `at` falls in a car's area: its label's span, one car width across and
 * lengthened {@link CAR_AREA_MARGIN_G} at each end.
 *
 * Boundary inside, as every area question here has it. A car with no axis has no
 * direction to lengthen along, so what is left is its half-width as a radius —
 * the same fallback `carUnderPointer` makes, for the same reason.
 */
export function inCarArea(car: CarLabel, at: Point, dpt: number): boolean {
  const margin = CAR_AREA_MARGIN_G * dpt;
  const along = unitVector({ x: car.p1.x - car.p0.x, y: car.p1.y - car.p0.y });
  const half = carWidthPx(dpt) / 2;
  if (!along) return distanceSq(at, car.p0) <= half * half;
  return (
    withinSpan(
      { x: car.p0.x - along.x * margin, y: car.p0.y - along.y * margin },
      { x: car.p1.x + along.x * margin, y: car.p1.y + along.y * margin },
      at,
      half
    ) === true
  );
}

/** One hit per centerline, in the order given. */
function centerlineHits(at: Point, centerlines: readonly Centerline[]): CenterlineHit[] {
  const hits: CenterlineHit[] = [];
  for (const line of centerlines) {
    const hit = closestOnCenterline(at, line);
    if (hit) hits.push(hit);
  }
  return hits;
}

/** Where `at` is closest to one polyline, or `null` when it carries no points. */
function closestOnCenterline(at: Point, line: Centerline): CenterlineHit | null {
  const { points } = line;
  const first = points[0];
  if (!first) return null;
  if (points.length === 1) {
    return {
      id: line.id,
      distancePx: Math.hypot(at.x - first.x, at.y - first.y),
      at: { ...first },
      direction: { x: 0, y: 0 },
    };
  }

  let best: CenterlineHit | null = null;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const closest = closestOnSegment(p0, p1, at);
    const distancePx = Math.hypot(at.x - closest.x, at.y - closest.y);
    if (best && distancePx >= best.distancePx) continue;
    best = {
      id: line.id,
      distancePx,
      at: closest,
      direction: unitVector({ x: p1.x - p0.x, y: p1.y - p0.y }) ?? { x: 0, y: 0 },
    };
  }
  return best;
}

/** The point of the segment `p0`–`p1` closest to `at`, ends included. */
function closestOnSegment(p0: Point, p1: Point, at: Point): Point {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { ...p0 };
  const t = Math.min(1, Math.max(0, ((at.x - p0.x) * dx + (at.y - p0.y) * dy) / lengthSq));
  return { x: p0.x + dx * t, y: p0.y + dy * t };
}

/**
 * The oriented rectangle `half` either side of the chord `p0`–`p1`, in polygon
 * order from the `p0` side.
 *
 * The one construction behind {@link carCorners} and {@link patchCorners}: a
 * chord plus a half-width normal, wound the same way, so a patch and a car
 * cannot be drawn by two rules that disagree about which side is which.
 */
function orientedRect(p0: Point, p1: Point, half: number): CarCorners {
  const along = unitVector({ x: p1.x - p0.x, y: p1.y - p0.y });
  if (!along) return [{ ...p0 }, { ...p0 }, { ...p0 }, { ...p0 }];
  const nx = along.y * half;
  const ny = -along.x * half;
  return [
    { x: p0.x + nx, y: p0.y + ny },
    { x: p1.x + nx, y: p1.y + ny },
    { x: p1.x - nx, y: p1.y - ny },
    { x: p0.x - nx, y: p0.y - ny },
  ];
}

/** `v` scaled to unit length, or `null` when it has none. */
function unitVector(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? null : { x: v.x / length, y: v.y / length };
}
