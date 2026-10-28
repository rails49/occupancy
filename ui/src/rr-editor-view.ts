import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { calibrationFit, getDPT, make_id } from '@rails49/r49';
import type { Image, ManifestData, Point } from '@rails49/r49';
import { MIN_DPT } from '@rails49/detector';
import { captureFromCamera } from './capture.js';
import type { ClickResult, Drag, EditSession, MenuSubject, Reveal } from './editSession.js';
import {
  boundsOfPoints,
  isClick,
  panZoomRect,
  rectBetween,
  revealZoom,
  samePoint,
  zoomRectFromDrag,
  CLICK_SLOP_SCREEN_PX,
} from './geometry.js';
import type { FrameSize, Rect, Size } from './geometry.js';
import type { PendingCar } from './carMarker.js';
import { classChoices, rootClass } from './vocabulary.js';
import type { ClassChoice } from './vocabulary.js';
import { lookTheme, TURN_HEIGHT_PX } from '@rails49/look';
import type { HistoryHighlight } from './history.js';
import { HIGHLIGHT_DURATION_MS } from './highlight.js';
import { imageSize } from './imageSize.js';
import { makeThumbnail } from './thumbnail.js';
import type {
  ViewerContextMenuDetail,
  ViewerHighlight,
  ViewerMediaFrameDetail,
  ViewerPointerDetail,
  ViewerViewportDetail,
} from './rr-viewer.js';
import type { CalibrationCommitDetail, RRCalibrationDialog } from './rr-calibration-dialog.js';
import type { SensorNameCommitDetail, RRSensorDialog } from './rr-sensor-dialog.js';
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
import './rr-thumbnail-bar.js';
import './rr-calibration-dialog.js';
import './rr-sensor-dialog.js';
import './rr-context-menu.js';

/** A dialog open on a reference point: a new one, or an existing one. */
type PendingCalibration = Extract<
  ClickResult,
  { kind: 'place-reference-point' } | { kind: 'edit-reference-point' }
>;

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
 * Generated from the vocabulary in `@rails49/r49`'s data file (`vocabulary.ts`), so
 * a release adding a subtype there changes this menu at the version bump with **no code
 * edit** — and the root is not among them, because it is required in the
 * stored class and absent from the UI (rails49/detector's `SPEC.md` § Parameters
 * live in `config.yaml`).
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

