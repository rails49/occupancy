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
import {
  carCovering,
  carUnderPointer,
  dragHandles,
  dragTo,
  hitTest,
  samePoint,
  DEFAULT_GRAB_RADIUS_SCREEN_PX,
} from './geometry.js';
import type { DragHandle, HitKind, HitScene, HitTarget, HitTolerance, Size } from './geometry.js';
import { EditHistory, revealTarget } from './history.js';
import type { HistoryEntry, HistoryGesture, HistoryHighlight, HistoryTarget } from './history.js';
import { TOOLS } from './tools.js';
import { STRAIGHT_SNAP_SCREEN_PX, traceTo } from './track.js';
import type { Track, TraceStep, TrackNode } from './track.js';
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

/** Why the track tool refused a click (#284). */
export const TURN_TOO_SHARP = 'One segment turns at most 90°. Place a node before the turn gets that sharp.';

/** Why the car tool refused a click on a car's body or on one of its ends (#43). */
export const ALREADY_LABELED =
  'That pixel is already inside a labeled car — a car is labeled once.';

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
  | { readonly kind: 'calibration'; readonly index: number; readonly px: Point };

/**
 * The menu hit-tests the objects drawn over the cars first. Car ends are left
 * out, so a right-click on a coupling falls through to the car's body (#45).
 */
const MENU_HIT_KINDS: readonly HitKind[] = ['sensor', 'calibration'];

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

/** A centerline being traced (#284): the first click, and the nodes placed since. */
export interface Trace {
  readonly start: Point;
  /** Empty until the second click, which gives the first node its heading. */
  readonly nodes: readonly TrackNode[];
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
  /**
   * Traced centerlines and the one being traced (#284). Held here and nowhere
   * else: they are not saved and have no undo once ended.
   */
  private _tracks: readonly Track[] = [];
  private _trace: Trace | null = null;
  private _drag: Drag | null = null;
  private readonly _listeners = new Set<SessionListener>();

