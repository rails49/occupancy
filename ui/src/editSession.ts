import { getDPT, make_id } from '@rails49/r49';
import type {
  ReferencePoint,
  CarLabel,
  Image,
  Layout,
  Point,
  R49Archive,
  Sensor,
  WorldPoint,
} from '@rails49/r49';
import type { GrayPlane } from '@occupancy/drift';
import {
  carCovering,
  carUnderPointer,
  centerlineUnderPointer,
  dragHandles,
  dragTo,
  hitTest,
  inCarArea,
  samePoint,
  DEFAULT_GRAB_RADIUS_SCREEN_PX,
} from './geometry.js';
import type {
  Centerline,
  DragHandle,
  HitKind,
  HitScene,
  HitTarget,
  HitTolerance,
  Size,
} from './geometry.js';
import { snapToTrack, traceAlong } from './centerlineSnap.js';
import { EditHistory, revealTarget } from './history.js';
import type { HistoryEntry, HistoryGesture, HistoryHighlight, HistoryTarget } from './history.js';
import { COMPLETE_REASON, GATE_REASON, TOOLS } from './tools.js';
import type { EditorTool } from './tools.js';
import { rootClass } from './vocabulary.js';

/**
 * Node ids for the snowflakes this session mints. Image filenames use 2 here
 * and 3 for the editor's captures; sensor and label ids are separate
 * namespaces, so each gets its own node.
 */
const IMAGE_NODE_ID = 2;
const SENSOR_NODE_ID = 4;
const CAR_NODE_ID = 5;
const CENTERLINE_NODE_ID = 6;

/**
 * A generated image filename that keeps `name`'s extension (#256).
 *
 * The extension is kept because it is what says how the bytes decode — a PNG
 * renamed `.jpg` is a file every reader of the archive has to sniff. A name
 * with no extension at all takes `.jpg`, the one the editor's generated names
 * carried before picked names were kept.
 */
function generatedFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '.jpg';
  return `img_${make_id(IMAGE_NODE_ID)}${extension}`;
}

/** An image on its way into the archive, prepared by whoever picked it. */
export interface AddedImage {
  /** The name it asks to be stored under — see `EditSession.addImages`. */
  readonly filename: string;
  /** The bytes the archive holds, exactly as a reader will get them back. */
  readonly bytes: Uint8Array;
  /** The size those bytes measure, or undefined when they did not decode. */
  readonly size?: Size;
}

/** Why the car tool refused a click on a car's body or on one of its ends (#43). */
export const ALREADY_LABELED =
  'That pixel is already inside a labeled car — a car is labeled once.';

/**
 * Why the centerline tool refused a click on track under a car (#275).
 *
 * The rails there are not visible, so the snap would read the car's own
 * symmetry and put the point on the vehicle. It names the remedy, because there
 * is one and it is the whole reason centerlines belong to the archive rather
 * than to an image: another photograph has that track free.
 */
export const TRACK_UNDER_CAR =
  'A car is on that track here — trace this stretch on an image where it is free.';

/**
 * How close to an existing centerline's end a new run must start to extend it
 * rather than begin a line of its own, in gauges (#275).
 *
 * Half a gauge, the same reach {@link NO_TRACK_G} uses for "on this track": a
 * click that close is a click on the end, and starting a second line there
 * would leave two polylines nothing ever joins.
 */
export const EXTEND_G = 0.5;

/**
 * What a click needs from the editor before anything is written, or a notice
 * to show. A click that wrote, or did nothing, returns `none`.
 */
export type ClickResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'notice'; readonly message: string }
  /** Ask for the world position of a new reference point at `px`. */
  | { readonly kind: 'place-reference-point'; readonly px: Point }
  /** Ask for a new world position for the reference point at `index`. */
  | {
      readonly kind: 'edit-reference-point';
      readonly index: number;
      readonly px: Point;
      readonly world: WorldPoint;
    }
  /** Ask for a sensor's name. */
  | { readonly kind: 'name-sensor'; readonly id: string; readonly name: string | null };

/**
 * What a context menu acts on. A reference point has no id, so it carries the
 * pixel it was opened on, and an operation on it checks the point is still there.
 */
export type MenuSubject =
  | { readonly kind: 'car'; readonly id: string }
  | { readonly kind: 'sensor'; readonly id: string }
  | { readonly kind: 'calibration'; readonly index: number; readonly px: Point }
  /** One point of a centerline: offers the point and the whole line (#275). */
  | { readonly kind: 'centerline-point'; readonly id: string; readonly index: number }
  /** A whole centerline, right-clicked between its points. */
  | { readonly kind: 'centerline'; readonly id: string };

/**
 * The menu hit-tests the objects drawn over the cars first. Car ends are left
 * out, so a right-click on a coupling falls through to the car's body (#45).
 */
const MENU_HIT_KINDS: readonly HitKind[] = ['sensor', 'calibration', 'centerline-point'];

/** A drag in progress. One entry is written at `end`, or none. */
export interface Drag {
  /** Moves what was grabbed by the pointer's travel from where the drag began. */
  move(to: Point): void;
  /** Writes one history entry if anything moved. */
  end(): Promise<void>;
  /** Puts everything back and writes nothing. */
  cancel(): Promise<void>;
}

/** What an undo or redo changed, for the editor to highlight. */
export interface Reveal {
  readonly highlights: readonly HistoryHighlight[];
}

/** The layout fields the settings dialog edits, apart from the camera height. */
export type LayoutSettings = Partial<Pick<Layout, 'name' | 'scale' | 'description' | 'contact'>>;

/** Called after every change; with what changed after an undo or redo. */
export type SessionListener = (reveal: Reveal | null) => void;