/** The rows a menu offers for its subject. */
function itemsFor(subject: MenuSubject): readonly ContextMenuItem[] {
  switch (subject.kind) {
    case 'calibration':
      return CALIBRATION_ITEMS;
    case 'sensor':
      return SENSOR_ITEMS;
    case 'car':
      return carItems();
  }
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
 * Decided once the pointer leaves the click slop, off where it was pressed:
 * whether an object is there, and whether the editor is zoomed.
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
 * The pointer gesture in flight: one press, its moves, and its end.
 *
 * Whether it is a click, a view gesture or a drag of an object is decided once
 * the pointer leaves the click slop, from the press position.
 */
interface LiveGesture {
  /** Only this pointer drives the gesture; a second finger is ignored. */
  readonly pointerId: number;
  /** Where the press landed, in image pixels. Every delta is measured from here. */
  readonly origin: Point;
  /**
   * Where the press landed on the glass, in client pixels. Only a pan reads
   * it: panning moves the transform image coordinates are reported through.
   */
  readonly originClient: Point;
  /** Image pixels per screen pixel at the press. */
  readonly scale: number;
  /** Shift held at the press: a zoom rect wherever the drag begins. */
  readonly shiftKey: boolean;
  /** The zoom rect the press started on — what a pan's travel is applied to. */
  readonly zoomAt: Rect | null;
  /** What this drag does to the view, or null while it is a click or an object drag. */
  view: ViewGesture | null;
  /** The object drag, once the gesture is one. */
  drag: Drag | null;
  /**
   * Set once the pointer leaves the click slop, and sticky: a drag walked back
   * to where it started is still a drag, not a click.
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

/** Adds an image with its decoded size, which a new archive takes (#254). */
async function addMeasured(session: EditSession, filename: string, bytes: Uint8Array) {
  await session.addImage(filename, bytes, await imageSize(bytes));
}

/** An image's blob URLs: full size for the viewer, a small copy for the strip. */
interface ImageUrls {
  full: string;
  thumbnail: string | null;
}

/** Revokes both of an image's URLs, and marks them revoked by emptying `full`. */
function revokeImageUrls(urls: ImageUrls) {
  URL.revokeObjectURL(urls.full);
  if (urls.thumbnail) URL.revokeObjectURL(urls.thumbnail);
  urls.full = '';
  urls.thumbnail = null;
}

/**
 * Main editor view: shows an archive's images and what is authored on them,
 * and turns pointer, dialog and menu events into calls on an `EditSession`.
 *
 * The session holds the editing rules and the state they depend on: the tool,
 * the chain, drags, and the image on screen. This element holds what is only
 * for display — dialogs and menus and what they are open on, zoom and pan, the
 * highlight after an undo, and blob URLs — and re-renders
 * whenever the session changes. See ADR 0017.
 *
 * Takes `session`. Emits `rr-notify` (`NotifyDetail`) when a click is refused.
 *
 * It owns the zoom (#44): a drag on empty image draws a rect to zoom to, or
 * pans once zoomed, and a Shift-drag draws a rect wherever it begins. Zoom
 * writes nothing, survives an image change and a live chain, and a reveal pans
 * to keep what an undo changed on screen.
 *
 * DPT is reported live, with the fit residual once the fit is over-determined,
 * and a DPT below the detector's `MIN_DPT` warns and blocks nothing. See `SPEC.md`
 * § Reference points.
 */
@customElement('rr-editor-view')
export class RREditorView extends LitElement {
  /** The archive being edited, with its rules and history. Created by `rr-app`. */
  @property({ attribute: false }) session: EditSession | null = null;
  /**
   * Blob URLs for each image, by filename: the full-size image for the viewer,
   * and a small copy for the thumbnail strip (#252), `null` until it is made.
   */
  @state() private _imageUrls: Map<string, ImageUrls> = new Map();
  /**
   * The loaded image's size against the archive's, when the two are different
   * **shapes**, and `null` whenever they agree.
   *
   * `camera.resolution` is one value for the whole archive while the images are
   * per image (`SPEC.md` § Output encoding), so nothing binds an image's own
   * dimensions to the frame its labels are authored in. The viewer draws the
   * frame stretched over the photograph either way (#41), and the stretch is
   * stated here, above the image it is about.
   */
  @state() private _frameMismatch: ViewerMediaFrameDetail | null = null;
  /** Stops listening to the session. */
  private _unsubscribe: (() => void) | null = null;
  /** The reference point a dialog is open on, or null when none is. */
  private _pendingCalibration: PendingCalibration | null = null;
  /** The sensor whose name dialog is open, by `id`, or null when none is. */
  private _pendingSensorName: { readonly id: string } | null = null;
  /** The press in flight, or null between gestures. At most one at a time. */
  private _gesture: LiveGesture | null = null;
  /** What the context menu is open on, or null when it is closed. */
  private _menuSubject: MenuSubject | null = null;
  /**
   * Where the pointer last was, in whole image pixels, while a chain is live:
   * the rubber band's far end.
   */
  @state() private _cursor: Point | null = null;
  /**
   * The objects a reveal is pointing at, or `null` when none is. Held as ids
   * and pixels and resolved on every render, so a later edit cannot leave the
   * glow on the wrong object.
   */
  @state() private _highlight: readonly HistoryHighlight[] | null = null;
  /** Clears {@link _highlight}. Restarted by each reveal, cancelled on teardown. */
  private _highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The region of the authored frame on screen, or `null` for all of it (#44).
   * View state: it never enters the history, it survives image changes, and
   * it is dropped for a new archive.
   */
  @state() private _zoom: Rect | null = null;
  /** The rect being dragged out, or null when none is. */
  @state() private _zoomPreview: Rect | null = null;
  /**
   * The viewer's viewport in screen pixels, as it last reported it, for the
   * cap on how far a rect may zoom in. Zeros until the viewer has laid out.
   */
  private _viewport: Size = { width: 0, height: 0 };

  @query('rr-calibration-dialog') private _calibrationDialog!: RRCalibrationDialog;
  @query('rr-sensor-dialog') private _sensorDialog!: RRSensorDialog;
  @query('rr-context-menu') private _contextMenu!: RRContextMenu;

  static styles = [
    lookTheme,
    css`
    :host {
      display: flex;
      flex-grow: 1;
      height: 100%;
      overflow: hidden;
    }

    .main-content {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      background: var(--sl-color-neutral-0);
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
       the one control there is. It sits on the glass; see _renderFitControl. */
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
    .frame-warning {
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
       asked to do, and editing is not blocked. */
    .dpt-bar.uncalibrated,
    .dpt-bar.below-minimum,
    .frame-warning {
      background: var(--sl-color-warning-100);
      color: var(--sl-color-warning-800);
    }

    .dpt-bar .detail,
    .frame-warning .detail {
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

    /* At look's turn height the rail lies down as a strip along the top of
     * the work pane (#42). The readout bars give back their vertical padding
     * at the same time: they wrap to two lines at this width and were the
     * other thing taking height from the viewer. */
    @media (max-height: ${TURN_HEIGHT_PX}px) {
      .dpt-bar,
      .frame-warning,
      .complete-bar {
        padding: 0.3rem 1rem;
      }
    }
  `,
  ];

  protected willUpdate(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('session')) {
      this._listen();
      this._clearHighlight();
      this._frameMismatch = null;
      this._cursor = null;
      this._imageUrls.forEach(revokeImageUrls);
      this._imageUrls = new Map();
      // Zoom rects mean nothing on the next archive.
      this._fitZoom();
    }
    if (!this.session?.anchor) this._cursor = null;
  }

  updated() {
    void this._syncImageUrls();
  }

  connectedCallback() {
    super.connectedCallback();
    // On the window, like `rr-app`'s undo shortcut: the viewer takes no focus,
    // so a keystroke aimed at the labeling surface arrives on the body.
    window.addEventListener('keydown', this._onKeyDown);
    if (this.hasUpdated) this._listen();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKeyDown);
    this._unsubscribe?.();
    this._unsubscribe = null;
    // An open drag would hold undo shut until the archive is replaced.
    if (this._gesture) void this._endGesture(this._gesture);
    // A timer outliving the element would write state into a detached one.
    this._clearHighlight();
  }

  /** Listens to the current session, and to no other. */
  private _listen() {
    this._unsubscribe?.();
    this._unsubscribe = this.session?.subscribe(this._onSessionChange) ?? null;
  }

  /** Any change re-renders. After an undo or redo, the changed objects are shown. */
  private readonly _onSessionChange = (reveal: Reveal | null) => {
    if (reveal) this._showHighlight(reveal.highlights);
    this.requestUpdate();
  };

  /** The archive's images, or none without a session. */
  private _images(): readonly Image[] {
    return this.session?.archive.getManifest().images ?? [];
  }

  /**
   * Makes a blob URL and a thumbnail URL for each image that has none, and
   * revokes those of images that are gone. Filenames are never reused, so a URL
   * stays valid for as long as its image is in the list. Every full-size URL is
   * made before any thumbnail, so the image on screen does not wait for the
   * strip. An image that does not decode uses its full-size URL in the strip.
   */
  private async _syncImageUrls() {
    const session = this.session;
    if (!session) return;
    const filenames = new Set(this._images().map(image => image.filename));
    let changed = false;
    for (const [filename, urls] of this._imageUrls) {
      if (filenames.has(filename)) continue;
      revokeImageUrls(urls);
      this._imageUrls.delete(filename);
      changed = true;
    }
    const made = new Map<ImageUrls, Blob>();
    for (const filename of filenames) {
      if (this._imageUrls.has(filename)) continue;
      const data = await session.archive.getImage(filename);
      if (this.session !== session || this._imageUrls.has(filename) || !data) continue;
      const blob = new Blob([data as BlobPart], { type: 'image/jpeg' });
      const urls: ImageUrls = { full: URL.createObjectURL(blob), thumbnail: null };
      this._imageUrls.set(filename, urls);
      made.set(urls, blob);
      changed = true;
    }
    if (changed) this.requestUpdate();
    for (const [urls, blob] of made) {
      const thumbnail = await makeThumbnail(blob).catch(() => blob);
      // Revoked while the thumbnail was made: the image went, or the session did.
      if (urls.full === '') continue;
      urls.thumbnail = URL.createObjectURL(thumbnail);
      this.requestUpdate();
    }
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
    const points = this.session?.archive.getManifest().layout.calibration.points ?? [];

    for (const highlight of highlights) {
      switch (highlight.kind) {
        case 'car':
          if (this.session?.car(highlight.id)) cars.push(highlight.id);
          break;
        case 'sensor':
          if (this.session?.sensor(highlight.id)) sensors.push(highlight.id);
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
    const calibrationPoints = this.session?.archive.getManifest().layout.calibration.points ?? [];

    for (const highlight of highlights) {
      switch (highlight.kind) {
        case 'car': {
          const car = this.session?.car(highlight.id);
          if (car) points.push(car.p0, car.p1);
          break;
        }
        case 'sensor': {
          const sensor = this.session?.sensor(highlight.id);
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
   * One method, because a leaked timer would clear a later reveal's highlight
   * early.
   */
  private _clearHighlight() {
    if (this._highlightTimer !== null) clearTimeout(this._highlightTimer);
    this._highlightTimer = null;
    this._highlight = null;
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

  /** A thumbnail was chosen. The glow and the frame warning belong to the image being left. */
  private _onImageSelect(e: CustomEvent) {
    const image = this._images()[e.detail.index];
    if (!image) return;
    this.session?.selectImage(image.filename);
    this._clearHighlight();
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
   * The band goes with it: a band belongs to a gesture, and none is in flight
   * by the time anything here runs.
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
    const session = this.session;
    if (!session) return;
    const { source } = e.detail;

    if (source === 'file') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png';
      input.onchange = async (event: Event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) await addMeasured(session, `img_${make_id(2)}.jpg`, new Uint8Array(await file.arrayBuffer()));
      };
      input.click();
    } else if (source === 'camera') {
      try {
        await addMeasured(session, `capture_${make_id(3)}.jpg`, await captureFromCamera());
      } catch (err) {
        console.error('Failed to capture from camera', err);
      }
    }
  }

  private async _onImageDelete(e: CustomEvent) {
    const image = this._images()[e.detail.index];
    if (image) await this.session?.deleteImage(image.filename);
  }

  private async _onImageReorder(e: CustomEvent) {
    await this.session?.reorderImages(e.detail.from, e.detail.to);
  }

  /**
   * A press. Only the primary button authors. A press on the same `pointerId`
   * as a live gesture means that gesture's end never arrived, so it is closed;
   * a different `pointerId` is a second finger, and is ignored.
   */
  private _onViewerPointerDown(e: CustomEvent<ViewerPointerDetail>) {
    const event = e.detail.originalEvent;
    if (!isPrimaryButton(event)) return;

    if (this._gesture) {
      if (this._gesture.pointerId !== event.pointerId) return;
      void this._endGesture(this._gesture);
    }
    if (!this.session) return;

    this._gesture = {
      pointerId: event.pointerId,
      origin: e.detail.point,
      originClient: { x: event.clientX, y: event.clientY },
      scale: e.detail.imagePxPerScreenPx,
      shiftKey: event.shiftKey,
      zoomAt: this._zoom,
      view: null,
      drag: null,
      dragging: false,
    };
  }

  /** The authored frame — `camera.resolution` — or undefined with no session. */
  private _frame(): FrameSize | undefined {
    return this.session?.archive.getManifest().camera.resolution;
  }

  /**
   * Motion. It moves the rubber band while a chain is live, and becomes a drag
   * once it leaves the click slop.
   */
  private _onViewerPointerMove(e: CustomEvent<ViewerPointerDetail>) {
    if (this.session?.anchor) {
      this._cursor = { x: Math.round(e.detail.point.x), y: Math.round(e.detail.point.y) };
    }

    const gesture = this._current(e);
    if (!gesture) return;

    if (!gesture.dragging) {
      if (isClick(gesture.origin, e.detail.point, this._slop(gesture))) return;
      gesture.dragging = true;
      this._beginDrag(gesture);
    }
    this._applyDrag(gesture, e.detail);
  }

  /**
   * Decides what a drag is, from where it was pressed: Shift always draws a
   * zoom rect; otherwise an object under the press moves, and empty image
   * draws a zoom rect while fit and pans while zoomed.
   */
  private _beginDrag(gesture: LiveGesture) {
    if (!gesture.shiftKey) {
      gesture.drag = this.session?.beginDrag(gesture.origin, gesture.scale) ?? null;
      if (gesture.drag) return;
    }
    gesture.view = gesture.shiftKey || gesture.zoomAt === null ? 'zoom-rect' : 'pan';
  }

  /** One motion of a drag, dispatched on what it was decided to be. */
  private _applyDrag(gesture: LiveGesture, detail: ViewerPointerDetail) {
    switch (gesture.view) {
      case 'zoom-rect':
        // The band follows the pointer exactly; the cap and the clamp apply when it lands.
        this._zoomPreview = rectBetween(gesture.origin, detail.point);
        return;
      case 'pan':
        this._panTo(gesture, detail);
        return;
      case null:
        gesture.drag?.move(detail.point);
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
   * The end of a press: the end of a drag, or a click. A gesture that dragged
   * never falls through to the click path, even if it ended back inside the
   * slop.
   */
  private async _onViewerPointerUp(e: CustomEvent<ViewerPointerDetail>) {
    // One `pointerId` covers every mouse button, so a secondary release can
    // carry the id of a left drag still in progress.
    if (!isPrimaryButton(e.detail.originalEvent)) return;

    const gesture = this._current(e);
    if (!gesture) return;

    if (gesture.dragging) {
      if (gesture.view === 'zoom-rect') this._applyZoomRect(gesture, e.detail);
      else this._applyDrag(gesture, e.detail);
    }
    this._zoomPreview = null;
    await this._endGesture(gesture);
    if (gesture.dragging || !this.session) return;
    if (!isClick(gesture.origin, e.detail.point, this._slop(gesture))) return;

    const result = await this.session.click(gesture.origin, gesture.scale);
    const anchor = this.session.anchor;
    this._cursor = anchor && { ...anchor };
    await this._answer(result);
  }

  /** Does what a click asked for: a dialog, or a notice. */
  private async _answer(result: ClickResult) {
    switch (result.kind) {
      case 'none':
        return;
      case 'notice':
        this._notify(result.message);
        return;
      case 'place-reference-point':
        this._pendingCalibration = result;
        await this._calibrationDialog.show();
        return;
      case 'edit-reference-point':
        this._pendingCalibration = result;
        await this._calibrationDialog.show(result.world, { mode: 'edit' });
        return;
      case 'name-sensor':
        await this._openSensorName(result.id);
        return;
    }
  }

  /** Opens the name dialog on a sensor, if it is still there. */
  private async _openSensorName(id: string) {
    const sensor = this.session?.sensor(id);
    if (!sensor) return;
    this._pendingSensorName = { id };
    await this._sensorDialog.show(sensor.name ?? null, { id });
  }

  /**
   * The browser took the gesture away: what moved goes back, a pan returns to
   * the rect it started on, and nothing is written.
   */
  private async _onViewerPointerCancel(e: CustomEvent<ViewerPointerDetail>) {
    const gesture = this._current(e);
    if (!gesture) return;

    await gesture.drag?.cancel();
    if (gesture.view === 'pan') this._zoom = gesture.zoomAt;
    this._zoomPreview = null;
    await this._endGesture(gesture);
  }

  /**
   * Right-click. The browser's own menu is suppressed for every right-click
   * in the viewer. A live chain ends; otherwise a menu opens on whatever the
   * session finds under the pointer. Ignored while a press is in flight.
   */
  private async _onViewerContextMenu(e: CustomEvent<ViewerContextMenuDetail>) {
    e.detail.originalEvent.preventDefault();
    if (this._gesture || !this.session) return;

    const subject = this.session.rightClick(e.detail.point, e.detail.imagePxPerScreenPx);
    this._menuSubject = null;
    this._contextMenu.hide();
    if (!subject) return;

    this._menuSubject = subject;
    // The menu is placed on the glass, in the frame the right-click was reported in.
    await this._contextMenu.show(
      { x: e.detail.originalEvent.clientX, y: e.detail.originalEvent.clientY },
      itemsFor(subject)
    );
  }

  /** A row was chosen. The menu has closed itself by the time this runs. */
  private async _onContextMenuSelect(e: CustomEvent<ContextMenuSelectDetail>) {
    const subject = this._menuSubject;
    this._menuSubject = null;
    if (!subject || !this.session) return;

    // Only a car offers reclassify, so a row against any other subject is dropped.
    const cls = classOfReclassifyRow(e.detail.id);
    if (cls !== null) {
      if (subject.kind === 'car') await this.session.reclassifyCar(subject.id, cls);
      return;
    }

    switch (e.detail.id) {
      case 'delete':
        await this.session.delete(subject);
        return;
      case 'name':
        if (subject.kind === 'sensor') await this._openSensorName(subject.id);
        return;
    }
  }

  /** Closes a gesture, ending its drag: one entry for what moved, or none. */
  private async _endGesture(gesture: LiveGesture) {
    if (this._gesture === gesture) this._gesture = null;
    await gesture.drag?.end();
  }

  /** The live gesture, if this event belongs to it. */
  private _current(e: CustomEvent<ViewerPointerDetail>): LiveGesture | null {
    const gesture = this._gesture;
    if (!gesture || gesture.pointerId !== e.detail.originalEvent.pointerId) return null;
    return gesture;
  }

  /** The click slop at the scale the gesture was pressed at. */
  private _slop(gesture: LiveGesture) {
    return { screenPx: CLICK_SLOP_SCREEN_PX, imagePxPerScreenPx: gesture.scale };
  }

  /** The checkbox: the only control that writes `labeled_complete`. */
  private async _onCompleteToggle(e: Event) {
    await this.session?.setComplete((e.target as SlCheckbox).checked);
  }

  /** The world position came back: write the reference point. */
  private async _onCalibrationCommit(e: CustomEvent<CalibrationCommitDetail>) {
    const pending = this._pendingCalibration;
    this._pendingCalibration = null;
    if (!pending || !this.session) return;

    if (pending.kind === 'place-reference-point') {
      await this.session.placeReferencePoint(pending.px, e.detail.world);
    } else {
      await this.session.editReferencePoint(pending.index, pending.px, e.detail.world);
    }
  }

  /** The name came back: write it, or remove it for `null`. */
  private async _onSensorNameCommit(e: CustomEvent<SensorNameCommitDetail>) {
    const pending = this._pendingSensorName;
    this._pendingSensorName = null;
    if (!pending) return;
    await this.session?.nameSensor(pending.id, e.detail.name);
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
    const { dpt, residual } = calibrationFit(manifest);
    if (dpt === null) {
      return html`<div class="dpt-bar uncalibrated">
        Not calibrated — click the image to place calibration points. Two points at
        the same height and different positions resolve DPT.
      </div>`;
    }

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
   * The rubber band, or null when no chain is live. Before the pointer has
   * moved it is the anchor twice over, which draws the anchor's handle.
   */
  private _pendingCar(): PendingCar | null {
    const anchor = this.session?.anchor;
    return anchor ? { anchor, to: this._cursor ?? anchor } : null;
  }

  /** Zoom to fit, present only while zoomed. */
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
    const manifest = this.session?.archive.getManifest();
    const currentImage = this.session?.image;
    const src = currentImage ? this._imageUrls.get(currentImage.filename)?.full : null;

    return html`
      <div class="main-content">
        ${!this.session || !manifest
          ? html`<div class="placeholder">No archive loaded. Open an .r49 file from the rail.</div>`
          : html`
            ${this._renderDpt(manifest)}

            ${this._renderFrameMismatch()}

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
              .images=${manifest.images.map(img => this._imageUrls.get(img.filename)?.thumbnail || '')}
              .complete=${manifest.images.map(img => img.labeled_complete)}
              .selectedIndex=${this.session.imageIndex}
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
