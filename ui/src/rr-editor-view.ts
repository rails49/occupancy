import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { R49Archive, getDPT, getDPTResidual } from '@occupancy/r49';
import type {
  CalibrationPoint,
  CarLabel,
  Image,
  ManifestData,
  Point,
  Sensor,
} from '@occupancy/r49';
import { MIN_DPT } from '@occupancy/config';
import { make_id } from '@occupancy/uid';
import { captureFromCamera } from './capture.js';
import { maxDriftPx, openDriftCheck, planeFromBytes } from './driftSession.js';
import {
  boundsOfPoints,
  carCovering,
  carUnderPointer,
  dragHandles,
  dragTo,
  hitTest,
  isClick,
  panZoomRect,
  rectBetween,
  revealZoom,
  samePoint,
  zoomRectFromDrag,
  CLICK_SLOP_SCREEN_PX,
  DEFAULT_GRAB_RADIUS_SCREEN_PX,
} from './geometry.js';
import type {
  DragHandle,
  FrameSize,
  HitKind,
  HitScene,
  HitTarget,
  HitTolerance,
  Rect,
  Size,
} from './geometry.js';
import type { PendingCar } from './carMarker.js';
import { classChoices, rootClass } from './vocabulary.js';
import type { ClassChoice } from './vocabulary.js';
import { COMPACT_MAX_HEIGHT_PX } from './layout.js';
import { lookTokens } from './look.js';
import { revealTarget } from './history.js';
import type {
  EditHistory,
  HistoryGesture,
  HistoryHighlight,
  HistoryTarget,
} from './history.js';
import { HIGHLIGHT_DURATION_MS } from './highlight.js';
import type {
  ViewerContextMenuDetail,
  ViewerHighlight,
  ViewerMediaFrameDetail,
  ViewerPointerDetail,
  ViewerViewportDetail,
} from './rr-viewer.js';
import type { CalibrationCommitDetail, RRCalibrationDialog } from './rr-calibration-dialog.js';
import type { SensorNameCommitDetail, RRSensorDialog } from './rr-sensor-dialog.js';
import type { EditorTool, ToolSelectDetail } from './rr-tool-palette.js';
import type {
  ContextMenuItem,
  ContextMenuSelectDetail,
  RRContextMenu,
} from './rr-context-menu.js';

import '@shoelace-style/shoelace/dist/components/checkbox/checkbox.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import type { SlCheckbox } from '@shoelace-style/shoelace';
import './rr-viewer.js';
import './rr-toolbar.js';
import './rr-tool-palette.js';
import './rr-thumbnail-bar.js';
import './rr-calibration-dialog.js';
import './rr-sensor-dialog.js';
import './rr-context-menu.js';

/**
 * Node id for the snowflakes this editor mints, as `make_id` takes one.
 *
 * The node id only separates concurrent generators; it carries no meaning
 * downstream. Images already use 2 and 3, so sensors take their own rather than
 * sharing a stream with them.
 */
const SENSOR_NODE_ID = 4;

/**
 * Node id for car label snowflakes.
 *
 * Its own stream rather than the sensors': label ids and sensor ids are
 * separate namespaces that are never compared (`manifest.schema.ts`), and
 * generating them from one node makes them look related when they are not.
 */
const CAR_NODE_ID = 5;

/**
 * The gesture a click is waiting on a coordinate for.
 *
 * A calibration point is authored in two steps — the click gives the pixel, the
 * dialog gives the millimetres — and nothing is written until the second one
 * lands, so a dismissed dialog leaves the manifest and the undo stack untouched.
 * An edit carries the index rather than the point, because points have no `id`
 * and applying a history snapshot replaces them wholesale.
 */
type PendingCalibration =
  /** A new point, at the pixel that was clicked. */
  | { readonly kind: 'place'; readonly px: Point }
  /**
   * An existing point. `px` is carried alongside the index so the commit can
   * check it is still the same point: an undo while the dialog is open can
   * remove or replace another point and slide this index onto a different one.
   */
  | { readonly kind: 'edit'; readonly index: number; readonly px: Point };

/**
 * One car a live chain has already written, and the anchor it grew from.
 *
 * The chain is **view state** and the car is not: the car is in the manifest
 * with its own history entry, and this only remembers enough to walk the chain
 * backwards — which car to expect an undo to remove, and where the anchor sat
 * before it (`SPEC.md` § Undo and redo).
 *
 * Keyed by label `id` like everything else the editor holds across an await:
 * applying a history snapshot replaces the objects wholesale.
 */
interface ChainLink {
  /** The car this step wrote. */
  readonly carId: string;
  /** The anchor that car started from — where undo puts the anchor back. */
  readonly anchor: Point;
}

/**
 * What the editor is in the middle of — the state the gestures that mean two
 * things are dispatched on.
 *
 * Right-click is state-dependent by design (`SPEC.md` § Right-click is
 * state-dependent): idle opens the context menu on whatever is under the
 * cursor, while a chain is live it ends the chain instead. Undo is
 * state-dependent in the same way and against the same states — see
 * {@link RREditorView.interceptUndo}.
 *
 * `placing-car` is a chain in progress, whether it has written a car yet or
 * not: the first click takes an anchor, and **every click after it is
 * simultaneously the end of the current car and the start of the next** (#33).
 * A single car is simply a chain that was ended after one. The state itself is
 * **view state and never history** — an anchor writes nothing, so abandoning
 * one leaves the manifest and the stack untouched.
 *
 * One gesture meaning two things is a real cost, accepted because the two
 * states differ by whether a chain is in progress — which the rubber band
 * makes loudly visible.
 */
type EditorMode =
  | { readonly kind: 'idle' }
  /**
   * A chain in flight: the end the next click will draw from, and the cars this
   * chain has already written, oldest first.
   */
  | {
      readonly kind: 'placing-car';
      readonly anchor: Point;
      readonly chain: readonly ChainLink[];
    };

/**
 * What the open context menu acts on.
 *
 * Resolved when the menu opens, not when a row is chosen, because the menu
 * names verbs for *that* object and the user may have moved on by the time they
 * pick one. That is why the rows themselves name no object: the subject holds
 * it, and a row is a verb.
 *
 * Its own union rather than a `HitTarget`, because a `HitTarget` means *what a
 * gesture can grab* — a car's body grabs nothing, since the only edits a span
 * supports are to its two ends — while a menu acts on the **car** (#45).
 *
 * A calibration point carries the pixel it was opened on, the same staleness
 * guard the calibration dialog uses: an undo landing while the menu is up can
 * slide an index onto a different point, and points have no `id` to tell them
 * apart. Cars and sensors carry an `id` and need none — the subject names one
 * object however the list is replaced underneath.
 */
type MenuSubject =
  | { readonly kind: 'car'; readonly id: string }
  | { readonly kind: 'sensor'; readonly id: string }
  | { readonly kind: 'calibration'; readonly index: number; readonly px: Point };

/**
 * The kinds the menu hit-tests for: the objects drawn **over** the cars.
 *
 * Topmost drawn wins, matching the render order (`rr-viewer` draws cars first,
 * so a point or sensor on a car is not tinted over) — a sensor inside a car's
 * rectangle is the normal case, and car-area-first would make it unreachable.
 * Car ends are absent rather than merely outranked: a coupler's shared handle
 * names two cars at one pixel, so a hit there must **fall through** to the area
 * test, or right-clicking a joint — the most natural place to aim on a coupled
 * train — would open nothing.
 */
const MENU_HIT_KINDS: readonly HitKind[] = ['sensor', 'calibration'];

/**
 * Delete, the verb every object carries.
 *
 * It is why the editor needs no delete mode at all (`SPEC.md` § Right-click is
 * state-dependent). Reclassify — and the dotted class taxonomy as a submenu —
 * joins it when there are cars to reclassify. The `id` is what the editor
 * dispatches on and the label is what the user reads, so the same verb reads
 * correctly for each subject.
 */
const CALIBRATION_ITEMS: readonly ContextMenuItem[] = [
  { id: 'delete', label: 'Delete calibration point' },
];

/**
 * A sensor's verbs. Naming is here as well as on a click, because a name is
 * optional and an unnamed sensor gives a click nothing to discover.
 */
const SENSOR_ITEMS: readonly ContextMenuItem[] = [
  { id: 'name', label: 'Name sensor…' },
  { id: 'delete', label: 'Delete sensor' },
];

/**
 * Prefix of a row that reclassifies the subject to one class:
 * `reclassify:<class>`.
 *
 * The class is in the id and the car is not, because the subject already holds
 * the car — the menu is opened on one body, and a body is one object however
 * many cars are coupled to it.
 */
const RECLASSIFY_ROW_PREFIX = 'reclassify:';

/**
 * Prefix of a row that only **opens** a reclassify submenu.
 *
 * Its own prefix rather than a reclassify row with the class left off: an id
 * identifies a row, and two rows sharing one would defeat that the first time
 * something looked a row up. It also cannot be mistaken for a verb — the parse
 * below rejects it on the prefix alone.
 */
const RECLASSIFY_GROUP_ROW_PREFIX = 'reclassify-group:';

/** The class a `reclassify:` row names, or null for any other row. */
function classOfReclassifyRow(id: string): string | null {
  // A group row is opened rather than chosen, and its prefix is what says so.
  if (!id.startsWith(RECLASSIFY_ROW_PREFIX)) return null;
  return id.slice(RECLASSIFY_ROW_PREFIX.length) || null;
}

/**
 * The taxonomy as menu rows, for one car.
 *
 * Generated from `detector.vocabulary` (`vocabulary.ts`), so adding a subtype
 * to `config.yaml` and regenerating changes this menu with **no code edit** —
 * and the root is not among them, because it is required in the stored class
 * and absent from the UI (`SPEC.md` § Parameters live in `config.yaml`).
 *
 * A subtype that has subtypes of its own is a submenu, and a submenu's first
 * row is that subtype itself: a row that opens something cannot also be chosen,
 * and "a loco whose kind I cannot tell from the photograph" is a real answer
 * that must stay reachable.
 */
function reclassifyItems(choices: readonly ClassChoice[]): ContextMenuItem[] {
  return choices.map(choice => {
    const id = `${RECLASSIFY_ROW_PREFIX}${choice.class}`;
    if (choice.children.length === 0) return { id, label: choice.name };
    return {
      // The row that opens this subtype's submenu, distinct from the row inside
      // it that selects the subtype — see {@link RECLASSIFY_GROUP_ROW_PREFIX}.
      id: `${RECLASSIFY_GROUP_ROW_PREFIX}${choice.class}`,
      label: choice.name,
      items: [{ id, label: `${choice.name} (unspecified)` }, ...reclassifyItems(choice.children)],
    };
  });
}

/**
 * A car's verbs: delete, and reclassify when the taxonomy offers anything.
 *
 * Delete is the whole error-correction path for a label — deleting the middle
 * car of three leaves two cars and no residue, because a train is derived from
 * coincident endpoints and there is nothing else to clean up.
 *
 * Reclassify is **absent, not empty**, when the root has no subtypes: a
 * submenu that opens onto nothing is a worse answer than the absence of one,
 * which is the same rule that keeps a verbless object from opening a menu at
 * all.
 *
 * The rows name no car, because the subject is one (#45). They read the same
 * for a free car and for the middle of a twelve-car consist, which is what
 * naming the subject by its **body** rather than by a shared handle buys.
 */
function carItems(): ContextMenuItem[] {
  const choices = classChoices();

  const items: ContextMenuItem[] = [{ id: 'delete', label: 'Delete car' }];
  if (choices.length > 0) {
    items.push({
      // A group row: opened, never chosen. Its class is the root's, so every
      // group row in the tree is `reclassify-group:<class>` and each is unique.
      id: `${RECLASSIFY_GROUP_ROW_PREFIX}${rootClass()}`,
      label: 'Reclassify car',
      items: reclassifyItems(choices),
    });
  }
  return items;
}

/**
 * What a right-click found: the object the menu will act on, and the rows it
 * offers for it — or null when there is nothing to offer.
 *
 * One function resolves both, because a subject the menu cannot name a verb for
 * must not open a menu at all: a list of disabled rows is a worse answer than
 * the absence of one.
 *
 * **Topmost drawn wins**, so the subject is always predictable from the screen:
 * the point-like objects answer first ({@link MENU_HIT_KINDS}), and a car is
 * found by the **area** it is drawn as. That is why a car is reachable at all
 * where it is coupled — the middle car of a train has no free end, and its
 * joints are shared handles that name two cars at one pixel (#45).
 */
function menuFor(
  scene: HitScene,
  at: Point,
  tolerance: HitTolerance
): { readonly subject: MenuSubject; readonly items: readonly ContextMenuItem[] } | null {
  const hit = hitTest(scene, at, tolerance, MENU_HIT_KINDS);
  switch (hit?.kind) {
    case 'calibration': {
      const point = scene.calibrationPoints[hit.index];
      if (!point) return null;
      return {
        subject: { kind: 'calibration', index: hit.index, px: point.px },
        items: CALIBRATION_ITEMS,
      };
    }
    case 'sensor':
      return { subject: { kind: 'sensor', id: hit.id }, items: SENSOR_ITEMS };
  }

  const car = carUnderPointer(scene, at, tolerance);
  return car ? { subject: { kind: 'car', id: car.id }, items: carItems() } : null;
}