/**
 * One click of a centerline run, with the stretch the fill laid up to it.
 *
 * Kept per click rather than as one flat list because undo during a run removes
 * **the last click**, which has to take its filled stretch with it: the points
 * between two clicks exist only because the closing click asked for them.
 */
interface RunStep {
  /**
   * The click, snapped — or exactly where the person clicked, where the snap
   * refused. An unsnapped click is kept on purpose, so a run can carry on past
   * a car or a gap (#275).
   */
  readonly click: Point;
  /** Snapped points the fill laid between the previous click and this one. */
  readonly filled: readonly Point[];
  /** Where the fill stopped short of this click, or `null` when it reached it. */
  readonly stoppedAt: Point | null;
}

/**
 * A centerline run being traced (#275).
 *
 * It lives here and not in the centerline list, which is why a run costs no
 * undo entry until it ends: an unfinished run is a gesture, like a chain of
 * cars or an open drag.
 */
interface Run {
  readonly steps: readonly RunStep[];
  /**
   * The centerline this run continues, or `null` for a new one. Set once, at
   * the first click, from {@link EXTEND_G}.
   */
  readonly extending: string | null;
}

/** What a run looks like to a renderer: its points so far, and where it stopped. */
export interface RunView {
  readonly points: readonly Point[];
  readonly stops: readonly Point[];
}

/** One car a live chain wrote, and the anchor it started from. */
interface ChainLink {
  readonly carId: string;
  readonly anchor: Point;
}

/** A chain of cars in progress (#33). */
interface Chain {
  readonly anchor: Point;
  readonly links: readonly ChainLink[];
}

/**
 * The editing rules for one archive: every write the editor makes, the tool,
 * the chain, drags, and the image on screen. Pointer input arrives in image
 * pixels with the screen scale, and the session does its own hit-testing.
 *
 * Every write goes through `history`. Listeners hear about every change.
 */
export class EditSession {
  readonly archive: R49Archive;
  readonly history = new EditHistory();

  private _filename: string | null;
  /** Where the current image was last seen, for picking a neighbour once it is gone. */
  private _index = 0;
  private _tool: EditorTool = 'calibration';
  private _chain: Chain | null = null;
  private _drag: Drag | null = null;
  private readonly _listeners = new Set<SessionListener>();

  /**
   * The archive's centerlines, held here rather than in the manifest.
   *
   * ADR 0021 makes them an optional `.r49` field; it arrives with
   * rails49/r49#52, and the pinned `@rails49/r49` refuses `layout.centerlines`
   * as `manifest/unknown-key`, so writing one would save an archive that does
   * not reopen. Everything else about them is already final — they are per
   * archive, every write is one history entry through the `centerlines` target,
   * and the list is replaced by value — so the bump moves this one field and
   * the store beneath it, and no rule above.
   */
  private _centerlines: readonly Centerline[] = [];
  private _run: Run | null = null;
  /** Spots where a stored run's fill stopped short. Session-lived, never saved. */
  private _stops: Point[] = [];
  private _selectedCenterline: string | null = null;
  /** The pixels the snap reads, and the image they are of. See {@link setTracePixels}. */
  private _pixels: { readonly filename: string; readonly plane: GrayPlane } | null = null;

  constructor(archive: R49Archive) {
    this.archive = archive;
    this.history.attach(archive, {
      read: () => this._centerlines,
      write: lines => {
        this._centerlines = lines;
        // A snapshot replaces the lines wholesale, so a selection or a run
        // naming one that is no longer there has to go with it.
        if (!this._centerlines.some(line => line.id === this._selectedCenterline)) {
          this._selectedCenterline = null;
        }
      },
    });
    this._filename = archive.getManifest().images[0]?.filename ?? null;
  }

