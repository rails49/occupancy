import { getDPT, make_id } from '@rails49/r49';
import type {
  ReferencePoint,
  CarLabel,
  Image,
  Layout,
  Click,
  Point,
  R49Archive,
  Sensor,
  WorldPoint,
} from '@rails49/r49';
import { carUnderPointer, dragHandles, dragTo, hitTest, samePoint, trackWidthPx } from './geometry.js';
import type { DragHandle, HitKind, HitScene, HitTarget, Size } from './geometry.js';
import { EditHistory, revealTarget } from './history.js';
import type { HistoryEntry, HistoryGesture, HistoryHighlight, HistoryTarget } from './history.js';
import { TOOLS } from './tools.js';
import { grab, pixel, NONE, NO_TRACK_NOTICE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import { carTool } from './carChain.js';
import {
  TrackChain,
  clickHitAt,
  insertAt,
  lineOf,
  refitLine,
  trackHitAt,
  trackTool,
  withClickAt,
  withClickIn,
  withoutClick,
} from './trackChain.js';
import { fitOptions } from './trackFit.js';
import type { Refusal } from './trackFit.js';
import { nearestOnTrack, SNAP_TRACK_WIDTHS } from './track.js';
import type { ClickHit, Track, TrackHit, TrackNode } from './track.js';
import type { EditorTool } from './tools.js';

export type { ChainView, ClickResult } from './chain.js';

/**
 * Node ids for the snowflakes this session mints. Image filenames use 2 here
 * and 3 for the editor's captures; sensor and label ids are separate
 * namespaces, so each gets its own node.
 */
const IMAGE_NODE_ID = 2;
const SENSOR_NODE_ID = 4;

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

/**
 * What a context menu acts on. A reference point has no id, so it carries the
 * pixel it was opened on, and an operation on it checks the point is still there.
 */
export type MenuSubject =
  | { readonly kind: 'car'; readonly id: string }
  | { readonly kind: 'sensor'; readonly id: string }
  | { readonly kind: 'calibration'; readonly index: number; readonly px: Point }
  /** A whole track; `px` is where its first node was. */
  | { readonly kind: 'track'; readonly line: number; readonly px: Point }
  /** Click `index` of a track; `px` is where it was. */
  | { readonly kind: 'track-click'; readonly line: number; readonly index: number; readonly px: Point };

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
  /** The car or track chain in progress. */
  private _chain: Chain | null = null;
  private _drag: Drag | null = null;
  /** Why the last click or edit under the track tool was refused, or null when it was not. */
  private _refusal: Refusal | null = null;
  private readonly _listeners = new Set<SessionListener>();
  private readonly _context: ChainContext = {
    manifest: () => this.archive.getManifest(),
    image: () => this.image,
    scene: () => this._scene(),
    snap: at => this._snap(at),
    record: (label, target, mutate) => this._record(label, target, mutate),
    refuse: reason => this._refuse(reason),
    writeLayout: changes => this._writeLayout(changes),
    writeImage: (filename, changes) => this._writeImage(filename, changes),
  };

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

  /** The chain in progress, or null when none is. */
  get chain(): ChainView | null {
    return this._chain?.view() ?? null;
  }

  /** The layout's tracks, the one a track chain is laying included. */
  get tracks(): readonly Track[] {
    return this._tracks();
  }

  /**
   * Why the last click or edit under the track tool was refused, or null:
   * the hint says why until the next click or edit, or the line ends
   * (`trackHint`).
   */
  get refusal(): Refusal | null {
    return this._refusal;
  }

  /**
   * Where a click at `at` would put the next car of a live car chain: the
   * nearest track, or null when none is near.
   */
  previewCar(at: Point): Point | null {
    return this._snap(at);
  }

  /** The car with this id on the image on screen, or undefined once it is gone. */
  car(id: string): CarLabel | undefined {
    return this.image?.labels.find(car => car.id === id);
  }

  /** The sensor with this id, or undefined once it is gone. */
  sensor(id: string): Sensor | undefined {
    return this._sensors().find(sensor => sensor.id === id);
  }

  /** Makes `tool` the active one. Ends a live chain. A gated tool drops back to calibration. */
  selectTool(tool: EditorTool) {
    if (tool === this._tool) return;
    this._tool = tool;
    this._chain = null;
    this._refusal = null;
    this._changed();
  }

  /** Shows the image with this filename. A car chain ends when the image changes. */
  selectImage(filename: string) {
    if (this._select(filename)) this._changed();
  }

  /** Makes `filename` current, if it is another image that exists. */
  private _select(filename: string): boolean {
    if (filename === this.image?.filename) return false;
    if (!this.archive.getManifest().images.some(image => image.filename === filename)) return false;
    this._filename = filename;
    return true;
  }

  /** Ends a live chain, and the last refusal with it. What it wrote stays; a chain still at its first click wrote nothing. */
  endChain() {
    if (!this._chain) return;
    this._chain = null;
    this._refusal = null;
    this._changed();
  }

  /**
   * A click at `at`. A live chain takes it as its next segment. Otherwise the
   * car or track tool looks first (`carChain.ts`, `trackChain.ts`), then an
   * object under the pointer is edited whatever the tool, and empty image runs
   * the tool.
   */
  async click(at: Point, scale: number): Promise<ClickResult> {
    const px = pixel(at);
    this._attempt();

    if (this._chain) return this._chain.extend(at, scale);

    const chainTool = CHAIN_TOOLS[this._tool];
    const chainHit = chainTool && !this._gated(this._tool) ? chainTool(this._context, at, scale) : null;
    if (chainHit?.kind === 'chain') {
      this._chain = chainHit.chain;
      this._changed();
      return NONE;
    }
    if (chainHit) return chainHit.run();

    const hit = hitTest(this._scene(), at, grab(scale));
    if (hit) return this._clickOn(hit);

    switch (this._tool) {
      case 'calibration':
        return { kind: 'place-reference-point', px };
      case 'sensor':
        if (this._gated('sensor')) return NONE;
        return this._placeSensor(px);
      case 'car':
      case 'track':
        return NONE;
    }
  }

  /**
   * A double-click at `at`, after the two clicks the browser sends before
   * it. On the click a live track chain goes on from, the gap to the next
   * click is to be straight (`TrackChain.straighten`). Otherwise nothing.
   */
  doubleClick(at: Point, scale: number) {
    if (!(this._chain instanceof TrackChain)) return;
    this._chain.straighten(at, scale);
    this._changed();
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
        return NONE;
    }
  }

  /**
   * Starts a drag of whatever is under `at`, or returns null when nothing is.
   * A second drag while one is open is refused. A drag goes on while a chain
   * is live, and ends one still at its start. While a track chain is live
   * only a click of its line is grabbed, or, while it is still at its start,
   * a click of another line, which ends it. Otherwise the track tool grabs a
   * line's click before anything else, and a press within the start distance
   * of a line, on nothing else, inserts a click there (`_grabInsert`).
   */
  beginDrag(at: Point, scale: number): Drag | null {
    if (this._drag) return null;
    if (this._chain instanceof TrackChain) {
      const traced = this._grabTraced(this._chain, at, scale);
      const click = traced || !this._chain.atStart() ? null : this._clickHit(at, scale);
      if (!click) return traced;
      this._chain = null;
      return this._grabClick(click, at);
    }
    const drag = this._grab(at, scale);
    if (drag && this._chain?.atStart()) this._chain = null;
    return drag;
  }

  private _grab(at: Point, scale: number): Drag | null {
    const click = this._clickHit(at, scale);
    if (click) return this._grabClick(click, at);
    const scene = this._scene();
    const hit = hitTest(scene, at, grab(scale));
    if (!hit) return this._grabInsert(at);
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
        this._moveHandles(handles, filename, { x: 0, y: 0 }, false);
        await drag.end();
      },
    };
    this._drag = drag;
    return drag;
  }

  /** A drag of a click on a line, which the line follows (`_dragLine`). */
  private _grabClick(hit: ClickHit, at: Point): Drag {
    const clicks = this._tracks()[hit.line].clicks!;
    return this._dragLine(hit.line, 'move click', clicks[hit.index], at, to => withClickAt(clicks, hit.index, to));
  }

  /**
   * A press within the start distance of a line under the track tool: a
   * click inserted at the press into the gap nearest it, placed where the
   * drag ends, as one entry. Null when no line with clicks is near.
   */
  private _grabInsert(at: Point): Drag | null {
    if (this._tool !== 'track' || this._gated('track')) return null;
    const insert = insertAt(this._context, at);
    if (!insert) return null;
    const clicks = this._tracks()[insert.line].clicks!;
    return this._dragLine(insert.line, 'insert click', pixel(at), at, to => withClickIn(clicks, insert.gap, to));
  }

  /**
   * A drag of a click of line `line` from `from`, grabbed at `at`: each move
   * writes the clicks `clicksAt(to)` with their line, or with the last line
   * the rule took where it refuses them, and the release writes one entry
   * `label`. A release back at `from`, or one the rule refuses, leaves the
   * line as it was.
   */
  private _dragLine(line: number, label: string, from: Point, at: Point, clicksAt: (to: Point) => Click[]): Drag {
    const start = this._tracks()[line];
    const opts = fitOptions(this._scene().dpt!);
    const gesture = this.history.beginGesture(label, { kind: 'layout' });
    const write = (track: Track) => {
      const lines = [...this._tracks()];
      lines[line] = track;
      this._writeLayout({ tracks: lines });
    };
    let shown = start;
    return this._dragClick(
      from,
      at,
      to => {
        const clicks = clicksAt(to);
        const built = lineOf(clicks, opts);
        if (typeof built !== 'string') shown = built;
        write({ ...shown, clicks });
        return typeof built === 'string' ? built : null;
      },
      async to => {
        write((to && refitLine(this._context, clicksAt(to))) || start);
        await gesture.commit();
      }
    );
  }

  /**
   * A drag while a track chain is live: of a click of the line it traces, and
   * nothing else. The trace follows the pointer (`TrackChain.hold`); on
   * release the chain takes the move (`TrackChain.move`), as one entry.
   */
  private _grabTraced(chain: TrackChain, at: Point, scale: number): Drag | null {
    const click = this._tracedClick(chain, at, scale);
    if (!click) return null;
    return this._dragClick(
      this._clickAt(click),
      at,
      to => chain.hold(click.index, to),
      async to => {
        chain.hold(click.index, null);
        if (to) await chain.move(click.index, to);
      }
    );
  }

  /**
   * A drag of a click at `from`, grabbed at `at`. `show` takes where the
   * click is dragged to on each move, and returns why the rule refuses it
   * there, which the hint says while the click is there; `drop` takes where
   * it was let go, or null when it is back where it was or the drag was
   * cancelled.
   */
  private _dragClick(
    from: Point,
    at: Point,
    show: (to: Point) => Refusal | null,
    drop: (to: Point | null) => Promise<void>
  ): Drag {
    let to = from;
    const drag: Drag = {
      move: p => {
        if (this._drag !== drag) return;
        to = dragTo({ from }, { x: p.x - at.x, y: p.y - at.y });
        this._refusal = show(to);
        this._changed();
      },
      end: async () => {
        if (this._drag !== drag) return;
        this._drag = null;
        this._attempt();
        await drop(samePoint(to, from) ? null : to);
        this._changed();
      },
      cancel: async () => {
        if (this._drag !== drag) return;
        to = from;
        await drag.end();
      },
    };
    this._drag = drag;
    return drag;
  }

  /** Where click `click.index` of line `click.line` is. */
  private _clickAt(click: ClickHit): Point {
    return this._tracks()[click.line].clicks![click.index];
  }

  /** The menu subject for a line's click, with the pixel it is at. */
  private _clickSubject(click: ClickHit): MenuSubject & { kind: 'track-click' } {
    return { kind: 'track-click', line: click.line, index: click.index, px: this._clickAt(click) };
  }

  /** The click under the pointer of the line `chain` traces, or null. */
  private _tracedClick(chain: TrackChain, at: Point, scale: number): ClickHit | null {
    const click = this._clickHit(at, scale);
    return click && click.line === chain.line ? click : null;
  }

  /**
   * A right-click. On a click of the line a live track chain traces, other
   * than the last, it returns that click and the chain goes on; anywhere else
   * a live chain ends and nothing else happens. Otherwise returns what a menu
   * would act on: under the track tool a line's click, else the line; then a
   * sensor or reference point under `at`, else the car whose body is under
   * it, else null.
   */
  rightClick(at: Point, scale: number): MenuSubject | null {
    if (this._chain) {
      const traced = this._chain instanceof TrackChain ? this._tracedClick(this._chain, at, scale) : null;
      const subject = traced && this._clickSubject(traced);
      if (subject && !samePoint(subject.px, this._chain.view().end)) return subject;
      this.endChain();
      return null;
    }
    const click = this._clickHit(at, scale);
    if (click) return this._clickSubject(click);
    const trackHit = this._trackHit(at, scale);
    if (trackHit) {
      const line = this._tracks()[trackHit.line];
      return { kind: 'track', line: trackHit.line, px: pointOf(line.nodes[0]) };
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

  /** Deletes a menu's subject, if it is still there. A refused delete writes nothing. */
  async delete(subject: MenuSubject) {
    this._attempt();
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
      case 'track': {
        const { line } = subject;
        if (!this._trackNodeIsStillAt(line, 0, subject.px)) return;
        await this._deleteLine(line);
        return;
      }
      case 'track-click': {
        // A line keeps at least two clicks, so deleting one of the last two
        // deletes the line.
        const { line, index } = subject;
        const clicks = this._clickIsStillAt(subject);
        if (!clicks) return;
        if (clicks.length <= 2) {
          await this._deleteLine(line);
          return;
        }
        const chain = this._chain instanceof TrackChain && this._chain.line === line ? this._chain : null;
        if (chain) {
          await chain.remove(index);
          return;
        }
        const refit = refitLine(this._context, withoutClick(clicks, index));
        if (!refit) return;
        const lines = [...this._tracks()];
        lines[line] = refit;
        await this._record('delete click', { kind: 'layout' }, () => this._writeLayout({ tracks: lines }));
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

  /** Deletes the line a click's menu was opened on, if the click is still there. */
  async deleteLine(subject: MenuSubject & { kind: 'track-click' }) {
    if (!this._clickIsStillAt(subject)) return;
    await this._deleteLine(subject.line);
  }

  /** Deletes line `line` as one entry, and ends a chain tracing it. */
  private async _deleteLine(line: number) {
    if (this._chain instanceof TrackChain && this._chain.line === line) this._chain = null;
    const lines = this._tracks().filter((_, i) => i !== line);
    await this._record('delete track', { kind: 'layout' }, () => this._writeLayout({ tracks: lines }));
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
   * along the undo removes its last segment, and the chain goes on from the
   * dot before it. Refused while a drag is open.
   */
  async undo() {
    if (this._drag) return;
    if (this._chain?.atStart()) {
      this.endChain();
      return;
    }
    const entry = await this._apply(this.history.undoEntry, () => this.history.undo());
    this._changed(entry && { highlights: entry.highlights });
  }

  /** Redoes one entry, the same way. Ends a live chain first. Refused while a drag is open. */
  async redo() {
    if (this._drag) return;
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

  /** Writes an unnamed sensor on the track nearest `px`, or refuses with no track near. */
  private async _placeSensor(px: Point): Promise<ClickResult> {
    const at = this._snap(px);
    if (!at) return NO_TRACK_NOTICE;
    await this._record('place sensor', { kind: 'layout' }, () => {
      this._writeLayout({
        sensors: [...this._sensors(), { id: make_id(SENSOR_NODE_ID), x: at.x, y: at.y }],
      });
    });
    return NONE;
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
   * on one pixel. With `snap`, a sensor or car end lands on the nearest track,
   * and stays where it is when no track is near. Writes only the subtree the
   * handles are in.
   */
  private _moveHandles(
    handles: readonly DragHandle[],
    filename: string | undefined,
    delta: Point,
    snap = true
  ) {
    const points = [...this._points()];
    const sensors = [...this._sensors()];
    const image = this.archive.getManifest().images.find(img => img.filename === filename);
    const labels = image ? [...image.labels] : [];
    let movedLayout = false;
    let movedLabels = false;

    for (const handle of handles) {
      const to = dragTo(handle, delta);
      const at = snap && handle.ref.kind !== 'calibration' ? this._snap(to) : to;
      if (!at) continue;
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

  /** The click or edit was refused: the hint says why until the next one. */
  private _refuse(reason: Refusal) {
    this._refusal = reason;
    this._changed();
  }

  /** A click or an edit begins: the last refusal is over. */
  private _attempt() {
    if (!this._refusal) return;
    this._refusal = null;
    this._changed();
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
    tracks?: readonly Track[];
  }) {
    const manifest = this.archive.getManifest();
    manifest.layout = {
      ...manifest.layout,
      ...(changes.calibrationPoints
        ? { calibration: { ...manifest.layout.calibration, points: [...changes.calibrationPoints] } }
        : {}),
      ...(changes.sensors ? { sensors: [...changes.sensors] } : {}),
      ...(changes.tracks ? { tracks: [...changes.tracks] } : {}),
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
   * drops back to calibration and ends the chain, a chain that cannot go on
   * ends, and an image that is gone is replaced by its neighbour.
   */
  private _settle() {
    if (this._gated(this._tool)) {
      this._tool = 'calibration';
      this._chain = null;
    }
    const image = this.image;
    if (image?.filename !== this._filename) this._filename = image?.filename ?? null;
    if (image) this._index = this.imageIndex;
    if (this._chain && !this._chain.settle()) this._chain = null;
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

  private _tracks(): readonly Track[] {
    return this.archive.getManifest().layout.tracks ?? [];
  }

  /** The click under the track tool's pointer. Null under another tool, or while the tool is gated. */
  private _clickHit(at: Point, scale: number): ClickHit | null {
    if (this._tool !== 'track' || this._gated('track')) return null;
    return clickHitAt(this._tracks(), at, scale);
  }

  /** The line under the track tool's pointer. Null under another tool, or while the tool is gated. */
  private _trackHit(at: Point, scale: number): TrackHit | null {
    if (this._tool !== 'track' || this._gated('track')) return null;
    return trackHitAt(this._tracks(), at, scale);
  }

  /**
   * `at` on the nearest track within {@link SNAP_TRACK_WIDTHS} track
   * widths, in whole pixels, or null when none is that near. With no DPT there
   * is no track width, and `at` is kept.
   */
  private _snap(at: Point): Point | null {
    const dpt = getDPT(this.archive.getManifest());
    if (dpt === null) return pixel(at);
    const on = nearestOnTrack(this._tracks(), at, SNAP_TRACK_WIDTHS * trackWidthPx(dpt));
    return on && pixel(on);
  }

  /** Whether node `node` of line `line` is still at `px`: lines and nodes have no id. */
  private _trackNodeIsStillAt(line: number, node: number, px: Point): boolean {
    const n = this._tracks()[line]?.nodes[node];
    return n !== undefined && n.x === px.x && n.y === px.y;
  }

  /** The clicks of a click subject's line, if the click is still at its pixel: clicks have no id. */
  private _clickIsStillAt(subject: MenuSubject & { kind: 'track-click' }): readonly Click[] | null {
    const clicks = this._tracks()[subject.line]?.clicks;
    const click = clicks?.[subject.index];
    return click && samePoint(click, subject.px) ? clicks : null;
  }

  /** Whether the point at `index` is still at `px`: points have no id. */
  private _pointIsStillAt(index: number, px: Point): boolean {
    const point = this._points()[index];
    return point !== undefined && samePoint(point.px, px);
  }
}

/** The tools whose clicks lay a chain. */
const CHAIN_TOOLS: Partial<Record<EditorTool, ChainTool>> = { car: carTool, track: trackTool };

function pointOf(node: TrackNode): Point {
  return { x: node.x, y: node.y };
}