  constructor(archive: R49Archive) {
    this.archive = archive;
    this.history.attach(archive);
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

  /** The centerlines traced and ended in this session. */
  get tracks(): readonly Track[] {
    return this._tracks;
  }

  /** The centerline being traced, or null when none is. */
  get trace(): Trace | null {
    return this._trace;
  }

  /** The last point a live trace placed, or null when no trace is live. */
  get traceEnd(): Point | null {
    const trace = this._trace;
    if (!trace) return null;
    const last = trace.nodes[trace.nodes.length - 1];
    return last ? { x: last.x, y: last.y } : trace.start;
  }

  /**
   * What a click at `at` would do to a live trace, or null when none is live. A
   * click within the grab radius of the last point placed adds nothing.
   */
  previewTrace(at: Point, scale: number): TraceStep | null {
    const trace = this._trace;
    return (
      trace &&
      traceTo(
        trace.start,
        trace.nodes,
        at,
        STRAIGHT_SNAP_SCREEN_PX * scale,
        DEFAULT_GRAB_RADIUS_SCREEN_PX * scale
      )
    );
  }

  /** Ends a live trace. A line of two nodes or more is kept; a lone start is dropped. */
  endTrace() {
    if (!this._closeTrace()) return;
    this._changed();
  }

  /** Ends a live trace without telling the listeners. Returns whether one was live. */
  private _closeTrace(): boolean {
    const trace = this._trace;
    if (!trace) return false;
    if (trace.nodes.length >= 2) this._tracks = [...this._tracks, { nodes: trace.nodes }];
    this._trace = null;
    return true;
  }

  /** The car with this id on the image on screen, or undefined once it is gone. */
  car(id: string): CarLabel | undefined {
    return this.image?.labels.find(car => car.id === id);
  }

  /** The sensor with this id, or undefined once it is gone. */
  sensor(id: string): Sensor | undefined {
    return this._sensors().find(sensor => sensor.id === id);
  }

  /** Makes `tool` the active one. Ends a live chain or trace. A gated tool drops back to calibration. */
  selectTool(tool: EditorTool) {
    if (tool === this._tool) return;
    this._tool = tool;
    this._chain = null;
    this._closeTrace();
    this._changed();
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
   * A click at `at`. A live chain takes it as the next car end, and a live
   * trace as its next node. The track tool starts a trace wherever it is
   * clicked. Otherwise an object under it is edited whatever the tool, and
   * empty image runs the tool.
   */
  async click(at: Point, scale: number): Promise<ClickResult> {
    const px = { x: Math.round(at.x), y: Math.round(at.y) };

    if (this._trace) return this._extendTrace(px, scale);

    if (this._chain) {
      await this._completeCar(this._chain, px);
      return NONE;
    }

    if (this._tool === 'track') {
      if (this._gated('track')) return NONE;
      this._trace = { start: px, nodes: [] };
      this._changed();
      return NONE;
    }

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
      case 'car-endpoint':
      case 'coupler':
        return this._tool === 'car' ? { kind: 'notice', message: ALREADY_LABELED } : NONE;
    }
  }

  /**
   * Starts a drag of whatever is under `at`, or returns null when nothing is.
   * A second drag while one is open is refused, and so is any drag while a
   * trace is live: sensors sit on the track being traced.
   */
  beginDrag(at: Point, scale: number): Drag | null {
    if (this._drag || this._trace) return null;
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
   * A right-click. A live chain or trace ends and nothing else happens. Otherwise
   * returns what a menu would act on: a sensor or reference point under `at`,
   * else the car whose body is under it, else null.
   */
  rightClick(at: Point, scale: number): MenuSubject | null {
    if (this._trace) {
      this.endTrace();
      return null;
    }
    if (this._chain) {
      this.endChain();
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
    }
    const car = carUnderPointer(scene, at, grab(scale));
    return car ? { kind: 'car', id: car.id } : null;
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
   * A live trace takes every undo too: it loses its last node, or back to
   * its start from the first segment, whose heading the second click set; a
   * trace at its start ends. Refused while a drag is open.
   */
  async undo() {
    if (this._drag) return;
    const trace = this._trace;
    if (trace) {
      const nodes = trace.nodes.length > 2 ? trace.nodes.slice(0, -1) : [];
      this._trace = trace.nodes.length === 0 ? null : { start: trace.start, nodes };
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

  /** Redoes one entry, the same way. Ends a live chain. Refused while a drag is open or a trace is live. */
  async redo() {
    if (this._drag || this._trace) return;
    this._chain = null;
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

  /** Adds the node a click at `px` makes, or says why the click was refused. */
  private _extendTrace(px: Point, scale: number): ClickResult {
    const step = this.previewTrace(px, scale);
    if (!this._trace || step?.kind !== 'node') {
      return step?.kind === 'too-sharp' ? { kind: 'notice', message: TURN_TOO_SHARP } : NONE;
    }
    this._trace = { start: this._trace.start, nodes: step.nodes };
    this._changed();
    return NONE;
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
    let movedLayout = false;
    let movedLabels = false;

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
      }
    }

    if (movedLayout) this._writeLayout({ calibrationPoints: points, sensors });
    if (movedLabels && image) this._writeImage(image.filename, { labels });
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
   * drops back to calibration and ends the chain or trace, and an image that
   * is gone is replaced by its neighbour, which ends the chain too. A trace
   * outlives an image change: track belongs to the layout.
   */
  private _settle() {
    if (this._gated(this._tool)) {
      this._tool = 'calibration';
      this._chain = null;
      this._closeTrace();
    }
    const image = this.image;
    if (image?.filename !== this._filename) {
      this._filename = image?.filename ?? null;
      this._chain = null;
    }
    if (image) this._index = this.imageIndex;
  }

  private _changed(reveal: Reveal | null = null) {
    this._settle();
    for (const listener of this._listeners) listener(reveal);
  }

  /** Whether `tool` needs a DPT that does not resolve. */
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

/** The grab radius at the scale the pointer event reported. */
function grab(scale: number): HitTolerance {
  return { screenPx: DEFAULT_GRAB_RADIUS_SCREEN_PX, imagePxPerScreenPx: scale };
}