  /** Calls `listener` after every change. Returns a function that stops it. */
  subscribe(listener: SessionListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** The image on screen, or undefined when the archive has none. */
  get image(): Image | undefined {
    const images = this.archive.getManifest().images;
    return (
      images.find(image => image.filename === this._filename) ??
      images[Math.min(this._index, images.length - 1)]
    );
  }

  /** The current image's position in the image list, or 0 when there is none. */
  get imageIndex(): number {
    const image = this.image;
    return image ? this.archive.getManifest().images.indexOf(image) : 0;
  }

  get tool(): EditorTool {
    return this._tool;
  }

  /** Whether DPT resolves: the calibration gate. */
  get calibrated(): boolean {
    return getDPT(this.archive.getManifest()) !== null;
  }

  /** Where the next car of a live chain starts, or null when no chain is live. */
  get anchor(): Point | null {
    return this._chain?.anchor ?? null;
  }

  /** The archive's traced centerlines, in the order they were traced. */
  get centerlines(): readonly Centerline[] {
    return this._centerlines;
  }

  /** The centerline with this id, or undefined once it is gone. */
  centerline(id: string): Centerline | undefined {
    return this._centerlines.find(line => line.id === id);
  }

  /** The centerline whose points are shown, or null. */
  get selectedCenterline(): string | null {
    return this._selectedCenterline;
  }

  /** Shows one centerline's points, or none for `null`. A line that is gone selects nothing. */
  selectCenterline(id: string | null) {
    const next = id !== null && this.centerline(id) ? id : null;
    if (next === this._selectedCenterline) return;
    this._selectedCenterline = next;
    this._changed();
  }

  /**
   * The run being traced, or null — its points in order and the spots its fill
   * stopped short at, for the editor to draw.
   */
  get run(): RunView | null {
    const run = this._run;
    return run && { points: runPoints(run), stops: runStops(run) };
  }

  /**
   * Every spot a fill stopped short at, across the whole edit session: the runs
   * already stored, and the one in flight.
   *
   * Not stored (#275) and not undoable. A mark says "the snap could not read
   * the track here", which is a fact about the photograph rather than an edit,
   * so there is nothing for an entry to put back.
   */
  get traceStops(): readonly Point[] {
    return [...this._stops, ...(this._run ? runStops(this._run) : [])];
  }

  /**
   * Hands the session the pixels of one image, for the snap to read.
   *
   * The session cannot decode an image: `createImageBitmap` and a canvas are
   * the platform's, and `driftSession.ts` is where this repository keeps that
   * work (`docs/UI.md`). So the editor decodes the image on screen and pushes
   * the plane in, and the session uses it only while that image is the one on
   * screen.
   *
   * With no plane the snap is simply not run: clicks are kept where they were
   * made and no stretch is filled. That is the same outcome as a snap that
   * refuses, and it is the honest one — a run traced against pixels nobody
   * supplied would be a hand-drawn polyline wearing the snap's name.
   */
  setTracePixels(filename: string, plane: GrayPlane | null) {
    this._pixels = plane ? { filename, plane } : null;
  }

  /** The car with this id on the image on screen, or undefined once it is gone. */
  car(id: string): CarLabel | undefined {
    return this.image?.labels.find(car => car.id === id);
  }

  /** The sensor with this id, or undefined once it is gone. */
  sensor(id: string): Sensor | undefined {
    return this._sensors().find(sensor => sensor.id === id);
  }

  /**
   * Makes `tool` the active one. Ends a live chain, and **ends** a live run —
   * which stores it (#275), the same way Enter and a double-click do. A gated
   * tool drops back to calibration.
   */
  selectTool(tool: EditorTool) {
    if (tool === this._tool) return;
    void this.endRun();
    this._tool = tool;
    this._chain = null;
    this._changed();
  }

  /**
   * Why `tool` cannot be used, or `null` when it can.
   *
   * The **one** answer the rail disables on and the session refuses on, so a
   * tool cannot be rendered enabled and dispatched as disabled. DPT first: it
   * is the gate nothing about the image on screen can lift, so naming the
   * completeness of an image on an uncalibrated archive would send the person
   * at the wrong problem.
   */
  toolReason(tool: EditorTool): string | null {
    if (this._gated(tool)) return GATE_REASON;
    const spec = TOOLS.find(entry => entry.tool === tool);
    if (spec?.needsLabeledComplete && !this.image?.labeled_complete) return COMPLETE_REASON;
    return null;
  }

  /** Shows the image with this filename. Ends a live chain when the image changes. */
  selectImage(filename: string) {
    if (this._select(filename)) this._changed();
  }

  /** Makes `filename` current and ends the chain, if it is another image that exists. */
  private _select(filename: string): boolean {
    if (filename === this.image?.filename) return false;
    if (!this.archive.getManifest().images.some(image => image.filename === filename)) return false;
    this._filename = filename;
    this._chain = null;
    return true;
  }

  /** Ends a live chain. The cars it wrote stay. */
  endChain() {
    if (!this._chain) return;
    this._chain = null;
    this._changed();
  }

  /**
   * A click at `at`. A live chain takes it as the next car end. Otherwise an
   * object under it is edited whatever the tool, and empty image runs the tool.
   */
  async click(at: Point, scale: number): Promise<ClickResult> {
    const px = { x: Math.round(at.x), y: Math.round(at.y) };

    if (this._chain) {
      await this._completeCar(this._chain, px);
      return NONE;
    }

    // The centerline tool's clicks are the run's, and the hit-test does not see
    // them first. A stored run carries a point every gauge along every track,
    // so almost every click aimed at track would land on one, and a tool that
    // selected a line instead of continuing the trace could not be used at all.
    // Selecting is therefore the other three tools' click (see `_clickOn`), and
    // dragging and the menu are hit-tested under every tool as before.
    if (this._tool === 'centerline') return this._traceClick(px);

    const hit = hitTest(this._scene(), at, grab(scale));
    if (hit) return this._clickOn(hit);

    switch (this._tool) {
      case 'calibration':
        return { kind: 'place-reference-point', px };
      case 'sensor':
        if (this._gated('sensor')) return NONE;
        await this._placeSensor(px);
        return NONE;
      case 'car': {
        if (this._gated('car') || !this.image) return NONE;
        // Only the click that starts a chain is checked: later clicks aim at existing ends.
        if (carCovering(this._scene(), px)) return { kind: 'notice', message: ALREADY_LABELED };
        this._chain = { anchor: px, links: [] };
        this._changed();
        return NONE;
      }
      // No `centerline` case: the early return above has already narrowed it
      // out, and the switch stops being exhaustive the moment that return goes.
    }
  }

  /** A click on an object: a reference point's position or a sensor's name. */
  private _clickOn(hit: HitTarget): ClickResult {
    switch (hit.kind) {
      case 'calibration': {
        const point = this._points()[hit.index];
        if (!point) return NONE;
        return { kind: 'edit-reference-point', index: hit.index, px: point.px, world: point.world };
      }
      case 'sensor': {
        const sensor = this.sensor(hit.id);
        if (!sensor) return NONE;
        return { kind: 'name-sensor', id: sensor.id, name: sensor.name ?? null };
      }
      case 'centerline-point':
        // Selecting shows the line's points, which is what a drag or a delete
        // of one needs in order to be aimed at (#275).
        this.selectCenterline(hit.id);
        return NONE;
      case 'car-endpoint':
      case 'coupler':
        return this._tool === 'car' ? { kind: 'notice', message: ALREADY_LABELED } : NONE;
    }
  }

  /**
   * Starts a drag of whatever is under `at`, or returns null when nothing is.
   * A second drag while one is open is refused.
   */
  beginDrag(at: Point, scale: number): Drag | null {
    if (this._drag) return null;
    const scene = this._scene();
    const hit = hitTest(scene, at, grab(scale));
    if (!hit) return null;
    const handles = dragHandles(hit, scene);
    if (handles.length === 0) return null;
    const filename = this.image?.filename;

    const gesture = this._beginGesture(hit, filename);
    const drag: Drag = {
      move: to => {
        if (this._drag !== drag) return;
        this._moveHandles(handles, filename, { x: to.x - at.x, y: to.y - at.y });
        this._changed();
      },
      end: async () => {
        if (this._drag !== drag) return;
        this._drag = null;
        await gesture.commit();
        this._changed();
      },
      cancel: async () => {
        if (this._drag !== drag) return;
        this._moveHandles(handles, filename, { x: 0, y: 0 });
        await drag.end();
      },
    };
    this._drag = drag;
    return drag;
  }

  /**
   * A right-click. A live chain ends and nothing else happens. Otherwise
   * returns what a menu would act on: a sensor or reference point under `at`,
   * else the car whose body is under it, else null.
   */
  rightClick(at: Point, scale: number): MenuSubject | null {
    if (this._chain) {
      this.endChain();
      return null;
    }
    // A run in flight takes the right-click the way a chain does: it ends, and
    // no menu opens. The gesture in progress is what the press is about.
    if (this._run) {
      void this.endRun();
      return null;
    }
    const scene = this._scene();
    const hit = hitTest(scene, at, grab(scale), MENU_HIT_KINDS);
    switch (hit?.kind) {
      case 'calibration': {
        const point = scene.calibrationPoints[hit.index];
        return point ? { kind: 'calibration', index: hit.index, px: point.px } : null;
      }
      case 'sensor':
        return { kind: 'sensor', id: hit.id };
      case 'centerline-point':
        return { kind: 'centerline-point', id: hit.id, index: hit.index };
    }
    // A car's body before a centerline: the line runs *under* the cars on it,
    // so a right-click on a vehicle means the vehicle.
    const car = carUnderPointer(scene, at, grab(scale));
    if (car) return { kind: 'car', id: car.id };
    const line = centerlineUnderPointer(scene, at, grab(scale));
    return line ? { kind: 'centerline', id: line.id } : null;
  }

  /** Writes a new reference point. */
  async placeReferencePoint(px: Point, world: WorldPoint) {
    await this._record('place calibration point', { kind: 'layout' }, () => {
      this._writeLayout({ calibrationPoints: [...this._points(), { px, world }] });
    });
  }

  /** Writes a new world position for the point at `index`, if it is still at `px`. */
  async editReferencePoint(index: number, px: Point, world: WorldPoint) {
    if (!this._pointIsStillAt(index, px)) return;
    await this._record('edit calibration point', { kind: 'layout' }, () => {
      const points = [...this._points()];
      points[index] = { ...points[index], world };
      this._writeLayout({ calibrationPoints: points });
    });
  }

  /** Names a sensor, or removes its name for `null`. Does nothing if it is gone. */
  async nameSensor(id: string, name: string | null) {
    if (!this.sensor(id)) return;
    await this._record('name sensor', { kind: 'layout' }, () => {
      this._writeLayout({
        sensors: this._sensors().map(sensor => {
          if (sensor.id !== id) return sensor;
          const renamed: Sensor = { id: sensor.id, x: sensor.x, y: sensor.y };
          return name === null ? renamed : { ...renamed, name };
        }),
      });
    });
  }

  /** Deletes a menu's subject, if it is still there. */
  async delete(subject: MenuSubject) {
    switch (subject.kind) {
      case 'calibration': {
        const { index } = subject;
        if (!this._pointIsStillAt(index, subject.px)) return;
        await this._record('delete calibration point', { kind: 'layout' }, () => {
          const points = [...this._points()];
          points.splice(index, 1);
          this._writeLayout({ calibrationPoints: points });
        });
        return;
      }
      case 'sensor': {
        const { id } = subject;
        if (!this.sensor(id)) return;
        await this._record('delete sensor', { kind: 'layout' }, () => {
          this._writeLayout({ sensors: this._sensors().filter(sensor => sensor.id !== id) });
        });
        return;
      }
      case 'centerline': {
        const { id } = subject;
        if (!this.centerline(id)) return;
        await this._record('delete centerline', { kind: 'centerlines' }, () => {
          this._writeCenterlines(this._centerlines.filter(line => line.id !== id));
        });
        return;
      }
      case 'centerline-point': {
        const { id, index } = subject;
        const line = this.centerline(id);
        if (!line || !line.points[index]) return;
        await this._record('delete centerline point', { kind: 'centerlines' }, () => {
          const points = line.points.filter((_, at) => at !== index);
          // A line of one point has no direction and so cannot turn a patch;
          // the last point goes with the line rather than leaving a stub the
          // tracing never made.
          this._writeCenterlines(
            points.length < 2
              ? this._centerlines.filter(other => other.id !== id)
              : this._centerlines.map(other => (other.id === id ? { ...other, points } : other))
          );
        });
        return;
      }
      case 'car': {
        // Deleting a car clears labeled_complete in the same entry (ADR 0011).
        const { id } = subject;
        const image = this.image;
        if (!image || !this.car(id)) return;
        await this._record('delete car', { kind: 'image', filename: image.filename }, () => {
          this._writeImage(image.filename, {
            labels: image.labels.filter(car => car.id !== id),
            labeledComplete: false,
          });
        });
        return;
      }
    }
  }

  /** Sets a car's class, the full dotted class. Does nothing if the car is gone. */
  async reclassifyCar(id: string, cls: string) {
    const image = this.image;
    if (!image || !this.car(id)) return;
    await this._record('reclassify car', { kind: 'image', filename: image.filename }, () => {
      this._writeImage(image.filename, {
        labels: image.labels.map(car => (car.id === id ? { ...car, class: cls } : car)),
      });
    });
  }

  /** Writes `labeled_complete` for the image on screen. The only place `true` is written. */
  async setComplete(complete: boolean) {
    const image = this.image;
    if (!image) return;
    await this._record(
      complete ? 'mark labeled complete' : 'mark labeling incomplete',
      { kind: 'image', filename: image.filename },
      () => this._writeImage(image.filename, { labeledComplete: complete })
    );
  }

  /** Writes layout fields from the settings dialog, named for the first one. */
  async editLayout(changes: LayoutSettings) {
    const field = Object.keys(changes)[0] ?? 'layout';
    await this._record(`edit ${field}`, { kind: 'layout' }, () => {
      const manifest = this.archive.getManifest();
      manifest.layout = { ...manifest.layout, ...changes };
    });
  }

  /**
   * Writes the camera height, or removes the key for `undefined`: the schema
   * field is optional with no default, so an absent height stays absent (#139).
   */
  async setCameraHeight(mm: number | undefined) {
    await this._record('edit camera height', { kind: 'layout' }, () => {
      const manifest = this.archive.getManifest();
      const calibration = { ...manifest.layout.calibration };
      if (mm === undefined) delete calibration.camera_height_mm;
      else calibration.camera_height_mm = mm;
      manifest.layout = { ...manifest.layout, calibration };
    });
  }

  /**
   * Adds an image at the end of the list and shows it. Sets `camera.resolution`
   * to `size` while nothing is positioned in pixels (`SPEC.md` § Images).
   */
  async addImage(filename: string, bytes: Uint8Array, size?: Size) {
    await this._addImages('add image', [{ filename, bytes, size }]);
  }

  /**
   * Adds a whole pick at the end of the list, in the order given, as **one**
   * history entry, and shows the first of them (#262).
   *
   * One entry because one pick is one gesture: a user who picks a session's
   * worth of photographs and then thinks better of it presses Cmd+Z once.
   * The entry targets the image list, so the bytes of every image it added are
   * retained for redo without the caller arranging it (`docs/UI.md` § Every
   * manifest mutation goes through `history.record`).
   *
   * The first image that decoded sets `camera.resolution` while nothing is
   * positioned (#254) — asked once, before any of the pick lands, because
   * after the first one the archive holds an image and nothing is unpositioned
   * any more.
   */
  async addImages(images: readonly AddedImage[]) {
    await this._addImages('add images', images);
  }

  /** {@link addImage} and {@link addImages}, which differ only in their label. */
  private async _addImages(label: string, images: readonly AddedImage[]) {
    if (images.length === 0) return;
    const stored = this._storedFilenames(images);
    await this._record(label, { kind: 'images' }, async () => {
      const sizing = this._nothingPositioned() ? images.find(img => img.size)?.size : undefined;
      if (sizing) {
        this.archive.getManifest().camera.resolution = {
          width: sizing.width,
          height: sizing.height,
        };
      }
      for (const [i, image] of images.entries()) {
        await this.archive.addImage(stored[i], image.bytes);
      }
    });
    this.selectImage(stored[0]);
  }

  /**
   * The filename each image is stored under: the one it came with, or a
   * generated one when that name is already taken (#256).
   *
   * The picked names are kept because they are what the corpus is indexed by
   * outside this program — `dataset/holdout.json` in rails49/detector names
   * images the way the camera did. A collision cannot be left to the format:
   * `R49Archive.addImage` on a name already present overwrites the bytes and
   * leaves the manifest entry with its labels, so a second `IMG_0001.jpg` from
   * another card would label one photograph with the other's cars. A name
   * taken by an earlier image of the same pick counts as taken, since none of
   * them is in the manifest yet.
   */
  private _storedFilenames(images: readonly AddedImage[]): string[] {
    const taken = new Set(this.archive.getManifest().images.map(img => img.filename));
    return images.map(({ filename }) => {
      const stored = taken.has(filename) ? generatedFilename(filename) : filename;
      taken.add(stored);
      return stored;
    });
  }

  /**
   * The size an added image must be, or null while nothing is positioned and
   * the next image sets `camera.resolution` instead (`SPEC.md` § Images).
   *
   * The rule is the session's and the wording is the editor's: the editor asks
   * before it adds and states the refusal, because the message names the file
   * the user picked, which the session never sees.
   */
  get requiredImageSize(): Size | null {
    return this._nothingPositioned() ? null : this.archive.getManifest().camera.resolution;
  }

  /** No image, calibration point or sensor: nothing is in `camera.resolution`'s pixels. */
  private _nothingPositioned(): boolean {
    const { images, layout } = this.archive.getManifest();
    return images.length === 0 && layout.calibration.points.length === 0 && layout.sensors.length === 0;
  }


  /** Deletes an image. Deleting the one on screen shows its neighbour. */
  async deleteImage(filename: string) {
    // `retain` keeps the bytes, which removeImage drops, so the delete can be undone.
    await this._record('delete image', { kind: 'images' }, () => this.archive.removeImage(filename), {
      retain: [filename],
    });
  }

  /** Moves the image at `from` to `to`. The image on screen stays on screen. */
  async reorderImages(from: number, to: number) {
    await this._record('reorder images', { kind: 'images' }, () =>
      this.archive.reorderImages(from, to)
    );
  }

  /**
   * Undoes one entry: selects the image it is on, applies it, and tells the
   * listeners what changed (`SPEC.md` § Undo and redo). A live chain takes
   * every undo: at its start the chain ends and nothing is undone; further
   * along the anchor steps back if the undo removed the chain's last car.
   * Refused while a drag is open.
   */
  async undo() {
    if (this._drag) return;
    // A run in flight takes every undo, the same rule as a chain of cars: the
    // last click goes, with the stretch it asked for, and at the run's start
    // the run ends and nothing on the stack is touched. The run is not on the
    // stack at all until it ends, so reaching past its start would undo the
    // edit *before* the trace began — an edit the person can still see.
    const run = this._run;
    if (run) {
      if (run.steps.length > 1) this._run = { ...run, steps: run.steps.slice(0, -1) };
      else this._run = null;
      this._changed();
      return;
    }
    const chain = this._chain;
    const link = chain?.links[chain.links.length - 1];
    if (chain && !link) {
      this.endChain();
      return;
    }
    const entry = await this._apply(this.history.undoEntry, () => this.history.undo());
    if (chain && link && this._chain && !this.car(link.carId)) {
      this._chain = { anchor: link.anchor, links: chain.links.slice(0, -1) };
    }
    this._changed(entry && { highlights: entry.highlights });
  }

  /**
   * Redoes one entry, the same way. Ends a live chain and **drops** a live run.
   *
   * Dropped rather than stored, because a redo is a step forward through the
   * stack and storing the run first would put a new entry on top of the branch
   * being walked — there would be nothing left to redo.
   */
  async redo() {
    if (this._drag) return;
    this._chain = null;
    this.dropRun();
    const entry = await this._apply(this.history.redoEntry, () => this.history.redo());
    this._changed(entry && { highlights: entry.highlights });
  }

  /** Selects the image `pending` is on, before `apply` lands it. */
  private async _apply(
    pending: HistoryEntry | null,
    apply: () => Promise<HistoryEntry | null>
  ): Promise<HistoryEntry | null> {
    const target = revealTarget(pending);
    if (target) this._select(target);
    const entry = await apply();
    this._settle();
    return entry;
  }

  /**
   * Writes the car from the chain's anchor to `px`, and makes `px` the anchor
   * of the next car. One entry per car. A click on the anchor itself writes nothing.
   */
  private async _completeCar(chain: Chain, px: Point) {
    const image = this.image;
    if (!image) {
      this.endChain();
      return;
    }
    if (samePoint(px, chain.anchor)) return;

    const car: CarLabel = {
      id: make_id(CAR_NODE_ID),
      class: rootClass(),
      provenance: 'human',
      p0: { ...chain.anchor },
      p1: { ...px },
    };
    this._chain = {
      anchor: { ...px },
      links: [...chain.links, { carId: car.id, anchor: chain.anchor }],
    };
    await this._record('place car', { kind: 'image', filename: image.filename }, () => {
      this._writeImage(image.filename, { labels: [...image.labels, car] });
    });
  }

  /**
   * A click under the centerline tool: the first starts a run, each one after
   * closes a stretch.
   *
   * The refusals in order, and each is a different claim. DPT is the archive's
   * and the rail already says so, so it is silent here. Completeness is the
   * image's. Track under a car is the pixel's, and it is the only one with a
   * remedy to name.
   */
  private async _traceClick(px: Point): Promise<ClickResult> {
    if (this._gated('centerline')) return NONE;
    const image = this.image;
    const dpt = getDPT(this.archive.getManifest());
    if (!image || dpt === null) return NONE;
    if (!image.labeled_complete) return { kind: 'notice', message: COMPLETE_REASON };
    if (image.labels.some(car => inCarArea(car, px, dpt))) {
      return { kind: 'notice', message: TRACK_UNDER_CAR };
    }

    if (!this._run) {
      this._startRun(px, dpt);
      return NONE;
    }
    this._extendRun(px, dpt);
    return NONE;
  }

  /**
   * Opens a run at `px`, extending an existing centerline when `px` is within
   * {@link EXTEND_G} of one of its two ends.
   *
   * Extending starts the run **at the line's own end**, not at the click: the
   * line continues from where it stopped, and taking the click instead would
   * leave a half-gauge kink at every join and a duplicate point beside it.
   *
   * The first click is not snapped. It has no direction yet — a cross-section
   * needs one — so it is the second click that gives both of them one.
   */
  private _startRun(px: Point, dpt: number) {
    const end = this._endWithin(px, EXTEND_G * dpt);
    this._run = {
      steps: [{ click: end?.at ?? px, filled: [], stoppedAt: null }],
      extending: end?.id ?? null,
    };
    this._changed();
  }

  /**
   * Closes a stretch at `px`: snaps the click, fills the gauge steps up to it,
   * and marks the spot where the fill stopped short.
   *
   * On the **second** click the opening one is snapped too, with the direction
   * this click just established (#275).
   */
  private _extendRun(px: Point, dpt: number) {
    const run = this._run;
    if (!run) return;
    const plane = this._tracePlane();
    let steps = [...run.steps];
    let from = steps[steps.length - 1].click;
    // A click on the point the run is already at writes nothing, as a chain's
    // click on its own anchor does.
    if (samePoint(px, from)) return;

    if (steps.length === 1 && plane) {
      const opening = snapToTrack(plane, from, { x: px.x - from.x, y: px.y - from.y }, dpt);
      if (opening) {
        steps = [{ ...steps[0], click: opening.at }];
        from = opening.at;
      }
    }

    const direction = { x: px.x - from.x, y: px.y - from.y };
    const snapped = plane && snapToTrack(plane, px, direction, dpt);
    // Kept unsnapped where the snap refuses, so the run carries on past a car
    // or a gap; the spot is marked instead.
    const click = snapped ? snapped.at : px;
    const trace = plane
      ? traceAlong(plane, from, click, dpt, { blocked: at => this._blocked(at, dpt) })
      : null;
    const stoppedAt = trace && trace.stop !== 'reached' ? trace.markAt : snapped ? null : px;

    steps.push({ click, filled: trace?.points ?? [], stoppedAt });
    this._run = { ...run, steps };
    this._changed();
  }

  /** Whether a filled point would land on track a car is standing on. */
  private _blocked(at: Point, dpt: number): boolean {
    return (this.image?.labels ?? []).some(car => inCarArea(car, at, dpt));
  }

  /**
   * Ends the run being traced, storing it as **one** history entry.
   *
   * A run of fewer than two points is not stored (#275): one point is not a
   * run, carries no direction, and no patch could be turned to it.
   *
   * The entry's target is the whole centerline list, so an extend that appended
   * to an existing line is put back by the same undo that would remove a new
   * one — there is no half-extended state to land in.
   */
  async endRun() {
    const run = this._run;
    if (!run) return;
    this._run = null;
    const points = runPoints(run);
    if (points.length < 2) {
      this._changed();
      return;
    }
    // Before the record, because recording tells the listeners — and a mark
    // pushed afterwards would not be on screen until something else changed.
    this._stops.push(...runStops(run));
    await this._record('trace centerline', { kind: 'centerlines' }, () => {
      const extending = run.extending && this.centerline(run.extending);
      if (!extending) {
        const line = { id: make_id(CENTERLINE_NODE_ID), points };
        this._writeCenterlines([...this._centerlines, line]);
        this._selectedCenterline = line.id;
        return;
      }
      // The run started at one of the line's two ends, so it continues from
      // there: appended at the last point, prepended reversed at the first.
      const atStart = samePoint(points[0], extending.points[0]);
      const joined = atStart
        ? [...points.slice(1).reverse(), ...extending.points]
        : [...extending.points, ...points.slice(1)];
      this._writeCenterlines(
        this._centerlines.map(line =>
          line.id === extending.id ? { ...line, points: joined } : line
        )
      );
      this._selectedCenterline = extending.id;
    });
  }

  /** Drops the run being traced. Nothing is stored and nothing is marked. */
  dropRun() {
    if (!this._run) return;
    this._run = null;
    this._changed();
  }

  /**
   * One end of an existing centerline within `reach` of `px`, nearest first, or
   * null.
   *
   * Only the two **ends**: a click in the middle of a line is a new run across
   * it, which is what a crossing or a parallel siding looks like, and attaching
   * there would fold two runs into one polyline that doubles back.
   */
  private _endWithin(px: Point, reach: number): { readonly id: string; readonly at: Point } | null {
    let best: { readonly id: string; readonly at: Point; readonly distance: number } | null = null;
    for (const line of this._centerlines) {
      for (const at of [line.points[0], line.points[line.points.length - 1]]) {
        if (!at) continue;
        const distance = Math.hypot(px.x - at.x, px.y - at.y);
        if (distance > reach) continue;
        if (!best || distance < best.distance) best = { id: line.id, at: { ...at }, distance };
      }
    }
    return best && { id: best.id, at: best.at };
  }

  /** The pixels of the image on screen, or null when the editor has supplied none. */
  private _tracePlane(): GrayPlane | null {
    const pixels = this._pixels;
    return pixels && pixels.filename === this.image?.filename ? pixels.plane : null;
  }

  /** Replaces the centerline list by value, the way every other write replaces a subtree. */
  private _writeCenterlines(centerlines: readonly Centerline[]) {
    this._centerlines = [...centerlines];
    if (!this._centerlines.some(line => line.id === this._selectedCenterline)) {
      this._selectedCenterline = null;
    }
  }

  /** Writes an unnamed sensor at `px`. */
  private async _placeSensor(px: Point) {
    await this._record('place sensor', { kind: 'layout' }, () => {
      this._writeLayout({
        sensors: [...this._sensors(), { id: make_id(SENSOR_NODE_ID), x: px.x, y: px.y }],
      });
    });
  }

  /** Opens the one entry a drag writes. Its target follows what was grabbed. */
  private _beginGesture(hit: HitTarget, filename: string | undefined): HistoryGesture {
    switch (hit.kind) {
      case 'car-endpoint':
      case 'coupler':
        return this.history.beginGesture(
          hit.kind === 'coupler' ? 'move coupler' : 'move car endpoint',
          { kind: 'image', filename: filename! }
        );
      case 'sensor':
        return this.history.beginGesture('move sensor', { kind: 'layout' });
      case 'calibration':
        return this.history.beginGesture('move calibration point', { kind: 'layout' });
      case 'centerline-point':
        return this.history.beginGesture('move centerline point', { kind: 'centerlines' });
    }
  }

  /**
   * Moves every handle by `delta` from where it started, so coupled ends stay
   * on one pixel. Writes only the subtree the handles are in.
   */
  private _moveHandles(handles: readonly DragHandle[], filename: string | undefined, delta: Point) {
    const points = [...this._points()];
    const sensors = [...this._sensors()];
    const image = this.archive.getManifest().images.find(img => img.filename === filename);
    const labels = image ? [...image.labels] : [];
    let centerlines = this._centerlines;
    let movedLayout = false;
    let movedLabels = false;
    let movedCenterlines = false;

    for (const handle of handles) {
      const at = dragTo(handle, delta);
      switch (handle.ref.kind) {
        case 'calibration': {
          const point = points[handle.ref.index];
          if (point) points[handle.ref.index] = { ...point, px: at };
          movedLayout = true;
          break;
        }
        case 'sensor': {
          const id = handle.ref.id;
          const index = sensors.findIndex(sensor => sensor.id === id);
          if (index >= 0) sensors[index] = { ...sensors[index], x: at.x, y: at.y };
          movedLayout = true;
          break;
        }
        case 'car-end': {
          const { id, end } = handle.ref;
          const index = labels.findIndex(label => label.id === id);
          if (index >= 0) {
            labels[index] = end === 'p0' ? { ...labels[index], p0: at } : { ...labels[index], p1: at };
          }
          movedLabels = true;
          break;
        }
        case 'centerline-point': {
          // **Not re-snapped** (#275). A drag is the person overriding the
          // snap, which is the whole reason the affordance exists — snapping
          // the point back would put it where it already was.
          const { id, index } = handle.ref;
          centerlines = centerlines.map(line =>
            line.id === id
              ? { ...line, points: line.points.map((point, i) => (i === index ? at : point)) }
              : line
          );
          movedCenterlines = true;
          break;
        }
      }
    }

    if (movedLayout) this._writeLayout({ calibrationPoints: points, sensors });
    if (movedLabels && image) this._writeImage(image.filename, { labels });
    if (movedCenterlines) this._writeCenterlines(centerlines);
  }

  /** Runs a write through the history, then tells the listeners. */
  private async _record(
    label: string,
    target: HistoryTarget,
    mutate: () => unknown,
    options?: { retain?: string[] }
  ) {
    await this.history.record(label, target, mutate, options);
    this._changed();
  }

  /** Replaces the parts of `layout` given, by value. */
  private _writeLayout(changes: {
    calibrationPoints?: readonly ReferencePoint[];
    sensors?: readonly Sensor[];
  }) {
    const manifest = this.archive.getManifest();
    manifest.layout = {
      ...manifest.layout,
      ...(changes.calibrationPoints
        ? { calibration: { ...manifest.layout.calibration, points: [...changes.calibrationPoints] } }
        : {}),
      ...(changes.sensors ? { sensors: [...changes.sensors] } : {}),
    };
  }

  /** Replaces the parts of one image record given, by value, addressed by filename. */
  private _writeImage(
    filename: string,
    changes: { labels?: readonly CarLabel[]; labeledComplete?: boolean }
  ) {
    const manifest = this.archive.getManifest();
    const index = manifest.images.findIndex(img => img.filename === filename);
    if (index < 0) return;
    manifest.images[index] = {
      ...manifest.images[index],
      ...(changes.labels ? { labels: [...changes.labels] } : {}),
      ...(changes.labeledComplete !== undefined ? { labeled_complete: changes.labeledComplete } : {}),
    };
  }

  /**
   * Brings the session's own state in step with the manifest: a gated tool
   * drops back to calibration and ends the chain, and an image that is gone
   * is replaced by its neighbour, which ends the chain too.
   */
  private _settle() {
    if (this._gated(this._tool)) {
      this._tool = 'calibration';
      this._chain = null;
      // Dropped rather than ended: the gate that fired is DPT, so there is no
      // gauge left to have traced the run in.
      this._run = null;
    }
    const image = this.image;
    if (image?.filename !== this._filename) {
      this._filename = image?.filename ?? null;
      this._chain = null;
      // A run deliberately survives: each stretch is traced on the image shown
      // when its closing click is made, and tracing a run across several
      // images is how track under a car gets traced at all (#275).
    }
    if (image) this._index = this.imageIndex;
  }

  private _changed(reveal: Reveal | null = null) {
    this._settle();
    for (const listener of this._listeners) listener(reveal);
  }

  /**
   * Whether `tool` needs a DPT that does not resolve.
   *
   * The **archive-wide** half of {@link toolReason}, and the only half
   * {@link _settle} acts on: nothing the person does to the image on screen
   * lifts it, so a tool held by it has to drop. The completeness gate is lifted
   * by selecting another image, and dropping the tool for it would end a run on
   * every image switch — the one thing tracing across images needs not to
   * happen.
   */
  private _gated(tool: EditorTool): boolean {
    return TOOLS.some(spec => spec.tool === tool && spec.needsDpt) && !this.calibrated;
  }

  /** Everything a pointer can land on: the current image's cars and the layout's points and sensors. */
  private _scene(): HitScene {
    const manifest = this.archive.getManifest();
    return {
      cars: this.image?.labels ?? [],
      sensors: manifest.layout.sensors,
      calibrationPoints: manifest.layout.calibration.points,
      centerlines: this._centerlines,
      dpt: getDPT(manifest),
    };
  }

  private _points(): readonly ReferencePoint[] {
    return this.archive.getManifest().layout.calibration.points;
  }

  private _sensors(): readonly Sensor[] {
    return this.archive.getManifest().layout.sensors;
  }

  /** Whether the point at `index` is still at `px`: points have no id. */
  private _pointIsStillAt(index: number, px: Point): boolean {
    const point = this._points()[index];
    return point !== undefined && samePoint(point.px, px);
  }
}

const NONE: ClickResult = { kind: 'none' };

/**
 * A run's points in order: each step's filled stretch, then the click that
 * closed it.
 *
 * The flat list is derived rather than stored so there is one representation to
 * keep right — undo during a run drops a whole step, and a second list would
 * have to be rewound in step with it.
 */
function runPoints(run: Run): readonly Point[] {
  return run.steps.flatMap(step => [...step.filled, step.click]);
}

/** Where a run's fills stopped short, in order. */
function runStops(run: Run): readonly Point[] {
  return run.steps.flatMap(step => (step.stoppedAt ? [step.stoppedAt] : []));
}

/** The grab radius at the scale the pointer event reported. */
function grab(scale: number): HitTolerance {
  return { screenPx: DEFAULT_GRAB_RADIUS_SCREEN_PX, imagePxPerScreenPx: scale };
}