/**
 * Whether a press or release is the primary button — the only one that authors.
 *
 * `button` is 0 for a left click, for a touch and for a pen tip, and 2 for a
 * right click; a `pointermove` reports -1, which is why only the ends of a
 * gesture are filtered. The editor reads it off `originalEvent` rather than
 * asking `rr-viewer` to, because which buttons mean something is the editor's
 * decision and the live view has no gestures at all.
 */
function isPrimaryButton(event: PointerEvent): boolean {
  return event.button <= 0;
}

/**
 * What a drag does to the **view** rather than to the manifest (#44), or `null`
 * for the drags that author.
 *
 * Decided at pointer-down like everything else about a gesture, off two things
 * the press already knows: whether it landed on an object, and whether the
 * editor is zoomed.
 *
 * * `zoom-rect` — a plain drag from empty image while unzoomed, and a
 *   **Shift**-drag anywhere. Plain drag is the path that has to work on every
 *   engine and on touch, where the primary button is the only button; Shift is
 *   the desktop escape hatch for a frame with no empty pixel to start from, the
 *   same layering Save As already uses.
 * * `pan` — a plain drag from empty image while zoomed. Making the plain
 *   gesture state-dependent is a real cost, accepted on the same grounds
 *   right-click already accepts it: the two states differ by something the
 *   image itself makes obvious.
 *
 * Neither writes to the manifest, so neither opens a history entry: zoom is
 * view state and never enters the stack (`SPEC.md` § Undo and redo names it).
 */
type ViewGesture = 'zoom-rect' | 'pan';

/**
 * The pointer gesture currently in flight: one press, its moves, and its end.
 *
 * Everything a release needs is decided at **pointer-down** — what was under
 * the pointer, which handles move with it, and the history entry the whole
 * gesture will commit — so no motion event has to re-decide anything, and the
 * entry's snapshot is of the state before the first pixel moved.
 */
interface LiveGesture {
  /** Only this pointer drives the gesture; a second finger is ignored. */
  readonly pointerId: number;
  /** Where the press landed, in image pixels. Every delta is measured from here. */
  readonly origin: Point;
  /**
   * Where the press landed on the **glass**, in client pixels.
   *
   * Only a pan reads it, and it is why a pan is the one gesture measured in
   * screen coordinates: panning moves the transform the image coordinates are
   * reported through, so a delta taken from them would be a loop — the pixel
   * under the pointer is the pixel the pan just put there. The glass does not
   * move.
   */
  readonly originClient: Point;
  /** What the press grabbed, or null for empty image. */
  readonly hit: HitTarget | null;
  /** What this drag does to the view, or null when it authors instead. */
  readonly view: ViewGesture | null;
  /** The zoom rect the press started on — what a pan's travel is applied to. */
  readonly zoomAt: Rect | null;
  /**
   * The points this gesture moves. A list, not one object: a coupler drag moves
   * two car ends and one entry has to cover both (`SPEC.md` § Undo and redo).
   */
  readonly handles: readonly DragHandle[];
  /** The one history entry, opened at pointer-down and committed at pointer-up. */
  readonly entry: HistoryGesture | null;
  /**
   * Set once the pointer leaves the click slop, and **sticky** thereafter: a
   * drag walked back to where it started is still a drag, and must not fall
   * through to the click path and open a dialog.
   */
  dragging: boolean;
}

/**
 * A transient message for the user, carried up to `rr-app`'s toast.
 *
 * The editor states its own refusals rather than swallowing them — a gesture
 * that does nothing and says nothing reads as a broken editor — but it does not
 * own a place to put them: toasts live in `rr-app`, so this goes up with every
 * other `rr-*` event. It is a **notice, not an error**: nothing failed, the
 * editor declined to author something.
 */
export interface NotifyDetail {
  readonly message: string;
}

/**
 * Why the car tool refused a click, in one sentence.
 *
 * One string for both halves of the rule — a click on a car's **body** and one
 * on its **end handle** — because to the user they are the same refusal, and
 * two wordings for it would read as two different rules.
 */
const ALREADY_LABELED = 'That pixel is already inside a labeled car — a car is labeled once.';

/**
 * Main editor view: opens an archive, manages its images, reports DPT, and
 * authors calibration points, sensors and cars.
 *
 * **A click means whatever the active tool means** (#31). `rr-tool-palette`
 * chooses between calibration, sensor and car; the palette **gates the labeling
 * tools on DPT resolving**, and this component enforces the same gate — the
 * tool snaps back to calibration the moment the DPT stops resolving, so a
 * deleted or undone calibration point cannot leave a gated tool live.
 *
 * A click on empty image runs the active tool: calibration asks for the pixel's
 * world coordinate (#28), sensor places a point immediately, car takes two
 * clicks on the visible car ends and writes the span between them (#32). A
 * click **on an existing object** edits that object whatever the tool is — a
 * coordinate for a calibration point, a name for a sensor — because the object
 * under the cursor is less ambiguous than the mode; a chain in progress
 * outranks even that, since its next click is what completes the car. Dragging
 * moves whatever it grabbed, as one entry per gesture (#30), and right-click
 * opens the context menu on it (#29): delete for any of the three, naming for a
 * sensor, and reclassify for a car — which is named by its **body** rather than
 * by a handle, so a coupled car needs no free end (#45).
 *
 * The car tool **chains** (#33): every click after the first is simultaneously
 * the end of the current car and the start of the next, a rubber band shows the
 * chain in flight, and right-click ends it. Two gestures mean something else
 * while a chain is live — that right-click, and undo, which `rr-app` offers
 * here first through {@link interceptUndo}.
 *
 * **It owns the zoom** (#44), as view state the viewer is handed and draws: a
 * drag on empty image draws a rect to zoom to, or pans once zoomed, and a
 * Shift-drag draws a rect wherever it begins. It writes nothing and records
 * nothing, it survives an image change and a live chain, and a **reveal pans to
 * keep what an undo changed on screen** — the navigation invariant, in the one
 * case being zoomed introduces.
 *
 * **Objects are keyed by `id`, never by object identity** — cars by label id,
 * sensors by sensor id, calibration points by position because they carry no
 * id. Applying a history snapshot replaces the objects wholesale, so a held
 * reference points at a stale object immediately afterwards.
 *
 * DPT is reported live, with the fit residual once the fit is over-determined,
 * and a DPT below `layout.min_dpt` warns **persistently and blocks nothing** —
 * the fixture corpus sits at 18–19 and must stay editable. See `SPEC.md`
 * § Reference points.
 *
 * The classifier is not loaded here: displaying per-marker predictions was the
 * only thing that used it, and there are no markers to predict for. Live
 * inference remains in `rr-live-view`.
 */
@customElement('rr-editor-view')
export class RREditorView extends LitElement {
  @property({ attribute: false }) archive: R49Archive | null = null;
  /**
   * The undo stack, owned by `rr-app`. Every mutation below goes through it —
   * an edit recorded nowhere leaves a stack that is wrong rather than short,
   * and nothing in the compiler catches that.
   */
  @property({ attribute: false }) history: EditHistory | null = null;
  @property({ type: Boolean }) canUndo = false;
  @property({ type: Boolean }) canRedo = false;
  @property({ attribute: false }) undoLabel: string | null = null;
  @property({ attribute: false }) redoLabel: string | null = null;
  /**
   * The image the pending undo would land on, or `null` for a layout-scoped
   * entry that lands on none.
   *
   * Qualifying the tooltip with it is this component's job rather than
   * `rr-toolbar`'s or `rr-app`'s, because it is the only one that knows **both**
   * numbers: `rr-app` owns the stack and the editor owns which image is on
   * screen. The toolbar is handed a finished phrase.
   */
  @property({ attribute: false }) undoImage: string | null = null;
  @property({ attribute: false }) redoImage: string | null = null;
  @state() private _currentImageIndex = 0;
  @state() private _imageUrls: Map<string, string> = new Map();
  /**
   * The loaded image's size against the archive's, when the two are different
   * **shapes**, and `null` whenever they agree.
   *
   * `camera.resolution` is one value for the whole archive while the images are
   * per image (`SPEC.md` § Output encoding), so nothing binds an image's own
   * dimensions to the frame its labels are authored in. The viewer draws the
   * frame stretched over the photograph either way — an authored point stays on
   * the photograph, which is the bug this closes (#41) — but a stretch is a
   * guess about a crop nothing recorded, and a guess the user cannot see is the
   * failure repeating one level up. So it is stated, here, above the image it
   * is about.
   */
  @state() private _frameMismatch: ViewerMediaFrameDetail | null = null;
  /**
   * How far each image has drifted from the archive's reference image, in
   * `camera.resolution` pixels, by filename — the camera-drift readout (#95, #118).
   *
   * **Every image is measured, and `images[0]` is absent from this map by
   * construction**: it is the reference, so its drift is zero by definition and
   * asking would be asking whether an image matches itself. An image absent for
   * any other reason has not been measured — which is not the same as measuring
   * zero, and the render distinguishes them.
   *
   * **Held only in memory, on purpose.** A drift verdict is derived, and derived
   * state is never stored in a v4 manifest (map #89 § Notes; #6 already ruled
   * provenance fields out of the format) — the archive's images *are* the pose
   * record, so a verdict is recomputable and a stored one could go stale against
   * the very images it was computed from.
   */
  @state() private _driftPx = new Map<string, number>();
  /**
   * Which image is being measured, or `null` when none is.
   *
   * Rendered, because a check takes seconds on a phone and a user who has just
   * captured an image is looking straight at the place the warning would appear.
   * Silence there reads as "no problem found" long before the check has found
   * anything.
   */
  @state() private _driftChecking: string | null = null;
  /**
   * Which sweep's results are current.
   *
   * A sweep is several seconds of async work over an archive the user can edit
   * while it runs. Bumping this abandons the results of every sweep in flight,
   * which matters most for a **reorder**: it changes which image is the
   * reference, so a measurement that lands afterwards would be a drift against
   * an image that no longer defines the pose. Cheaper and less error-prone than
   * cancellation, since nothing here holds a resource to release.
   */
  private _driftSweepToken = 0;
  /**
   * What a click in the viewer means.
   *
   * Calibration is the default and the fallback: it is the only tool that works
   * on an uncalibrated archive, so an archive that opens without a DPT opens in
   * calibration mode and stays there until one resolves.
   */
  @state() private _tool: EditorTool = 'calibration';
  /** The click waiting on a coordinate, or null when no dialog is open. */
  private _pendingCalibration: PendingCalibration | null = null;
  /** The sensor whose name dialog is open, by `id`, or null when none is. */
  private _pendingSensorName: { readonly id: string } | null = null;
  /** The press in flight, or null between gestures. At most one at a time. */
  private _gesture: LiveGesture | null = null;
  /** What the context menu is open on, or null when it is closed. */
  private _menuSubject: MenuSubject | null = null;
  /**
   * Which state the state-dependent gestures dispatch on. See
   * {@link EditorMode}.
   *
   * Reactive because the **rubber band** is drawn from it: the band is what
   * makes a live chain visible, and the visibility is what pays for right-click
   * and undo meaning something else while one is in progress.
   */
  @state() private _mode: EditorMode = { kind: 'idle' };
  /**
   * Where the pointer last was, in whole image pixels, or null before it has
   * moved over the image.
   *
   * Tracked **only while a chain is live**, because it is only the rubber
   * band's far end: every other gesture reads its position off the event that
   * carried it. Following the pointer at rest otherwise would re-render the
   * editor on every mouse move for nothing.
   */
  @state() private _cursor: Point | null = null;
  /**
   * The objects a reveal is currently pointing at, or `null` when none is.
   *
   * View state, like the chain: it is written nowhere and survives nothing.
   * Resolved against the manifest **as it stands after the apply** and held as
   * ids, so it is subject to the same rule as everything else here — an object
   * reference would be stale the moment the next snapshot lands.
   */
  @state() private _highlight: readonly HistoryHighlight[] | null = null;
  /** Clears {@link _highlight}. Restarted by each reveal, cancelled on teardown. */
  private _highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The region of the authored frame on screen, or `null` for all of it (#44).
   *
   * View state, like the chain and the glow: it is written nowhere, it never
   * enters the history (`SPEC.md` § Undo and redo names zoom among the things
   * undo does not restore), and the viewer is handed it as a property and draws
   * it. **`null` is fit** — the absence of a zoom rather than a rect covering
   * the frame, which is exactly what the editor rendered before this existed.
   *
   * It **persists across image changes**: the rect is in the per-layout
   * authored frame, so it names the same region on every image of the archive,
   * and a labeler working through twenty frames of one yard zooms once. It is
   * dropped only when the frame itself stops meaning anything — a new archive,
   * which is New and Open both.
   */
  @state() private _zoom: Rect | null = null;
  /** The rect being dragged out, or null when none is. The band's other half. */
  @state() private _zoomPreview: Rect | null = null;
  /**
   * The viewer's viewport in screen pixels, as it last reported it.
   *
   * The editor cannot measure it — it does not own that box — and needs it for
   * exactly one thing: the cap on how far a rect may zoom in, which is stated
   * in screen pixels per frame pixel. Zeros until the viewer has laid out, and
   * `capZoomRect` caps nothing against zeros rather than inventing a screen.
   */
  private _viewport: Size = { width: 0, height: 0 };

  @query('rr-calibration-dialog') private _calibrationDialog!: RRCalibrationDialog;
  @query('rr-sensor-dialog') private _sensorDialog!: RRSensorDialog;
  @query('rr-context-menu') private _contextMenu!: RRContextMenu;

  static styles = [
    lookTokens,
    css`
    :host {
      display: flex;
      flex-grow: 1;
      height: 100%;
      overflow: hidden;
    }

    .sidebar {
      display: flex;
      flex-direction: column;
      /* The toolbar's own width, stated here as well so the palette below it
         wraps inside the same strip instead of widening the column to fit its
         gate note on one line. Both are 78px since #53 — a density change that
         touches only rr-toolbar leaves the column exactly as wide as it was. */
      width: 78px;
      flex-shrink: 0;
      /* The same rail the toolbar and the palette sit on, so the column reads
         as one strip however much of it the two elements fill. */
      background-color: var(--rail);
      overflow-y: auto;
    }

    .main-content {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      background: #111;
      position: relative;
    }

    /* The viewer and the controls drawn on top of it. Positioned, so the fit
       control is placed against the photograph rather than against the column
       of readout bars around it. */
    .viewer-wrap {
      position: relative;
      flex-grow: 1;
      /* A flex item will not shrink below its content by default, and the
         viewer's content is the photograph: without this the readout bars are
         pushed off the bottom of a short window. */
      min-height: 0;
    }

    rr-viewer {
      width: 100%;
      height: 100%;
    }

    /* Present only while zoomed (#44) — "show zoom bars as needed", applied to
       the one control there is. It sits on the glass rather than in the
       sidebar because a sixth button in that strip puts #42's reflow
       breakpoint back in play; see _renderFitControl. */
    .fit-control {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      font-size: 1.5rem;
      background: rgba(0, 0, 0, 0.45);
      border-radius: 8px;
    }

    .fit-control::part(base) {
      color: white;
    }

    .fit-control::part(base):hover {
      color: var(--sl-color-neutral-100);
    }

    rr-thumbnail-bar {
      flex-shrink: 0;
    }

    .placeholder {
      padding: 2rem;
      color: var(--sl-color-neutral-500);
    }

    .dpt-bar,
    .frame-warning,
    .drift-warning {
      flex-shrink: 0;
      padding: 0.5rem 1rem;
      font-family: var(--sl-font-mono);
      font-size: var(--sl-font-size-small);
      background: var(--sl-color-neutral-100);
      color: var(--sl-color-neutral-700);
      border-bottom: 1px solid var(--sl-color-neutral-200);
    }

    /* A frame mismatch gets the DPT bar's warning treatment because it is the
       same kind of statement: the archive is inconsistent with what it is being
       asked to do, and editing is not blocked. Camera drift is the third of
       exactly that kind, which is why it shares the row and the colour rather
       than inventing a louder one — the live view is where drift is allowed to
       shout, because there a machine is reading the output (#94, #95). */
    .dpt-bar.uncalibrated,
    .dpt-bar.below-minimum,
    .frame-warning,
    .drift-warning {
      background: var(--sl-color-warning-100);
      color: var(--sl-color-warning-800);
    }

    /* Three of the four drift states are not findings, and they keep the neutral
       treatment so that amber goes on meaning "something is wrong" and nothing
       else: a check in flight, an image measured and inside tolerance, and the
       reference image itself. Only a measurement past the tolerance is amber.

       The measured-and-fine row exists because the *reference* is user-movable
       (#118): a bar that appeared only on failure would let a reorder change the
       pose with nothing on screen moving. */
    .drift-warning.checking,
    .drift-warning.steady,
    .drift-warning.reference {
      background: var(--sl-color-neutral-100);
      color: var(--sl-color-neutral-700);
    }

    .dpt-bar .detail,
    .frame-warning .detail,
    .drift-warning .detail {
      margin-left: 1.5rem;
    }

    /* Directly above the thumbnail bar, whose badges are the same flag read for
       every other image. */
    .complete-bar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 1.5rem;
      padding: 0.5rem 1rem;
      font-size: var(--sl-font-size-small);
      background: var(--sl-color-neutral-100);
      color: var(--sl-color-neutral-700);
      border-top: 1px solid var(--sl-color-neutral-200);
    }

    .complete-bar .detail {
      color: var(--sl-color-neutral-600);
    }

    /* The sidebar reflows rather than scrolls (#42).
     *
     * Below the breakpoint the column does not fit — layout.ts carries the
     * measurement — and what falls off the bottom is the tool palette, which
     * is what decides whether a click places a calibration point, a sensor or
     * a car. The column is scrollable, but a flat green strip advertises
     * nothing and the platform's overlay scrollbar stays hidden until a scroll
     * has already begun, so the tools read as simply absent.
     *
     * Of the two fixes the ticket offered — reflow, or scroll with a visible
     * affordance — this is the reflow. A scroll hint would still leave the
     * palette a gesture away from a control the editor is unusable without,
     * and there is no shortage of *width* at these sizes: turning the strip
     * sideways spends the axis the window still has. The toolbar and the tool
     * palette turn with it at the same breakpoint; the strip wraps, so a
     * window too narrow for one row costs a second row rather than a hidden
     * button.
     *
     * The overflow-y: auto above is left inherited deliberately. The
     * strip is meant to fit at every size the editor supports and did in
     * every size measured — but "meant to" is not a guarantee across fonts and
     * zoom levels, and the host clips, so removing the scroll would trade a
     * hard-to-find control for an unreachable one. It is the floor under the
     * reflow, not the design.
     *
     * The readout bars give back their vertical padding at the same time. They
     * wrap to two lines at this width and were the other thing taking height
     * from the viewer. */
    @media (max-height: ${COMPACT_MAX_HEIGHT_PX}px) {
      :host {
        flex-direction: column;
      }

      .sidebar {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        width: auto;
        /* The column's shadow, turned through the same right angle as the
           column: one edge for the whole strip, which is why rr-toolbar drops
           its own here rather than drawing one down the strip's middle. */
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }

      .dpt-bar,
      .frame-warning,
      .drift-warning,
      .complete-bar {
        padding: 0.3rem 1rem;
      }
    }
  `,
  ];

  /**
   * Where the tool state is settled — **before** the render that shows it.
   *
   * Both branches set `_tool`, which is why they are here rather than in
   * `updated()`: a state write after the update has completed schedules a
   * second one, and Lit says so out loud.
   */
  protected willUpdate(changedProperties: Map<string, unknown>) {
    // A fresh archive brings its own state: an uncalibrated one opens in
    // calibration mode, and a calibrated one starts there too rather than
    // inheriting whichever tool the previous archive was left on. A half-placed
    // car goes with it — its anchor is a pixel on an image that is gone.
    if (changedProperties.has('archive')) {
      this._tool = 'calibration';
      this._abandonPlacement();
      this._clearHighlight();
      this._frameMismatch = null;
      // Drift measurements are keyed by filename, and a filename means nothing
      // on the next archive — the same reason the zoom rect goes below. Bumping
      // the token abandons any sweep still running against the old one; the new
      // sweep starts from `updated()`, once the images can be read.
      this._driftPx = new Map();
      this._driftChecking = null;
      this._driftSweepToken++;
      // New and Open both arrive here. A zoom rect is a region of *this*
      // layout's authored frame, so it names nothing on the next one — which is
      // the same reason it survives an image change and not an archive one.
      this._fitZoom();
    }
    this._enforceGate();
  }

  async updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('archive') && this.archive) {
      await this._refreshImageUrls();
      this._currentImageIndex = 0;
      // Not awaited: it is seconds of work over the whole archive, and the
      // editor is usable throughout — every row appears as its image is measured.
      void this._sweepDrift();
    }
  }

  /**
   * Whether a DPT resolves — the whole of the calibration gate.
   *
   * Gated on **existence, never on completion** (`SPEC.md` § Labeling
   * Workflow): two points at a nonzero separation is exactly what `getDPT`
   * answers, so the gate is that one call and nothing else. A DPT below
   * `MIN_DPT` still counts — it warns and blocks nothing.
   */
  private _calibrated(): boolean {
    return this.archive !== null && getDPT(this.archive.getManifest()) !== null;
  }

  /**
   * Drops a gated tool back to calibration when the DPT stops resolving.
   *
   * Run before every render rather than at the one place a point is deleted,
   * because the DPT can also vanish through an **undo** — `rr-app` applies a
   * snapshot straight into the archive, and no editor handler sees it. Every
   * stage stays re-enterable, so this is a demotion and never a lock: placing a
   * second point re-enables the tools immediately.
   */
  private _enforceGate() {
    if (this._tool !== 'calibration' && !this._calibrated()) {
      this._tool = 'calibration';
      // A car being placed goes with the tool: its second click would have to
      // derive a width from a DPT that no longer resolves.
      this._abandonPlacement();
    }
  }

  /**
   * Ends a chain in progress, wherever it is ended from.
   *
   * One method rather than an assignment at each site, because **every** way
   * out of the editor's current state has to close it — a tool change, an image
   * change, a lost DPT, a new archive, a reveal after undo, a right-click — and
   * a state whose exits are scattered is a state that eventually leaks one. It
   * writes nothing and records nothing: an anchor is view state, so an
   * abandoned chain costs the manifest and the undo stack nothing (`SPEC.md`
   * § Undo and redo) — however many cars it wrote, since each of those is its
   * own committed entry and none of them is undone by the chain ending.
   *
   * The cursor goes with it: it exists only to draw the rubber band.
   */
  private _abandonPlacement() {
    this._mode = { kind: 'idle' };
    this._cursor = null;
  }

  /**
   * A tool change abandons a car placement, and writes nothing.
   *
   * The anchor belongs to the tool that took it — leaving it live would make
   * the next click with *another* tool complete a car the user stopped drawing.
   */
  private _onToolSelect(e: CustomEvent<ToolSelectDetail>) {
    this._tool = e.detail.tool;
    this._abandonPlacement();
  }

  private async _refreshImageUrls() {
    if (!this.archive) return;
    const manifest = this.archive.getManifest();

    // Revoke old URLs
    this._imageUrls.forEach(url => URL.revokeObjectURL(url));
    this._imageUrls.clear();

    for (const img of manifest.images) {
      const data = await this.archive.getImage(img.filename);
      if (data) {
        const blob = new Blob([data as any], { type: 'image/jpeg' });
        this._imageUrls.set(img.filename, URL.createObjectURL(blob));
      }
    }
    this.requestUpdate();
  }

  /**
   * Rebuilds the blob URLs from the archive and optionally selects an image.
   *
   * Called by `rr-app` after undo or redo: the manifest changed underneath this
   * component, and an entry scoped to another image must bring that image into
   * view before the change lands. See `history.ts`.
   */
  public async syncFromArchive(
    revealFilename?: string,
    highlights: readonly HistoryHighlight[] = []
  ): Promise<void> {
    // An undo can select another image, and an anchor is a pixel on the image
    // it was clicked on: carried across, the next click would write a car with
    // one end from each frame. Labels are never carried between images
    // (`SPEC.md` § No copy-forward).
    //
    // A chain undoing *itself* does not come through here — it keeps its chain
    // by construction, and calls {@link _reveal} directly.
    this._abandonPlacement();
    await this._reveal(revealFilename, highlights);
  }

  /**
   * Brings an image into view **before** the entry that changes it is applied.
   *
   * The order the navigation invariant states (`SPEC.md` § Undo and redo): an
   * entry scoped to another image selects that image first, then applies, then
   * highlights. `rr-app` calls this with what the *pending* entry targets, then
   * applies the snapshot, then calls {@link syncFromArchive} with the same
   * filename and what the entry changed.
   *
   * It moves the selection and nothing else — no blob URLs are rebuilt, because
   * an entry that lands on an existing image adds no bytes to fetch, and the
   * reveal that follows rebuilds them anyway.
   */
  public selectImage(filename: string | undefined): void {
    if (!filename || !this.archive) return;
    const index = this.archive.getManifest().images.findIndex(img => img.filename === filename);
    if (index >= 0) this._currentImageIndex = index;
  }

  /**
   * Rebuilds the blob URLs and brings `revealFilename` into view, leaving the
   * editor's own state alone.
   *
   * The half of {@link syncFromArchive} that serves the history's navigation
   * invariant — undo may move the user, but it may never change something they
   * cannot see.
   */
  private async _reveal(
    revealFilename?: string,
    highlights: readonly HistoryHighlight[] = []
  ): Promise<void> {
    if (!this.archive) return;
    await this._refreshImageUrls();
    const images = this.archive.getManifest().images;
    if (revealFilename) {
      const index = images.findIndex(img => img.filename === revealFilename);
      if (index >= 0) this._currentImageIndex = index;
    }
    this._currentImageIndex = Math.max(0, Math.min(this._currentImageIndex, images.length - 1));
    // Last, and on the image now on screen: highlighting before the selection
    // would resolve car ids against the frame the user is leaving.
    this._showHighlight(highlights);
  }

  /**
   * Lights what an entry changed, for as long as {@link HIGHLIGHT_DURATION_MS}.
   *
   * The candidates are **kept as the history gave them** — ids and pixels — and
   * resolved afresh on every render, so nothing here can go stale while the
   * glow is up. What this does decide is whether there is anything to light at
   * all: an entry whose object the apply removed (an undone *add*) resolves to
   * nothing, and lights nothing rather than throwing.
   *
   * Nothing to light clears the glow rather than leaving the previous one up. A
   * completeness toggle changes something the user can see in the checkbox, and
   * a stale glow beside it would name the wrong edit.
   */
  private _showHighlight(highlights: readonly HistoryHighlight[]) {
    const { cars, sensors, calibration } = this._resolveHighlight(highlights);
    this._revealZoom(highlights);

    this._clearHighlight();
    if (cars.length + sensors.length + calibration.length === 0) return;

    this._highlight = highlights;
    this._highlightTimer = setTimeout(() => this._clearHighlight(), HIGHLIGHT_DURATION_MS);
  }

  /**
   * The history's candidates as the objects on screen now, dropping what is not
   * there.
   *
   * The one place a highlight is resolved **for drawing**, run both when a
   * reveal lands and on every render after it — {@link _highlightPoints} asks
   * the same question for the zoom, and only at the moment a reveal lands,
   * because a viewport does not follow the glow around. Both drop what the
   * apply removed, and by the same rule.
   *
   * Cars and sensors stay ids all the way to the viewer,
   * so nothing about them can go stale. A calibration point has no id and the
   * viewer can only address one by index, so the pixel becomes an index **here**
   * rather than being stored as one: an edit arriving during the 1400 ms the
   * glow is up — including another undo — renumbers the list, and an index
   * resolved earlier would then light a different crosshair.
   */
  private _resolveHighlight(highlights: readonly HistoryHighlight[]): ViewerHighlight {
    const cars: string[] = [];
    const sensors: string[] = [];
    const calibration: number[] = [];
    const points = this.archive?.getManifest().layout.calibration.points ?? [];

    for (const highlight of highlights) {
      switch (highlight.kind) {
        case 'car':
          if (this._car(highlight.id)) cars.push(highlight.id);
          break;
        case 'sensor':
          if (this._sensor(highlight.id)) sensors.push(highlight.id);
          break;
        case 'calibration': {
          const index = points.findIndex(point => samePoint(point.px, highlight.px));
          if (index >= 0) calibration.push(index);
          break;
        }
      }
    }

    return { cars, sensors, calibration };
  }

  /**
   * Brings what an undo changed into the zoomed view, or gives the zoom up.
   *
   * The navigation invariant needs this once the view can be a corner of a
   * frame (`SPEC.md` § Undo and redo: undo may move the user, it may never
   * change something they cannot see). Selecting the entry's image answers the
   * case where the change is on another frame; it does not answer being zoomed
   * into one corner and undoing an edit in another corner of the **same**
   * image, which is the case zoom introduces.
   *
   * The bounds are the changed objects' **authored points** — a car's two ends,
   * a sensor, a crosshair's pixel — and not the rectangle a car is drawn
   * inside. The rectangle is derived from DPT and is the wider claim; what the
   * reveal has to show is the geometry the entry actually moved.
   *
   * The decision itself is `geometry.ts` § `revealZoom`: unchanged when it is
   * already on screen, panned at the same zoom where it fits, and fit where it
   * does not.
   */
  private _revealZoom(highlights: readonly HistoryHighlight[]) {
    if (this._zoom === null) return;
    const frame = this._frame();
    if (!frame) return;
    this._zoom = revealZoom(this._zoom, boundsOfPoints(this._highlightPoints(highlights)), frame);
  }

  /**
   * Where the objects a reveal points at are, as points on the current image.
   *
   * Resolved the same way the glow is — by id for a car or a sensor, by pixel
   * for a calibration point — and dropping what the apply removed, so an undone
   * *add* moves the view no more than it lights anything.
   */
  private _highlightPoints(highlights: readonly HistoryHighlight[]): Point[] {
    const points: Point[] = [];
    const calibrationPoints = this.archive?.getManifest().layout.calibration.points ?? [];

    for (const highlight of highlights) {
      switch (highlight.kind) {
        case 'car': {
          const car = this._car(highlight.id);
          if (car) points.push(car.p0, car.p1);
          break;
        }
        case 'sensor': {
          const sensor = this._sensor(highlight.id);
          if (sensor) points.push({ x: sensor.x, y: sensor.y });
          break;
        }
        case 'calibration': {
          if (calibrationPoints.some(point => samePoint(point.px, highlight.px))) {
            points.push(highlight.px);
          }
          break;
        }
      }
    }
    return points;
  }

  /**
   * Takes the glow off, wherever it is being taken off from — the timer, the
   * next reveal, an image change, teardown.
   *
   * One method for the same reason {@link _abandonPlacement} is one: a piece of
   * view state whose exits are scattered eventually leaks one, and a leaked
   * timer here would clear a *later* reveal's highlight early.
   */
  private _clearHighlight() {
    if (this._highlightTimer !== null) clearTimeout(this._highlightTimer);
    this._highlightTimer = null;
    this._highlight = null;
  }

  /**
   * Undo, offered to the editor before it reaches the stack.
   *
   * **A live chain is a wall undo cannot cross** (`SPEC.md` § Undo and redo):
   * while one is in progress this consumes every undo, so the reflexive "wrong
   * place, undo" at the start of a train can never reach back and delete the
   * last car of the *previous* one. What it does inside the wall depends on
   * where in the chain it lands:
   *
   * * **At a chain's start** — an anchor and no car yet — it clears the anchor
   *   and drops to idle. Nothing was written, so nothing is undone.
   * * **Further along**, it undoes the entry the last car was recorded as and
   *   walks the anchor back to where that car began, leaving the chain live one
   *   step shorter. One car per undo, because a chain records one entry per car
   *   and never one for the train: a mis-click on the last coupler of a
   *   twelve-car consist must not cost the consist.
   *
   * The anchor steps back **only if that undo actually removed the car** this
   * chain recorded. An edit made mid-chain — a calibration point dragged
   * between clicks — sits on top of the stack and is what an undo reverses;
   * stepping the anchor back for it would move the chain for an edit that was
   * nothing to do with it.
   *
   * Called by `rr-app`, which owns undo and cannot see this state. The next
   * press proceeds into real history normally.
   *
   * @returns true when the chain consumed the undo.
   */
  public async interceptUndo(): Promise<boolean> {
    const mode = this._mode;
    if (mode.kind !== 'placing-car') return false;

    const link = mode.chain[mode.chain.length - 1];
    if (!link) {
      this._abandonPlacement();
      return true;
    }

    // Selected before the snapshot lands, exactly as `rr-app` does it: the
    // interception is a different route into the stack, not a different rule.
    this.selectImage(revealTarget(this.history?.undoEntry ?? null));
    const entry = (await this.history?.undo()) ?? null;
    if (entry) {
      this._notifyHistoryChange();
      await this._reveal(revealTarget(entry), entry.highlights);
    }
    // The reveal can have dropped the chain from under this — an undo that
    // removes a calibration point takes the DPT with it, and the gate ends the
    // chain. Nothing to step back to then.
    if (this._mode.kind === 'placing-car' && !this._car(link.carId)) {
      this._mode = { kind: 'placing-car', anchor: link.anchor, chain: mode.chain.slice(0, -1) };
    }
    return true;
  }

  /** The car with this id on the image on screen, or undefined once it is gone. */
  private _car(id: string): CarLabel | undefined {
    return this._currentImage()?.labels.find(car => car.id === id);
  }

  /** Asks `rr-app` to show a transient message — see {@link NotifyDetail}. */
  private _notify(message: string) {
    this.dispatchEvent(
      new CustomEvent<NotifyDetail>('rr-notify', {
        detail: { message },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Tells `rr-app` to re-render the undo affordances. */
  private _notifyHistoryChange() {
    this.dispatchEvent(new CustomEvent('rr-history-change', { bubbles: true, composed: true }));
  }

  /**
   * Selecting an image is **view state**: it shows that image's cars and
   * records no history entry, because nothing in the manifest changed.
   *
   * A car placement in progress does not survive it — its anchor is a pixel on
   * the image it was clicked on, and cars are never carried between images
   * (`SPEC.md` § No copy-forward).
   */
  private _onImageSelect(e: CustomEvent) {
    this._currentImageIndex = e.detail.index;
    this._abandonPlacement();
    // A glow names an object on the image it was resolved against, and the ids
    // in it mean nothing on the next one.
    this._clearHighlight();
    // The warning belongs to the image that earned it. The next image reports
    // its own size when it decodes, and one that never decodes must not inherit
    // this one's verdict.
    this._frameMismatch = null;
  }

  /**
   * The viewer learned what the media actually is. Keep it only when it
   * disagrees in shape with what the archive declares.
   */
  private _onMediaFrame(e: CustomEvent<ViewerMediaFrameDetail>) {
    this._frameMismatch = e.detail.aspectMismatch ? e.detail : null;
  }

  /**
   * The viewer measured its box. Kept for the zoom cap, and for nothing else.
   *
   * Not reactive: no render reads it, and a resize already re-renders through
   * the viewer's own state. It is read at the one moment a rect is authored.
   */
  private _onViewport(e: CustomEvent<ViewerViewportDetail>) {
    this._viewport = { width: e.detail.width, height: e.detail.height };
  }

  /**
   * The unzoomed view, wherever it is asked for — the fit control, Escape, a
   * new archive, a drag that selected the whole frame.
   *
   * One method for the same reason {@link _abandonPlacement} is one: a piece of
   * view state whose exits are scattered eventually leaks one. The band goes
   * with it, because a band belongs to a gesture and none is in flight by the
   * time anything here runs.
   */
  private _fitZoom() {
    this._zoom = null;
    this._zoomPreview = null;
  }

  /**
   * Escape fits — a desktop accelerator for the overlay control, never a
   * substitute for it: the labeling device is a phone, which has no Escape at
   * all.
   *
   * Nothing here asks whether a menu is open, and asking would not work:
   * `rr-context-menu` listens on the document in the **capture** phase, so it
   * has already closed by the time a listener out here runs. It therefore
   * **swallows** the Escape that dismissed it, and one that arrives here is one
   * no menu consumed.
   */
  private readonly _onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || this._zoom === null) return;
    this._fitZoom();
  };

  private async _onImageAdd(e: CustomEvent) {
    if (!this.archive) return;
    const { source } = e.detail;

    if (source === 'file') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png';
      input.onchange = async (event: any) => {
        const file = event.target.files[0];
        if (file) {
          const buffer = await file.arrayBuffer();
          await this._addImage(`img_${make_id(2)}.jpg`, new Uint8Array(buffer));
        }
      };
      input.click();
    } else if (source === 'camera') {
      try {
        await this._addImage(`capture_${make_id(3)}.jpg`, await captureFromCamera());
      } catch (err) {
        console.error('Failed to capture from camera', err);
      }
    }
  }

  /**
   * Add one image to the archive, select it, and check it for camera drift.
   *
   * One function for both sources because the drift check applies to both.
   * Issue #95 names the *capture* path, and a fresh capture is the case it was
   * written about — but "the archive it is being added to" is the operative
   * phrase, and an image picked off the filesystem is as likely to come from a
   * session where the tripod had moved. Two paths would have meant one of them
   * silently trusting an image the other checked.
   */
  private async _addImage(filename: string, bytes: Uint8Array) {
    if (!this.archive) return;
    await this._record('add image', { kind: 'images' }, () =>
      this.archive!.addImage(filename, bytes)
    );
    await this._refreshImageUrls();
    this._currentImageIndex = this.archive.getManifest().images.length - 1;
    // Not awaited: the image is added, selected and labelable now. A check runs
    // for seconds on a phone, and holding the editor for it would make the
    // warning cost more than the error it reports.
    void this._checkOneImage(filename, bytes);
  }

  /**
   * Measure every image against the archive's reference image — `images[0]`.
   *
   * **Warns persistently, never blocks** — the `MIN_DPT` precedent exactly
   * (`SPEC.md` § Reference points). A human is present and can judge, the check
   * has never been validated against a real drifted frame, and blocking
   * authoring on a heuristic would be worse than the disease.
   *
   * **Every image, not only the ones added this session** (#118). One image
   * defines the pose now, so the comparison is n-1 checks against one reference
   * rather than every-image-against-every-other, which is what made a whole-
   * archive sweep too expensive before. Sweeping is also the only way the
   * reference *choice* stays legible: reorder the strip and every number on
   * screen has to move, or the pose would change silently.
   *
   * **What a shift actually costs.** Car labels are authored on the image's own
   * pixels, so a translated image's spans are self-consistent and the training
   * data derived from them is fine — the offset is *not* baked into a label.
   * What breaks is everything per-*layout* read against this image: the sensors
   * and calibration were authored against the reference, so the overlay lands
   * off the track here.
   *
   * Guarded by a token rather than by cancellation, because the archive can
   * change under a sweep — an add, a delete, a reorder — and a stale result is
   * worse than a missing one: it would name a drift measured against a reference
   * that is no longer the reference. An uncalibrated layout resolves no tolerance
   * and is not swept at all: a fraction of a track width needs a track width.
   */
  private async _sweepDrift() {
    if (!this.archive) return;
    const token = ++this._driftSweepToken;
    this._driftPx = new Map();
    this._driftChecking = null;

    if (maxDriftPx(getDPT(this.archive.getManifest())) === null) return;

    let session;
    try {
      session = await openDriftCheck(this.archive);
    } catch (err) {
      console.error('Camera-drift reference could not be built', err);
      return;
    }
    if (!session || token !== this._driftSweepToken) return;

    // Skip index 0: it *is* the reference, so its drift is zero by definition
    // and measuring it would be asking whether an image matches itself.
    for (const { filename } of this.archive.getManifest().images.slice(1)) {
      if (token !== this._driftSweepToken) return;
      this._driftChecking = filename;
      try {
        const bytes = await this.archive.getImage(filename);
        if (!bytes) continue;
        const { displacementPx } = await session.check.check(await planeFromBytes(bytes));
        if (token !== this._driftSweepToken) return;
        this._driftPx = new Map(this._driftPx).set(filename, displacementPx);
      } catch (err) {
        // The image is in the archive and labelable. A measurement that could not
        // run leaves no row rather than an error row: the labeler did not ask for
        // this check, and an error about a warning would be noise about noise.
        console.error(`Camera-drift check failed for ${filename}`, err);
      }
    }
    if (token === this._driftSweepToken) this._driftChecking = null;
  }

  /**
   * Measure one image against the reference, leaving the rest alone.
   *
   * What an **add** needs: appending cannot change which image is at position 0,
   * so every measurement already taken still stands. A full sweep would re-check
   * the whole archive for one new image, and a labeler adding a dozen captures in
   * a row would pay for it a dozen times.
   */
  private async _checkOneImage(filename: string, bytes: Uint8Array) {
    if (!this.archive) return;
    const token = this._driftSweepToken;
    if (maxDriftPx(getDPT(this.archive.getManifest())) === null) return;
    // The image just added *is* the reference when it is the archive's first.
    if (this.archive.getManifest().images[0]?.filename === filename) return;

    this._driftChecking = filename;
    try {
      const session = await openDriftCheck(this.archive);
      if (!session || token !== this._driftSweepToken) return;
      const { displacementPx } = await session.check.check(await planeFromBytes(bytes));
      if (token !== this._driftSweepToken) return;
      // Replaced rather than mutated: Lit does not observe a Map's contents, and
      // `@state` compares by identity.
      this._driftPx = new Map(this._driftPx).set(filename, displacementPx);
    } catch (err) {
      console.error(`Camera-drift check failed for ${filename}`, err);
    } finally {
      if (this._driftChecking === filename) this._driftChecking = null;
    }
  }

  private async _onImageDelete(e: CustomEvent) {
    if (!this.archive) return;
    const { index } = e.detail;
    const manifest = this.archive.getManifest();
    const image = manifest.images[index];
    if (image) {
      // `retain` is what makes the removal reversible: removeImage() drops the
      // bytes from the zip, so they have to be read out before it runs. Without
      // it the entry restores a manifest row naming an image that is not there.
      await this._record(
        'delete image',
        { kind: 'images' },
        () => this.archive!.removeImage(image.filename),
        { retain: [image.filename] }
      );
      await this._refreshImageUrls();
      this._currentImageIndex = Math.max(0, Math.min(this._currentImageIndex, manifest.images.length - 1));
      // Deleting the image at position 0 promotes the next one to reference, so
      // every measurement was against an image that no longer defines the pose.
      // Deleting any other image invalidates nothing — drop its row and stop.
      if (index === 0) {
        void this._sweepDrift();
      } else {
        const remaining = new Map(this._driftPx);
        remaining.delete(image.filename);
        this._driftPx = remaining;
      }
    }
  }

  private async _onImageReorder(e: CustomEvent) {
    if (!this.archive) return;
    const { from, to } = e.detail;

    // Update current index if the selected image moved or if its position shifted
    if (this._currentImageIndex === from) {
      this._currentImageIndex = to;
    } else if (from < this._currentImageIndex && to >= this._currentImageIndex) {
      this._currentImageIndex--;
    } else if (from > this._currentImageIndex && to <= this._currentImageIndex) {
      this._currentImageIndex++;
    }

    await this._record('reorder images', { kind: 'images' }, () =>
      this.archive!.reorderImages(from, to)
    );
    this.requestUpdate();

    // **A reorder can change the reference, and that is the whole design.**
    // Position 0 defines the pose (#118), so dragging a thumbnail to the front
    // re-points the comparison — and because every image's drift is on screen,
    // re-sweeping is what makes that visible instead of silent. Unconditional
    // rather than only when position 0 changed: `from`/`to` both being non-zero
    // still shifts what sits at 0 when one of them crosses it, and getting that
    // arithmetic subtly wrong would leave stale numbers attributed to the wrong
    // reference. A sweep is idempotent and costs seconds of background work.
    void this._sweepDrift();
  }

  /**
   * Runs a mutation through the undo stack, or directly when no history is
   * attached (tests that mount this component on its own).
   *
   * `target` is declared by the caller because only it knows which subtree it
   * touches, and mis-declaring it is the one class of bug scoped snapshots
   * admit — see `history.ts`.
   */
  private async _record(
    label: string,
    target: HistoryTarget,
    mutate: () => unknown,
    options?: { retain?: string[] }
  ) {
    if (!this.history) {
      await mutate();
      return;
    }
    await this.history.record(label, target, mutate, options);
    this._notifyHistoryChange();
  }

  /**
   * Everything a gesture needs, decided where the pointer went down.
   *
   * The hit-test runs **here** rather than at release: the press is where the
   * user aimed, and a drag has to know what it grabbed before it can move it.
   * The history entry opens here too, so its snapshot is of the state before
   * the first motion event — the whole gesture then costs one Cmd+Z, not one
   * per pixel of travel (`SPEC.md` § Undo and redo).
   *
   * A press arriving while a gesture is live is read by its `pointerId`. A
   * **different** one is a second finger, and is ignored rather than allowed to
   * replace the first. The **same** one cannot be a second finger — a pointer
   * cannot go down twice without going up — so it means the previous gesture's
   * end never arrived, and it is closed here rather than left to block every
   * press and every undo for the rest of the session. `rr-viewer` emits nothing
   * when it has no transform to convert with, which is one way that happens.
   */
  private _onViewerPointerDown(e: CustomEvent<ViewerPointerDetail>) {
    // Only the primary button authors anything. A right-click arrives through
    // these same pointer events, so without this the press that opens the
    // context menu also runs the click path and puts the calibration dialog up
    // behind it. Touch and pen report button 0, so nothing is lost there — and
    // a right press during a drag is ignored here rather than closing it.
    if (!isPrimaryButton(e.detail.originalEvent)) return;

    const pointerId = e.detail.originalEvent.pointerId;
    if (this._gesture) {
      if (this._gesture.pointerId !== pointerId) return;
      // Not awaited: this handler must have the new gesture in place before the
      // first pointer-move can arrive. `commit()` pushes its entry before it
      // yields, so the stale entry still lands ahead of the one opened below.
      void this._endGesture(this._gesture);
    }
    if (!this.archive) return;

    const at = e.detail.point;
    const scene = this._scene();
    const hit = hitTest(scene, at, this._tolerance(DEFAULT_GRAB_RADIUS_SCREEN_PX, e.detail));
    // What this drag will do to the view, decided here so no motion event has
    // to re-decide it — and so a Shift-drag that begins on a car end moves
    // nothing, whatever the hit-test found.
    const view = this._viewGesture(hit, e.detail.originalEvent);
    const handles = hit && view === null ? dragHandles(hit, scene) : [];

    this._gesture = {
      pointerId,
      origin: at,
      originClient: {
        x: e.detail.originalEvent.clientX,
        y: e.detail.originalEvent.clientY,
      },
      hit,
      view,
      zoomAt: this._zoom,
      handles,
      entry: hit && handles.length > 0 ? this._beginDragEntry(hit) : null,
      dragging: false,
    };
  }

  /**
   * Which view gesture a press begins, or null when it begins an authoring one.
   *
   * The whole of the table in {@link ViewGesture}, in one place: Shift always
   * means a rect, and a press on empty image means a rect while fit and a pan
   * while zoomed. A press **on an object** authors, exactly as it did before
   * zoom existed — dragging an object is what a labeler does most, and it must
   * not become state-dependent.
   */
  private _viewGesture(hit: HitTarget | null, event: PointerEvent): ViewGesture | null {
    if (event.shiftKey) return 'zoom-rect';
    if (hit) return null;
    return this._zoom === null ? 'zoom-rect' : 'pan';
  }

  /** The image on screen, or undefined when the archive has none. */
  private _currentImage(): Image | undefined {
    return this.archive?.getManifest().images[this._currentImageIndex];
  }

  /**
   * The authored frame — `camera.resolution` — or undefined with no archive.
   *
   * The frame every zoom rect is expressed in, and the bounds it is clamped
   * against. Named here because three zoom paths need it and each would
   * otherwise re-walk the manifest for it, exactly as {@link _currentImage} is
   * named for the image.
   */
  private _frame(): FrameSize | undefined {
    return this.archive?.getManifest().camera.resolution;
  }

  /**
   * Everything a pointer can land on, for the image on screen.
   *
   * Every gesture that asks "what is under here" reads it from here, so the
   * press, the right-click and the drag all see the same objects.
   *
   * Cars come from the **current image** and sensors from `layout`, which is
   * the whole of the per-image/per-layout distinction as a gesture sees it:
   * switching images swaps the cars and leaves the sensors, because a sensor is
   * placed once and answers for every frame (`SPEC.md` § Location Data).
   */
  private _scene(): HitScene {
    const manifest = this.archive?.getManifest();
    return {
      cars: this._currentImage()?.labels ?? [],
      sensors: manifest?.layout.sensors ?? [],
      calibrationPoints: manifest?.layout.calibration.points ?? [],
      // Not a thing to hit: the scale the world-sized objects are drawn at, so
      // a sensor is grabbable across the symbol the user can actually see.
      dpt: manifest ? getDPT(manifest) : null,
    };
  }

  /**
   * Opens the one history entry a drag will commit.
   *
   * The **target follows what was grabbed**, because that is the subtree the
   * gesture will write: a car end lives in one image record, a sensor and a
   * calibration point in `layout`. Mis-declaring it is the one class of bug
   * scoped snapshots admit. One entry still covers however many objects move
   * under it — a coupler drag's two cars share the one image record, which is
   * exactly why the target is a subtree and not an object.
   *
   * The label is what the undo tooltip reads back, so it names what moved.
   */
  private _beginDragEntry(hit: HitTarget): HistoryGesture | null {
    switch (hit.kind) {
      case 'car-endpoint':
      case 'coupler': {
        const filename = this._currentImage()?.filename;
        if (!filename) return null;
        const label = hit.kind === 'coupler' ? 'move coupler' : 'move car endpoint';
        return this.history?.beginGesture(label, { kind: 'image', filename }) ?? null;
      }
      case 'sensor':
        return this.history?.beginGesture('move sensor', { kind: 'layout' }) ?? null;
      case 'calibration':
        return this.history?.beginGesture('move calibration point', { kind: 'layout' }) ?? null;
    }
  }

  /**
   * Motion, which becomes a drag only once it clears the click slop.
   *
   * Nothing is recorded here — the open entry already holds the pre-drag
   * snapshot, so the manifest is free to be written on every event.
   */
  private _onViewerPointerMove(e: CustomEvent<ViewerPointerDetail>) {
    // The rubber band's far end, and the one thing here that is not part of a
    // press: a chain is placed by clicks, so its band has to follow a pointer
    // with no button down. Rounded, because the band previews the pixel the
    // next click will write.
    if (this._mode.kind === 'placing-car') {
      this._cursor = { x: Math.round(e.detail.point.x), y: Math.round(e.detail.point.y) };
    }

    const gesture = this._current(e);
    if (!gesture) return;

    if (!gesture.dragging) {
      if (isClick(gesture.origin, e.detail.point, this._tolerance(CLICK_SLOP_SCREEN_PX, e.detail))) {
        return;
      }
      gesture.dragging = true;
    }
    this._applyDrag(gesture, e.detail);
  }

  /**
   * One motion of a drag, dispatched on what the press decided it was.
   *
   * The three are exclusive by construction — a view gesture takes no handles —
   * so this is a branch and not a sequence.
   */
  private _applyDrag(gesture: LiveGesture, detail: ViewerPointerDetail) {
    switch (gesture.view) {
      case 'zoom-rect':
        // The band is what was drawn, not what the zoom will be: the cap and
        // the clamp are applied when the gesture lands, so the feedback follows
        // the pointer exactly and the correction is visible as a correction.
        this._zoomPreview = rectBetween(gesture.origin, detail.point);
        return;
      case 'pan':
        this._panTo(gesture, detail);
        return;
      case null:
        this._moveHandles(gesture, detail.point);
        return;
    }
  }

  /**
   * Where a pan has taken the view: the pointer's travel on the **glass**,
   * converted to frame pixels and applied to the rect the press started on.
   *
   * Screen coordinates rather than the image ones every other gesture uses, and
   * this is the one place that is right: a pan moves the transform those
   * coordinates are reported through, so measuring the travel in them would
   * measure the pan's own effect.
   */
  private _panTo(gesture: LiveGesture, detail: ViewerPointerDetail) {
    const from = gesture.zoomAt;
    const frame = this._frame();
    if (!from || !frame) return;

    const delta = {
      x: (detail.originalEvent.clientX - gesture.originClient.x) * detail.imagePxPerScreenPx,
      y: (detail.originalEvent.clientY - gesture.originClient.y) * detail.imagePxPerScreenPx,
    };
    this._zoom = panZoomRect(from, delta, frame);
  }

  /**
   * Where a zoom-rect gesture landed: the region drawn, capped and clamped.
   *
   * A rect that turned out to cover the whole frame is `null` rather than a
   * rect — fit is the absence of a zoom (`geometry.ts` § `zoomRectFromDrag`).
   */
  private _applyZoomRect(gesture: LiveGesture, detail: ViewerPointerDetail) {
    const frame = this._frame();
    if (!frame) return;
    this._zoom = zoomRectFromDrag(gesture.origin, detail.point, frame, this._viewport);
  }

  /**
   * The end of the gesture: commit what moved, or interpret the click.
   *
   * One entry lands here or none at all — a drag returned to its origin leaves
   * the subtree byte-identical, and `EditHistory` suppresses it by value rather
   * than by trusting that the user meant it.
   *
   * A gesture that dragged never falls through to the click path, even if it
   * ended back inside the slop. Without that, every swipe over the image would
   * place a point, and the labeling device is a phone.
   *
   * The click itself splits twice. A **placement in progress wins outright**:
   * the second click of a car is the click that gives it its other end, and
   * interpreting it as anything else would strand the anchor. Otherwise **an
   * object under the cursor is edited whatever the tool is**, and only a click
   * on empty image is dispatched on the active tool — anything else would let
   * the sensor tool stack a sensor on a calibration point the user was aiming
   * at.
   */
  private async _onViewerPointerUp(e: CustomEvent<ViewerPointerDetail>) {
    // The mouse reports one `pointerId` for every button, so the release of a
    // secondary button carries the id of a left drag still in progress. Ending
    // that drag here would commit it on a press the user did not mean as one.
    if (!isPrimaryButton(e.detail.originalEvent)) return;

    const gesture = this._current(e);
    if (!gesture) return;

    if (gesture.dragging) {
      // A zoom-rect gesture commits **here** and not on every move: the drag is
      // a region being described, and re-zooming per motion event would move
      // the frame the pointer is being reported in while it is being drawn.
      if (gesture.view === 'zoom-rect') this._applyZoomRect(gesture, e.detail);
      else this._applyDrag(gesture, e.detail);
    }
    // The band belongs to the gesture, however it ended.
    this._zoomPreview = null;
    await this._endGesture(gesture);
    if (gesture.dragging) return;
    if (!isClick(gesture.origin, e.detail.point, this._tolerance(CLICK_SLOP_SCREEN_PX, e.detail))) {
      return;
    }

    // The click names a pixel, so that is what is stored — a fractional
    // coordinate would be precision the gesture does not have.
    const px = { x: Math.round(gesture.origin.x), y: Math.round(gesture.origin.y) };

    if (this._mode.kind === 'placing-car') {
      await this._completeCar(this._mode, px);
      return;
    }

    if (gesture.hit) {
      await this._editHit(gesture.hit);
      return;
    }

    await this._useTool(px);
  }

  /**
   * A click that landed on an object: edit *that* object, whatever the tool is.
   *
   * What "edit" means is the object's own property that a click can ask for —
   * a calibration point's world coordinate, a sensor's name. A **car end has no
   * such property**: its position is what a drag is for and its class is what
   * the context menu is for (#35), so a click on one does nothing. Doing
   * nothing is the right answer rather than falling through to the tool and
   * stacking something on top of the label the user was aiming at.
   *
   * With the **car tool** live it says so, in the same words a click on the
   * car's body gets (#43): a handle sits inside the rectangle that refusal is
   * measured against, so the two are one rule to the user and only the code
   * knows the click was routed here by the hit-test instead. Under the other
   * tools there is nothing to explain — the user was not trying to author a
   * car — so the click stays silent.
   */
  private async _editHit(hit: HitTarget) {
    switch (hit.kind) {
      case 'calibration': {
        const point = this.archive!.getManifest().layout.calibration.points[hit.index];
        if (!point) return;
        this._pendingCalibration = { kind: 'edit', index: hit.index, px: point.px };
        await this._calibrationDialog.show(point.world, { mode: 'edit' });
        return;
      }
      case 'sensor': {
        await this._openSensorName(hit.id);
        return;
      }
      case 'car-endpoint':
      case 'coupler': {
        if (this._tool === 'car') this._notify(ALREADY_LABELED);
        return;
      }
    }
  }

  /**
   * A click on empty image, dispatched on the active tool.
   *
   * The gate is re-checked here rather than trusted from the palette: the
   * palette is a view of `_tool`, and a click is what actually writes. A gated
   * tool cannot be active — {@link _enforceGate} demotes it — so this is the
   * belt to that braces, not a second policy.
   */
  private async _useTool(px: Point) {
    switch (this._tool) {
      case 'calibration':
        this._pendingCalibration = { kind: 'place', px };
        await this._calibrationDialog.show();
        return;
      case 'sensor':
        if (!this._calibrated()) return;
        await this._placeSensor(px);
        return;
      case 'car': {
        if (!this._calibrated() || !this._currentImage()) return;
        // A pixel already inside a car's rectangle carries a label, so a chain
        // started there would stack a second box on the same vehicle (#43) —
        // the generalisation of the rule that already stops a click on a car
        // *end* from starting one, from the handle out to the whole body. Only
        // the click that **starts** a chain is checked: every click after it is
        // deliberately aimed at an existing end, which is how a car is coupled
        // onto a train already drawn.
        if (carCovering(this._scene(), px)) {
          this._notify(ALREADY_LABELED);
          return;
        }
        // The first click of a chain: it names one end and writes nothing. An
        // abandoned chain therefore costs the manifest and the undo stack
        // nothing at all.
        this._mode = { kind: 'placing-car', anchor: px, chain: [] };
        this._cursor = px;
        return;
      }
    }
  }

  /**
   * A click that closes one car and **opens the next**: write the car, then
   * take its far end as the anchor of the car after it.
   *
   * That is the whole of chaining (`SPEC.md` § Authoring cars). The coincidence
   * a train is derived from is guaranteed because the same pixel is written as
   * one car's `p1` and handed straight on as the next one's `p0` — nothing
   * about the train itself is stored, and nothing needs to be.
   *
   * A car is the straight chord between two free clicks on the visible ends —
   * no snapping, because v4 stores no track to snap to, and the photograph
   * shows the labeler where the car actually is. Width is **not** stored: it is
   * derived from DPT at render time, which is what the calibration gate buys.
   *
   * `provenance: 'human'` with **no** `proposed_by` — the schema forbids the
   * key on a human label, because a default of `human` on model output is the
   * exact feedback loop provenance exists to make measurable.
   *
   * `class` is the **taxonomy root, read out of `config.yaml`** rather than
   * written here: a class name in `ui/` would be a second home for a value the
   * config owns, agreeing with the vocabulary only by luck. The root is
   * required in the stored class — a label maps to the longest entry of
   * `detector.classes` that is a segment-prefix of its class, and an unrooted
   * one would match nothing and be dropped from the export. A car starts there
   * and is reclassified downwards through the context menu (#35), because
   * refinement is an occasional act and not a mode.
   *
   * **One entry per car, never one for the train**: a mis-click on the last
   * coupler of a twelve-car consist must cost one car, and undo must not invent
   * an aggregate the format refuses to have (`SPEC.md` § Undo and redo).
   *
   * Two clicks on the **same pixel** describe no car and write none — a span
   * with no length has neither an axis to draw along nor two ends to couple —
   * and the chain simply stays where it was, waiting for a real second end.
   *
   * The chain ends outright if there is no image to write to: the last one was
   * deleted underneath it, and an anchor pointing at a frame that is gone is
   * worse than no anchor.
   */
  private async _completeCar(mode: Extract<EditorMode, { kind: 'placing-car' }>, px: Point) {
    const image = this._currentImage();
    if (!image) {
      this._abandonPlacement();
      return;
    }

    const { anchor } = mode;
    if (samePoint(px, anchor)) return;

    const car: CarLabel = {
      id: make_id(CAR_NODE_ID),
      class: rootClass(),
      provenance: 'human',
      p0: { ...anchor },
      p1: { ...px },
    };
    // The chain advances before the write, so the band the next mouse move
    // draws already starts at the coupling this click just made. The anchor is
    // a **copy** of the pixel, never the object the label holds: the editor
    // keeps no reference to anything a history snapshot will replace, and the
    // coincidence is in the values rather than in the identity.
    this._mode = {
      kind: 'placing-car',
      anchor: { ...px },
      chain: [...mode.chain, { carId: car.id, anchor }],
    };
    this._cursor = { ...px };
    await this._record('place car', { kind: 'image', filename: image.filename }, () => {
      this._writeImage(image.filename, { labels: [...image.labels, car] });
    });
  }

  /**
   * Places a sensor at a pixel, as one `layout` entry.
   *
   * Unnamed, and that is a complete sensor rather than a half-finished one:
   * consumers key on `id`, and `name` is optional passthrough that is **never
   * auto-generated** (`SPEC.md` § Occupancy Output). The id is a snowflake from
   * `@occupancy/uid`, unique within the layout because it is unique full stop.
   *
   * No provenance field exists to set: no model can propose where a human wants
   * an answer, so the format gives sensors none.
   */
  private async _placeSensor(px: Point) {
    const manifest = this.archive!.getManifest();
    await this._record('place sensor', { kind: 'layout' }, () => {
      this._writeLayout({
        sensors: [...manifest.layout.sensors, { id: make_id(SENSOR_NODE_ID), x: px.x, y: px.y }],
      });
    });
  }

  /** The sensor with this id, or undefined once it is gone. */
  private _sensor(id: string): Sensor | undefined {
    return this.archive?.getManifest().layout.sensors.find(s => s.id === id);
  }

  /** Opens the name dialog on a sensor, if it is still there. */
  private async _openSensorName(id: string) {
    const sensor = this._sensor(id);
    if (!sensor) return;
    this._pendingSensorName = { id };
    await this._sensorDialog.show(sensor.name ?? null, { id });
  }

  /**
   * The browser took the gesture away: it ended nowhere and means nothing.
   *
   * What moved goes back to exactly where it started — restoring the handles
   * rather than the snapshot, so a cancelled drag is undone even when no
   * history is attached. The entry is then closed against an unchanged subtree
   * and records nothing.
   */
  private async _onViewerPointerCancel(e: CustomEvent<ViewerPointerDetail>) {
    const gesture = this._current(e);
    if (!gesture) return;

    if (gesture.dragging) this._moveHandles(gesture, gesture.origin);
    // A view gesture goes back the same way: a pan to the rect it started on,
    // a band to nothing. Neither wrote anything, so there is nothing else to
    // put back.
    if (gesture.view === 'pan') this._zoom = gesture.zoomAt;
    this._zoomPreview = null;
    await this._endGesture(gesture);
  }

  /**
   * Right-click, dispatched on the editor's state.
   *
   * The browser's own menu is suppressed **here** rather than in `rr-viewer`,
   * and for every right-click the viewer reports rather than only the ones that
   * open something: inside the labeling surface a right-click is the editor's
   * gesture whatever it lands on, and once a chain can be live the same press
   * ends it over empty image. The live view shares the viewer and does not
   * listen, so its right-click stays the browser's.
   *
   * The state branch is the point of this handler (`SPEC.md` § Right-click is
   * state-dependent): idle opens the menu, and a live chain **ends instead**.
   * The next click starts a new train.
   */
  private _onViewerContextMenu(e: CustomEvent<ViewerContextMenuDetail>) {
    e.detail.originalEvent.preventDefault();

    // A press is still in flight: the object under the cursor is mid-drag, and
    // a menu naming verbs for a position the user has not settled on would act
    // on geometry that is about to change. The gesture keeps the pointer.
    if (this._gesture) return;

    switch (this._mode.kind) {
      case 'idle':
        void this._openContextMenu(e.detail);
        return;
      case 'placing-car':
        // The chain's cars stay: each is its own committed entry, and ending a
        // chain undoes nothing. Only the anchor goes, and an anchor is view
        // state. No menu opens either — one gesture means one thing per state.
        this._abandonPlacement();
        return;
    }
  }

  /**
   * The idle branch: a menu on the object under the cursor.
   *
   * Empty image opens nothing, and so does an object with no verbs — see
   * {@link menuFor}. The subject is resolved now rather than when a row is
   * chosen, because the rows are named for *this* object.
   */
  private async _openContextMenu(detail: ViewerContextMenuDetail) {
    this._menuSubject = null;
    this._contextMenu.hide();
    if (!this.archive) return;

    const menu = menuFor(
      this._scene(),
      detail.point,
      this._tolerance(DEFAULT_GRAB_RADIUS_SCREEN_PX, detail)
    );
    if (!menu) return;

    this._menuSubject = menu.subject;
    // The cursor, in the frame it was reported in: the menu is placed on the
    // glass, which is the one editor position that is a screen coordinate.
    await this._contextMenu.show(
      { x: detail.originalEvent.clientX, y: detail.originalEvent.clientY },
      menu.items
    );
  }

  /** A row was chosen. The menu has closed itself by the time this runs. */
  private async _onContextMenuSelect(e: CustomEvent<ContextMenuSelectDetail>) {
    const subject = this._menuSubject;
    this._menuSubject = null;
    if (!subject || !this.archive) return;

    // A row is a verb; the subject is what it acts on. Only a car offers this
    // one, so a row arriving against any other subject is dropped rather than
    // guessed at.
    const cls = classOfReclassifyRow(e.detail.id);
    if (cls !== null) {
      if (subject.kind === 'car') await this._reclassifyCar(subject.id, cls);
      return;
    }

    switch (e.detail.id) {
      case 'delete':
        await this._deleteSubject(subject);
        return;
      case 'name':
        if (subject.kind === 'sensor') await this._openSensorName(subject.id);
        return;
    }
  }

  /**
   * Whether the point at `index` is still the one a gesture was aimed at.
   *
   * A dialog and a menu both outlive the click that opened them, and an undo
   * landing in between can remove that point, or remove another one and slide
   * this index onto a different point. Points carry no `id`, so the pixel is
   * what identifies one: a target that moved is dropped rather than edited or
   * deleted from underneath the user.
   */
  private _pointIsStillAt(index: number, px: Point): boolean {
    const point = this.archive?.getManifest().layout.calibration.points[index];
    return point !== undefined && samePoint(point.px, px);
  }

  /**
   * Deletes the menu's subject, as one entry scoped to the subtree it touches.
   *
   * Undo restores the object with everything it carried, because an entry is a
   * snapshot rather than an inverse command — there is no per-object restore to
   * author here, and therefore none to author wrongly.
   */
  private async _deleteSubject(subject: MenuSubject) {
    switch (subject.kind) {
      case 'calibration': {
        const { index } = subject;
        if (!this._pointIsStillAt(index, subject.px)) return;

        await this._record('delete calibration point', { kind: 'layout' }, () => {
          const points = [...this.archive!.getManifest().layout.calibration.points];
          points.splice(index, 1);
          this._writeLayout({ calibrationPoints: points });
        });
        return;
      }
      case 'sensor': {
        // Keyed by `id`, so there is nothing to go stale: the subject names one
        // sensor however the list is reordered or replaced underneath. It can
        // still be *gone*, which is why the filter is a filter and not a splice.
        const { id } = subject;
        if (!this._sensor(id)) return;

        await this._record('delete sensor', { kind: 'layout' }, () => {
          this._writeLayout({
            sensors: this.archive!.getManifest().layout.sensors.filter(s => s.id !== id),
          });
        });
        return;
      }
      case 'car':
        // Keyed by `id` for the same reason, and scoped to the image rather
        // than to `layout`, because cars are per image.
        await this._deleteCar(subject.id);
        return;
    }
  }

  /**
   * Deletes one car, as one entry scoped to the image it is on.
   *
   * Keyed by label `id`, like a sensor: the id names one car however the array
   * is replaced underneath, and the same id is what undo restores it under. A
   * car that is already gone — an undo landed while the menu was up — is
   * dropped rather than deleted from underneath the user, which is the
   * staleness guard `_pointIsStillAt` gives a point that has no id.
   *
   * Deleting one car of a train leaves **no residue**: a train is derived from
   * coincident endpoints, so nothing else names the car that went, and the
   * cars either side of it simply stop being coupled to it. Taking the middle
   * car of three leaves two.
   *
   * It also **clears `labeled_complete`** (`SPEC.md` § Labeling completeness).
   * A delete removes coverage, and nothing here can tell a label deleted
   * because it covered background from one deleted off a car still in the
   * photograph — so the claim goes back to the human who made it. That is not
   * the rule against setting the flag being bent: setting is the claim only a
   * human may make, clearing withdraws it and asks again. Both go in **one**
   * entry, because the flag lives in the same per-image snapshot this delete
   * already targets, so one undo restores the car and the assertion together.
   */
  private async _deleteCar(id: string) {
    const image = this._currentImage();
    if (!image || !image.labels.some(car => car.id === id)) return;

    await this._record('delete car', { kind: 'image', filename: image.filename }, () => {
      this._writeImage(image.filename, {
        labels: image.labels.filter(car => car.id !== id),
        labeledComplete: false,
      });
    });
  }

  /**
   * Writes one car's class, as one entry scoped to the image it is on.
   *
   * The **full dotted class**, root included: a label maps to the longest entry
   * of `detector.classes` that is a segment-prefix of its class, so an unrooted
   * one matches nothing and is dropped from the training export — the
   * unlabeled-car-as-background failure the completeness rule exists to
   * prevent. The rows carry what is stored precisely so this method never
   * assembles a class out of what the user read.
   *
   * Keyed by label `id` like every other menu verb, so a car that went while
   * the menu was up is dropped rather than reclassified from underneath the
   * user. Choosing the class a car already has records nothing: `EditHistory`
   * suppresses a no-op by value.
   */
  private async _reclassifyCar(id: string, cls: string) {
    const image = this._currentImage();
    if (!image || !image.labels.some(car => car.id === id)) return;

    await this._record('reclassify car', { kind: 'image', filename: image.filename }, () => {
      this._writeImage(image.filename, {
        labels: image.labels.map(car => (car.id === id ? { ...car, class: cls } : car)),
      });
    });
  }

  /**
   * Closes a gesture: one entry for everything it moved, or none at all.
   *
   * Every ending goes through here, including the two that are not the
   * gesture's own — a repeated `pointerId`, which says the previous up never
   * arrived, and teardown, since `rr-app` replaces this element on the view
   * toggle and an entry left open would refuse every undo for the rest of the
   * session. Both **commit** rather than revert: the objects visibly moved and
   * the user has an undo for that, where a silent revert would be the editor
   * deciding it knew better.
   */
  private async _endGesture(gesture: LiveGesture) {
    if (this._gesture === gesture) this._gesture = null;
    if (await gesture.entry?.commit()) this._notifyHistoryChange();
  }

  connectedCallback() {
    super.connectedCallback();
    // On the window, like `rr-app`'s undo shortcut: the viewer takes no focus,
    // so a keystroke aimed at the labeling surface arrives on the body.
    window.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    if (this._gesture) void this._endGesture(this._gesture);
    // A timer outliving the element would write state into a detached one.
    this._clearHighlight();
  }

  /** The live gesture, if this event belongs to it. */
  private _current(e: CustomEvent<ViewerPointerDetail>): LiveGesture | null {
    const gesture = this._gesture;
    if (!gesture || gesture.pointerId !== e.detail.originalEvent.pointerId) return null;
    return gesture;
  }

  /** A screen-pixel tolerance in the zoom the viewer just reported. */
  private _tolerance(
    screenPx: number,
    detail: ViewerPointerDetail | ViewerContextMenuDetail
  ): HitTolerance {
    return { screenPx, imagePxPerScreenPx: detail.imagePxPerScreenPx };
  }

  /**
   * Writes every handle of the gesture to where `to` puts it.
   *
   * The delta is measured from the press and applied to each handle's starting
   * position, so all of them take the identical translation: that is what keeps
   * a coupler's ends on the same pixel, and a coupling is exact coincidence.
   *
   * The two subtrees are written separately because that is where the objects
   * live: calibration points and sensors in `layout`, car labels in one image
   * record. A gesture only ever grabs one kind — the handles come from a single
   * hit — so the entry opened at pointer-down names the right one, and **only
   * the subtree the handles are in is written**. Writing the other as well
   * would be value-identical today and still wrong: the open entry snapshots
   * one subtree, and touching the other is a write outside what it declared.
   */
  private _moveHandles(gesture: LiveGesture, to: Point) {
    if (!this.archive || gesture.handles.length === 0) return;
    const delta = { x: to.x - gesture.origin.x, y: to.y - gesture.origin.y };
    const layout = this.archive.getManifest().layout;
    const points = [...layout.calibration.points];
    const sensors = [...layout.sensors];
    const image = this._currentImage();
    const labels = image ? [...image.labels] : [];
    let movedLayout = false;
    let movedLabels = false;

    for (const handle of gesture.handles) {
      switch (handle.ref.kind) {
        case 'calibration': {
          const point = points[handle.ref.index];
          if (point) points[handle.ref.index] = { ...point, px: dragTo(handle, delta) };
          movedLayout = true;
          break;
        }
        case 'sensor': {
          const id = handle.ref.id;
          const index = sensors.findIndex(s => s.id === id);
          if (index >= 0) {
            const at = dragTo(handle, delta);
            sensors[index] = { ...sensors[index], x: at.x, y: at.y };
          }
          movedLayout = true;
          break;
        }
        case 'car-end': {
          const { id, end } = handle.ref;
          const index = labels.findIndex(label => label.id === id);
          if (index >= 0) {
            const at = dragTo(handle, delta);
            // Written per end rather than through a computed key, so the
            // discriminated union survives the rebuild: a car carries its
            // provenance and a spread that widened it would stop typechecking
            // where it matters.
            labels[index] =
              end === 'p0' ? { ...labels[index], p0: at } : { ...labels[index], p1: at };
          }
          movedLabels = true;
          break;
        }
      }
    }

    if (movedLayout) this._writeLayout({ calibrationPoints: points, sensors });
    if (movedLabels && image) this._writeImage(image.filename, { labels });
  }

  /**
   * Replaces the parts of `layout` a gesture touched, and re-renders.
   *
   * The arrays and the objects in them are rebuilt rather than mutated in
   * place, because a history snapshot is taken by value and the editor must not
   * hold a reference to an object undo will replace. Lit does not observe
   * mutations inside `R49Archive`, hence the explicit `requestUpdate()` — which
   * is what carries a mid-drag position into the DPT readout.
   *
   * An omitted key is left alone, so a caller states exactly what it changed
   * and a sensor write cannot silently rewrite the calibration beside it.
   */
  private _writeLayout(changes: {
    calibrationPoints?: readonly CalibrationPoint[];
    sensors?: readonly Sensor[];
  }) {
    const manifest = this.archive!.getManifest();
    manifest.layout = {
      ...manifest.layout,
      ...(changes.calibrationPoints
        ? {
            calibration: {
              ...manifest.layout.calibration,
              points: [...changes.calibrationPoints],
            },
          }
        : {}),
      ...(changes.sensors ? { sensors: [...changes.sensors] } : {}),
    };
    this.requestUpdate();
  }

  /**
   * Replaces the parts of one image record a gesture touched, and re-renders.
   *
   * The per-image mirror of {@link _writeLayout}, and rebuilt by value for the
   * same reason: a history snapshot is taken by value, so the editor must hold
   * no reference to an object undo will replace. Addressed by **filename**, not
   * by index — an entry scoped to another image can reorder the array while a
   * dialog or a menu is open.
   */
  private _writeImage(
    filename: string,
    changes: { labels?: readonly CarLabel[]; labeledComplete?: boolean }
  ) {
    const manifest = this.archive!.getManifest();
    const index = manifest.images.findIndex(img => img.filename === filename);
    if (index < 0) return;

    manifest.images[index] = {
      ...manifest.images[index],
      ...(changes.labels ? { labels: [...changes.labels] } : {}),
      ...(changes.labeledComplete !== undefined
        ? { labeled_complete: changes.labeledComplete }
        : {}),
    };
    this.requestUpdate();
  }

  /**
   * Writes `labeled_complete` for the image on screen, as one entry.
   *
   * The **only** place this element sets the flag true, and it is reached from
   * one deliberate control and nothing else (`SPEC.md` § Labeling completeness).
   * The flag means a human asserts that no car in this image is unlabeled — an
   * assertion about *absence*, which is why nothing computed can stand in for
   * it and why no other handler here may write `true` into it however much it
   * knows about the labels.
   *
   * Marking an image with **zero** cars complete is a legitimate all-background
   * sample, so there is nothing to warn about and no branch on the label count.
   *
   * Toggled off, it is its own entry rather than an undo of the one that set
   * it: withdrawing the claim is an edit the user made, and it must be on the
   * stack where they can reverse it.
   */
  private async _onCompleteToggle(e: Event) {
    const image = this._currentImage();
    if (!image) return;
    const complete = (e.target as SlCheckbox).checked;

    await this._record(
      complete ? 'mark labeled complete' : 'mark labeling incomplete',
      { kind: 'image', filename: image.filename },
      () => this._writeImage(image.filename, { labeledComplete: complete })
    );
  }

  /** The coordinate came back: write the point as one `layout` entry. */
  private async _onCalibrationCommit(e: CustomEvent<CalibrationCommitDetail>) {
    const pending = this._pendingCalibration;
    this._pendingCalibration = null;
    if (!pending || !this.archive) return;

    const manifest = this.archive.getManifest();
    // The dialog can have outlived the point it was opened on — see
    // {@link _pointIsStillAt}.
    if (pending.kind === 'edit' && !this._pointIsStillAt(pending.index, pending.px)) return;

    const label = pending.kind === 'place' ? 'place calibration point' : 'edit calibration point';
    await this._record(label, { kind: 'layout' }, () => {
      const points = [...manifest.layout.calibration.points];
      if (pending.kind === 'place') {
        points.push({ px: pending.px, world: e.detail.world });
      } else {
        points[pending.index] = { ...points[pending.index], world: e.detail.world };
      }
      this._writeLayout({ calibrationPoints: points });
    });
  }

  /**
   * The name came back: write it as one `layout` entry, or drop it.
   *
   * `null` **removes** the key rather than storing an empty string — `name` is
   * absent when unset, and a stored `""` would be a name that displays as
   * nothing while still counting as one. Retyping the same name records
   * nothing: `EditHistory.record` suppresses a no-op by value.
   *
   * The sensor is looked up by `id` when the dialog closes, so a sensor deleted
   * or undone while it was open is simply gone and the commit does nothing —
   * exactly the staleness guard `_pointIsStillAt` provides for a point, but
   * exact, because a sensor has an id and a point does not.
   */
  private async _onSensorNameCommit(e: CustomEvent<SensorNameCommitDetail>) {
    const pending = this._pendingSensorName;
    this._pendingSensorName = null;
    if (!pending || !this.archive || !this._sensor(pending.id)) return;

    const { name } = e.detail;
    const manifest = this.archive.getManifest();
    await this._record('name sensor', { kind: 'layout' }, () => {
      this._writeLayout({
        sensors: manifest.layout.sensors.map(sensor => {
          if (sensor.id !== pending.id) return sensor;
          const renamed: Sensor = { id: sensor.id, x: sensor.x, y: sensor.y };
          return name === null ? renamed : { ...renamed, name };
        }),
      });
    });
  }

  /**
   * DPT readout, plus what makes it trustworthy.
   *
   * `null` means no calibration pair resolves a scale — a real v4 state, not an
   * error, so it is reported with what to do about it. The residual appears
   * only once the fit is over-determined, where it says something: a mis-typed
   * coordinate is otherwise absorbed silently into the scale. A DPT below
   * `MIN_DPT` **warns and blocks nothing** — the six fixture archives sit at
   * 18–19 and must stay openable and editable (`SPEC.md` § Reference points).
   */
  private _renderDpt(manifest: ManifestData) {
    const dpt = getDPT(manifest);
    if (dpt === null) {
      return html`<div class="dpt-bar uncalibrated">
        Not calibrated — click the image to place calibration points. Two points at
        different positions resolve DPT.
      </div>`;
    }

    const residual = getDPTResidual(manifest);
    const belowMinimum = dpt < MIN_DPT;

    return html`<div class="dpt-bar ${belowMinimum ? 'below-minimum' : ''}">
      DPT ${dpt.toFixed(1)}
      ${residual !== null
        ? html`<span class="detail">fit residual ${residual.toFixed(1)} px</span>`
        : ''}
      ${belowMinimum
        ? html`<span class="detail">
            below the minimum of ${MIN_DPT} — cars are too few pixels across for reliable
            detection. Editing is not blocked.
          </span>`
        : ''}
    </div>`;
  }

  /**
   * The frame-mismatch warning, or nothing when there is none.
   *
   * It names both sizes rather than saying "mismatch", because the two numbers
   * are what tells the user which half is wrong: a re-cropped photo and a
   * mis-typed `camera.resolution` read identically otherwise. It states the
   * consequence too — the labels on this image are drawn through a stretch, so
   * they are approximate and a car's rectangle is not square to the track.
   */
  private _renderFrameMismatch() {
    const m = this._frameMismatch;
    if (!m) return '';
    return html`<div class="frame-warning">
      Image is ${m.media.width}×${m.media.height}, archive declares
      ${m.frame.width}×${m.frame.height}
      <span class="detail">
        different shapes, so labels are drawn stretched onto this image and are
        approximate. Re-capture it at the declared resolution, or correct the archive's.
      </span>
    </div>`;
  }

  /**
   * The camera-drift row for the image on screen.
   *
   * **Shown for every image, not only the ones that fail** (#118). The reference
   * is `images[0]` and the user can move it by dragging the strip, so the only
   * thing that keeps that choice honest is seeing what it decided about each
   * image: a bar that appeared only past the tolerance would let a reorder change
   * the pose with nothing on screen moving. Position 0 says so in as many words
   * rather than reading 0.0 px — "zero because it is the reference" and "measured
   * and found steady" are different claims, and only the first is true there.
   *
   * Persistent: it is a property of the image, not of the moment it was added, so
   * it survives looking at another image and coming back — a toast would be gone
   * by the time the user started labeling, which is when it matters.
   *
   * It names the displacement in pixels **and** track widths, for the same reason
   * the frame-mismatch bar names both sizes: "drifted" alone cannot tell a knocked
   * tripod from a camera moved to photograph a different corner of the layout, and
   * those call for different decisions.
   *
   * **What it says about the consequence is narrower than it first was, and the
   * narrower version is the true one.** Labeling this image is fine: a car span is
   * authored on this image's own pixels, so it is self-consistent whatever the
   * camera did, and nothing about the shift reaches the training data derived from
   * it. What the copy warns about is the per-*layout* geometry — the sensors and
   * calibration drawn over this image were authored against the reference, so the
   * overlay is misplaced here. Telling a labeler their labels are poisoned when
   * they are not would train them to ignore the bar.
   */
  private _renderDriftWarning(image: Image, index: number) {
    const tolerancePx = maxDriftPx(getDPT(this.archive!.getManifest()));
    // No track width to take a fraction of, and the calibration gate already has
    // the labeler's attention. Nothing to say.
    if (tolerancePx === null) return '';

    if (index === 0) {
      return html`<div class="drift-warning reference">
        Reference image — zero drift by definition
        <span class="detail">
          every other image, and the live view's camera, is measured against this one.
          Drag another thumbnail to the front of the strip to make it the reference instead.
        </span>
      </div>`;
    }

    if (this._driftChecking === image.filename) {
      return html`<div class="drift-warning checking">
        Measuring this image against the reference for camera drift…
      </div>`;
    }

    const px = this._driftPx.get(image.filename);
    // Absent and not being measured: the check failed, or has not reached this
    // image yet. Silence beats a fabricated zero.
    if (px === undefined) return '';

    const tracks = px / getDPT(this.archive!.getManifest())!;
    const measurement = html`Camera moved ${px.toFixed(1)} px (${tracks.toFixed(2)} track widths)
      from the reference`;

    if (px <= tolerancePx) {
      return html`<div class="drift-warning steady">
        ${measurement}
        <span class="detail">within the ${tolerancePx.toFixed(1)} px this layout allows.</span>
      </div>`;
    }

    return html`<div class="drift-warning">
      ${measurement}
      <span class="detail">
        past the ${tolerancePx.toFixed(1)} px this layout allows.
        <strong>Labeling this image is unaffected</strong> — a car span is authored on its own
        pixels. What is off is the sensor and calibration overlay, which was authored against the
        reference image.
        Nothing is blocked: re-aim and re-capture, or keep it deliberately.
      </span>
    </div>`;
  }

  /**
   * The completeness control, for the image on screen.
   *
   * It sits **directly above the thumbnail bar**, which is where the same flag
   * is read for every other image: the control and the readout it changes are
   * adjacent, so what the checkbox does to the strip is visible in one glance
   * rather than inferred.
   *
   * The label states what is being asserted rather than naming the field.
   * `labeled_complete` is a claim about *absence* — no car in this image is
   * unlabeled — and a checkbox reading "complete" invites the reading "I am
   * done with this image", which is a different and much weaker claim. The
   * consequence is stated with it, because it is the one thing that makes the
   * assertion worth making carefully: only complete images are exported.
   */
  private _renderCompleteness(image: Image) {
    return html`<div class="complete-bar">
      <sl-checkbox
        ?checked=${image.labeled_complete}
        @sl-change=${this._onCompleteToggle}
      >
        Labeled complete
      </sl-checkbox>
      <span class="detail">
        No car in this image is unlabeled. Only complete images will be exported for training.
      </span>
    </div>`;
  }

  /**
   * An edit's phrase, qualified with the image when it is not the one on
   * screen — "delete car — img_3.jpg".
   *
   * The disabled state says the stack has a bottom; this says *where* the next
   * undo will land. Without it "nothing happened" and "it happened on an image
   * you are not looking at" read identically, which is the whole reason the
   * buttons are not a duplicate of Cmd+Z (`SPEC.md` § Undo and redo) — and on a
   * touch device, where the labeling actually happens, there is no Cmd+Z to be
   * a duplicate of.
   */
  private _qualifiedLabel(label: string | null, image: string | null): string | null {
    if (!label) return null;
    return image && image !== this._currentImage()?.filename ? `${label} — ${image}` : label;
  }

  /**
   * The rubber band, or null when no chain is live.
   *
   * Before the pointer has moved it is the anchor twice over, which draws the
   * anchor's handle and nothing else — the feedback that the first click of a
   * chain landed, where #32 had none.
   */
  private _pendingCar(): PendingCar | null {
    if (this._mode.kind !== 'placing-car') return null;
    return { anchor: this._mode.anchor, to: this._cursor ?? this._mode.anchor };
  }

  /**
   * Zoom to fit — present only while there is a zoom to leave, which is the
   * reporter's "show zoom bars as needed" applied to the one control there is.
   *
   * On the viewer rather than in the sidebar, and deliberately **not** a
   * toolbar or palette button: `COMPACT_MAX_HEIGHT_PX` is measured from the
   * current button counts with 19px to spare (`layout.ts`), so a sixth button
   * puts #42's reflow back in play. It is not a fourth `EditorTool` either —
   * zoom is not a mode, and the editor has none.
   */
  private _renderFitControl() {
    if (this._zoom === null) return '';
    // The tooltip names the accelerator; the button is the affordance. A phone
    // has no Escape, and the labeling is done on a phone.
    return html`<sl-tooltip content="Zoom to fit (Esc)" placement="left">
      <sl-icon-button
        class="fit-control"
        name="arrows-angle-contract"
        label="Zoom to fit"
        @click=${this._fitZoom}
      ></sl-icon-button>
    </sl-tooltip>`;
  }

  render() {
    const manifest = this.archive?.getManifest();
    const currentImage = manifest?.images[this._currentImageIndex];
    const src = currentImage ? this._imageUrls.get(currentImage.filename) : null;

    return html`
      <div class="sidebar">
        <rr-toolbar
          .canUndo=${this.canUndo}
          .canRedo=${this.canRedo}
          .undoLabel=${this._qualifiedLabel(this.undoLabel, this.undoImage)}
          .redoLabel=${this._qualifiedLabel(this.redoLabel, this.redoImage)}
        ></rr-toolbar>

        ${manifest
          ? html`<rr-tool-palette
              .tool=${this._tool}
              ?calibrated=${this._calibrated()}
              @rr-tool-select=${this._onToolSelect}
            ></rr-tool-palette>`
          : ''}
      </div>

      <div class="main-content">
        ${!this.archive || !manifest
          ? html`<div class="placeholder">No archive loaded. Use the toolbar to open an .r49 file.</div>`
          : html`
            ${this._renderDpt(manifest)}

            ${this._renderFrameMismatch()}

            ${currentImage ? this._renderDriftWarning(currentImage, this._currentImageIndex) : ''}

            <div class="viewer-wrap">
              <rr-viewer
                .src=${src}
                .resolution=${manifest.camera.resolution}
                .calibrationPoints=${manifest.layout.calibration.points}
                .sensors=${manifest.layout.sensors}
                .cars=${currentImage?.labels ?? []}
                .pendingCar=${this._pendingCar()}
                .highlight=${this._highlight && this._resolveHighlight(this._highlight)}
                .zoom=${this._zoom}
                .zoomPreview=${this._zoomPreview}
                .dpt=${getDPT(manifest)}
                @rr-pointer-down=${this._onViewerPointerDown}
                @rr-pointer-move=${this._onViewerPointerMove}
                @rr-pointer-up=${this._onViewerPointerUp}
                @rr-pointer-cancel=${this._onViewerPointerCancel}
                @rr-pointer-contextmenu=${this._onViewerContextMenu}
                @rr-media-frame=${this._onMediaFrame}
                @rr-viewport=${this._onViewport}
              ></rr-viewer>
              ${this._renderFitControl()}
            </div>

            ${currentImage ? this._renderCompleteness(currentImage) : ''}

            <rr-thumbnail-bar
              .images=${manifest.images.map(img => this._imageUrls.get(img.filename) || '')}
              .complete=${manifest.images.map(img => img.labeled_complete)}
              .selectedIndex=${this._currentImageIndex}
              @rr-image-select=${this._onImageSelect}
              @rr-image-add=${this._onImageAdd}
              @rr-image-delete=${this._onImageDelete}
              @rr-image-reorder=${this._onImageReorder}
            ></rr-thumbnail-bar>

            <rr-calibration-dialog
              @rr-calibration-commit=${this._onCalibrationCommit}
            ></rr-calibration-dialog>

            <rr-sensor-dialog
              @rr-sensor-name-commit=${this._onSensorNameCommit}
            ></rr-sensor-dialog>

            <rr-context-menu
              @rr-context-menu-select=${this._onContextMenuSelect}
            ></rr-context-menu>
          `
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-editor-view': RREditorView;
  }
}
