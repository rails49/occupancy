import { LitElement, html, css, svg } from 'lit';
import type { SVGTemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { renderCalibrationPoint, calibrationMarkerStyles } from './calibrationMarker.js';
import { renderSensor, sensorMarkerStyles } from './sensorMarker.js';
import type { SensorSymbolSize } from './sensorMarker.js';
import {
  renderCar,
  renderCoupler,
  renderDetection,
  renderPendingCar,
  carMarkerStyles,
} from './carMarker.js';
import type { CarSymbolSize, CarWarning, PendingCar } from './carMarker.js';
import {
  coupledEnds,
  couplerPoints,
  overlayFit,
  sensorDiameterPx,
  zoomTransform,
  SYMBOL_SIZE_SCREEN_PX,
} from './geometry.js';
import type { FrameSize, Rect, Size } from './geometry.js';
import { highlightStyles } from './highlight.js';
import { matteTokens } from './matte.js';
import { isKnownClass } from './vocabulary.js';
import type { CalibrationPoint, CarLabel, Point, Sensor } from '@occupancy/r49';
import type { Detection, SensorState } from '@occupancy/detector';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

export const viewerStyles = css`
  :host {
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .viewport {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--photo-matte);
    /* The zoom layer inside is transformed, so it grows past this box. The
       host clips too; saying it here keeps the clip beside the thing clipped. */
    overflow: hidden;
  }

  .zoom-layer {
    /* One transform, above **both** the media and the overlay (#44).
       That is the whole mechanism: two children of one transformed box stay
       one box by construction, exactly as #41 left them, and getScreenCTM
       walks up through this — so every screen-pixel tolerance and every
       world-pixel size downstream is already zoom-aware.

       The three custom properties are written per render because the
       transform is computed from a measurement (geometry.ts, zoomTransform);
       the rule itself stays here with the rest of the CSS. Unzoomed they
       default to the identity, which is exactly what this element rendered
       before zoom existed. */
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transform-origin: 0 0;
    transform: translate(var(--zoom-x, 0px), var(--zoom-y, 0px)) scale(var(--zoom-scale, 1));
  }

  img, video {
    /* The media covers the **container**, exactly as the overlay does, and
       letterboxes its content inside it with object-fit: contain — the same
       rule as the SVG's preserveAspectRatio="xMidYMid meet", over the same box,
       with the same centering. That is what makes the two boxes one box.

       Sizing it max-width: 100%; max-height: 100% instead let the media lay out
       at its **natural** size, which stops growing once the container is larger
       than the photograph while the overlay keeps growing (#41).

       The visible consequence is that a photograph smaller than the pane is now
       **upscaled** to fill it, where it used to stop at 1:1. That is the right
       trade for a labeling surface — the labeler aims at car ends, and a
       postage stamp in the middle of a large pane is harder to aim at than a
       soft enlargement — and it is not the fit-to-window work of #42, which is
       about the chrome around this element. */
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  svg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    /* The overlay takes the pointer so every gesture is reported in one
       coordinate system, and so dragging over the image cannot start the
       browser's native image drag. Which element under the cursor was hit is
       not read from the DOM — geometry.ts answers that from coordinates. */
    pointer-events: auto;
    user-select: none;
    touch-action: none;
  }

  /* The zoom rect in flight. Drawn in the overlay rather than as an HTML box on
     the glass: an HTML band would need its own image-to-screen mapping, which
     is the hand-rolled arithmetic this component exists to avoid, in a second
     box that would then have to be kept aligned with the first (#41). Its
     stroke is set per render from symbolSize, so it is screen-constant like
     every other annotation. */
  .zoom-band {
    fill: none;
    stroke: #fff;
    pointer-events: none;
  }
`;

/**
 * Label font size as a fraction of the screen-constant symbol size.
 *
 * The calibration crosshair uses the same 0.42 internally, so the two labels
 * are the same size on screen — they are the same kind of annotation, and a
 * difference would read as a difference in importance.
 */
const LABEL_SIZE_RATIO = 0.42;

/**
 * A car endpoint handle's diameter, as a fraction of the screen-constant symbol
 * size.
 *
 * A handle is where the pointer grabs, so it is a **screen** size like every
 * other annotation — the rectangle around it is the world size. Smaller than a
 * crosshair on purpose: a symbol that covered the car ends would hide the
 * feature the labeler is aiming at. A coupling draws *one* handle of its own
 * (`carMarker.ts` § `renderCoupler`) rather than two of these.
 */
const CAR_HANDLE_SIZE_RATIO = 0.3;

/**
 * Stroke width of the zoom band in flight, as a fraction of the
 * screen-constant symbol size.
 *
 * A screen size for the same reason a crosshair is one: the band annotates the
 * photograph rather than measuring it, and a stroke in image pixels would be
 * invisible on a large frame and a slab on a small one. The dashes are derived
 * from it, so the whole band scales as one thing.
 */
const ZOOM_BAND_STROKE_RATIO = 0.06;

/**
 * A pointer gesture, in **image pixel coordinates**.
 *
 * Consumers never see screen coordinates: the viewer converts before it emits,
 * so a handler cannot forget to, and cannot get it subtly wrong when the
 * viewport is letterboxed.
 */
export interface ViewerPointerDetail {
  /**
   * Where the pointer is, in the image's own pixel frame — the SVG viewBox,
   * which `object-fit: contain` and `preserveAspectRatio="xMidYMid meet"` keep
   * mapped 1:1 onto it.
   *
   * It may fall **outside** the image bounds: the overlay covers the letterbox
   * bars, and a captured drag keeps reporting after the pointer leaves the
   * element. Clamping is the consumer's decision, not the viewer's.
   */
  readonly point: Point;
  /**
   * Image pixels per screen pixel, read off the same transform as `point`.
   *
   * This is what turns a grab radius in screen pixels into one in image
   * pixels — see `geometry.ts` § `HitTolerance`. It is taken from the CTM
   * rather than from `resolution.width / rect.width`, which is wrong by the
   * letterbox whenever the viewport's aspect ratio differs from the image's.
   */
  readonly imagePxPerScreenPx: number;
  /** The event this came from — `pointerId`, `buttons`, modifier keys. */
  readonly originalEvent: PointerEvent;
}

/** The four events a pointer gesture goes through, start to finish. */
export type ViewerPointerEventName =
  | 'rr-pointer-down'
  | 'rr-pointer-move'
  | 'rr-pointer-up'
  | 'rr-pointer-cancel';

/**
 * What the loaded media turned out to be, against what the archive declared.
 *
 * Emitted once per media load, because the two can disagree and only the viewer
 * ever learns the first number: `camera.resolution` is one value for the whole
 * archive while the images are per image, so a re-encoded or re-cropped photo
 * mismatches it with nothing to notice (#41). The overlay follows the media
 * either way — see `geometry.ts` § `overlayFit` — and this is how a consumer
 * says so out loud rather than letting the stretch pass as the truth.
 */
export interface ViewerMediaFrameDetail {
  /** The media's own pixel dimensions: `naturalWidth`/`videoWidth`. */
  readonly media: FrameSize;
  /** What the archive declares, the frame every coordinate is authored in. */
  readonly frame: FrameSize;
  /** The two are different **shapes**, so the overlay is stretched to fit. */
  readonly aspectMismatch: boolean;
}

/**
 * Which drawn objects carry the reveal glow — what an undo or redo just changed
 * (#37).
 *
 * **Already resolved**, and that is the split: the history says which objects an
 * entry touched and `rr-editor-view` decides which of those still exist and
 * where they are now, because only it knows which image is on screen. The
 * viewer is handed the answer and draws it, exactly as it is handed the cars
 * and draws those.
 *
 * Cars and sensors by `id`, since that is what the editor keys everything on.
 * Calibration points by **index**, because they have no id — the editor resolves
 * a pixel to an index at the moment it renders, so a list renumbered by the very
 * undo being revealed cannot leave the glow on the wrong crosshair.
 */
export interface ViewerHighlight {
  readonly cars: readonly string[];
  readonly sensors: readonly string[];
  readonly calibration: readonly number[];
}

/**
 * How big the viewport is, in **screen** pixels — the box the media
 * letterboxes into (#44).
 *
 * Emitted because only the viewer measures it, and the editor needs it for the
 * one piece of zoom arithmetic that is about the screen rather than the
 * photograph: the cap on how far a rect may zoom in, which is stated as
 * screen pixels per authored-frame pixel (`geometry.ts` §
 * `MAX_ZOOM_SCREEN_PX_PER_FRAME_PX`).
 *
 * A separate event rather than a field on every pointer detail: it changes when
 * the window does, not when the pointer does, and `rr-media-frame` already
 * establishes the shape for "something the viewer alone can see".
 */
export interface ViewerViewportDetail {
  readonly width: number;
  readonly height: number;
}

/** A right-click, in image pixel coordinates. Same shape, coarser event. */
export interface ViewerContextMenuDetail extends Omit<ViewerPointerDetail, 'originalEvent'> {
  /**
   * The `contextmenu` event. The viewer does **not** call `preventDefault()`:
   * whether the native menu is suppressed depends on what the consumer does
   * with the right-click, which is state-dependent in the editor and undefined
   * in the live view.
   */
  readonly originalEvent: MouseEvent;
}

/**
 * Display surface, shared by the editor (`src` → `<img>`) and the live view
 * (`stream` → `<video>`), with annotations drawn over it in image pixel
 * coordinates.
 *
 * **What it draws splits by view, and the split is the two things the archive
 * holds against the two the model says.** The editor passes authored objects —
 * calibration points, sensors, cars; the live view passes what a frame
 * produced — `detections` (L0) and `sensorStates` (L1) over the same sensor
 * list. Nothing here computes either: `occupancy()` is a pure function in
 * `@occupancy/detector` and the viewer is handed its answer, exactly as it is
 * handed the cars.
 *
 * **It reports pointer gestures; it still authors nothing.** The v3 machinery
 * that added, moved and deleted point markers went with the v4 reduction (#19),
 * and none of it comes back — v4 has neither point markers nor a draggable
 * `{p0, p1}` pair. What the viewer does is emit `rr-pointer-*` events whose
 * coordinates are already in **image pixels**; the tools that interpret them
 * live in the editor, and the geometry they need is in `geometry.ts`.
 *
 * **The media and the overlay resolve to one box, by construction.** Both cover
 * the container, and both fit their content into it by the same rule —
 * `object-fit: contain` against `preserveAspectRatio="xMidYMid meet"` — over a
 * viewBox that is the media's **own** pixel grid. Sizing either from something
 * else is what made an object drift off the pixel it names as the window was
 * resized (#41): two boxes fitted independently coincide only by luck.
 *
 * The authored frame (`resolution`) reaches that grid through the `g.frame`
 * scale, so everything drawn and every coordinate emitted stays in the frame
 * the manifest is written in.
 *
 * Under an **aspect mismatch** that scale is non-uniform, so the screen-constant
 * annotations inside the group are stretched with everything else — a crosshair
 * on a 4:3 photo of a 16:9 frame is a third too tall. That is left visible on
 * purpose rather than compensated for: the archive is inconsistent, `rr-editor-view`
 * says so from `rr-media-frame`, and a symbol that looked right would argue the
 * opposite. It cannot arise from resizing the window, which is what #41 was.
 *
 * **Zoom is one transform above both children** (#44). `zoom` is a rect of the
 * authored frame — `null` for the whole of it — applied to a layer carrying the
 * media *and* the overlay, so they remain one box by construction rather than
 * by two transforms being kept in sync. Because `getScreenCTM` walks up through
 * that layer, `imagePxPerScreenPx` and `symbolSize` become zoom-aware with no
 * arithmetic changed anywhere: annotations stay a constant **screen** size,
 * objects stay a constant **world** size, and a grab radius stays a fingertip.
 *
 * **Properties:** `src`, `stream`, `calibrationPoints`, `sensors`,
 * `sensorStates`, `detections`, `cars`, `pendingCar`, `highlight`, `zoom`,
 * `zoomPreview`, `dpt`, `resolution`.
 *
 * @fires rr-pointer-down - Pointer pressed. Detail: {@link ViewerPointerDetail}
 * @fires rr-pointer-move - Pointer moved. Detail: {@link ViewerPointerDetail}
 * @fires rr-pointer-up - Gesture finished. Detail: {@link ViewerPointerDetail}
 * @fires rr-pointer-cancel - Gesture abandoned by the browser. Detail: {@link ViewerPointerDetail}
 * @fires rr-pointer-contextmenu - Right-click. Detail: {@link ViewerContextMenuDetail}
 * @fires rr-media-frame - Media loaded, with its size against the archive's. Detail: {@link ViewerMediaFrameDetail}
 * @fires rr-viewport - The viewport was measured at a new size. Detail: {@link ViewerViewportDetail}
 */
@customElement('rr-viewer')
export class RrViewer extends LitElement {
  static styles = [
    matteTokens,
    viewerStyles,
    calibrationMarkerStyles,
    sensorMarkerStyles,
    carMarkerStyles,
    // Last, and shared by all three above: the glow is an annotation on
    // whichever symbol a reveal points at, not a symbol of its own.
    highlightStyles,
  ];

  @property({ type: String }) src: string | null = null;
  @property({ attribute: false }) stream: MediaStream | null = null;
  /**
   * The layout's calibration points, drawn as labelled crosshairs.
   *
   * Display only: the editor authors them, and the viewer never writes one.
   * Empty in the live view, which has no reason to show them.
   */
  @property({ attribute: false }) calibrationPoints: readonly CalibrationPoint[] = [];
  /**
   * The layout's sensors, drawn as labelled diamonds.
   *
   * Display only, like `calibrationPoints`. Sensors are per **layout**, not per
   * image, so the same list is drawn over every frame — that is the point of
   * placing one. The live view passes the same list, with {@link sensorStates}
   * beside it.
   */
  @property({ attribute: false }) sensors: readonly Sensor[] = [];
  /**
   * L1 for the sensors above, keyed by `id`, or `null` where nothing is reading
   * them (#85).
   *
   * `null` and an empty map are **different**: `null` is the editor, where a
   * sensor is being placed rather than answered and the symbol keeps its
   * authored amber. An empty map would be a live view that answered no sensor,
   * which `occupancy()` cannot produce — it is total, one entry per sensor
   * always, including the whole-system `unknown` cases. So a sensor missing
   * from a non-null map is a bug upstream, and it draws stateless rather than
   * inventing a state to show.
   *
   * A map rather than a state on each `Sensor`, because a `Sensor` is manifest
   * data and L1 is not: writing the answer onto the object drawn would put a
   * per-frame reading inside the thing the editor saves.
   */
  @property({ attribute: false }) sensorStates: ReadonlyMap<string, SensorState> | null = null;
  /**
   * L0 for this frame: every car the detector found, in `resolution`
   * coordinates.
   *
   * Display only and **not** manifest data — unlike `cars`, which are authored
   * labels. Nothing here has an identity that survives a frame: the model emits
   * a fixed 300-slot buffer that is re-decoded every time, so there is no id to
   * key on and nothing to diff against the previous list.
   *
   * Empty in the editor, which shows what a human authored rather than what a
   * model predicted. Drawn from `boxCorners` at the model's own width — see
   * `carMarker.ts` § `renderDetection` for why that is not the DPT-derived one.
   */
  @property({ attribute: false }) detections: readonly Detection[] = [];
  /**
   * Per-detection ink, parallel to {@link detections} (#87).
   *
   * A short array reads as "no override" — the live view passes nothing and
   * gets the shared car ink, unfilled. The diagnostics view passes each box's
   * verdict colour. Parallel arrays rather than a richer per-detection object
   * for the reason `rr-thumbnail-bar.complete` is one: a `Detection` is the
   * model's output and colouring is the caller's opinion of it, and putting the
   * opinion inside the data would make the viewer's input something no
   * detector produces.
   */
  @property({ attribute: false }) detectionInks: readonly (string | null)[] = [];
  /** Per-car ink, parallel to {@link cars}. Same rule (#87). */
  @property({ attribute: false }) carInks: readonly (string | null)[] = [];
  /**
   * The current image's car labels, drawn as a chord inside a width rectangle.
   *
   * Display only, like `calibrationPoints` and `sensors`. Cars are per
   * **image**, so this is the labels of the image `src` is showing and switching
   * images swaps the whole list — nothing is carried between images
   * (`SPEC.md` § No copy-forward). Empty in the live view, which shows
   * detections rather than labels.
   */
  @property({ attribute: false }) cars: readonly CarLabel[] = [];
  /**
   * The chain in flight — the anchor and the pointer — or `null` when none is.
   *
   * The **rubber band**, and the only thing this component draws that is not in
   * the manifest. That is deliberate rather than an exception: a live chain is
   * view state (`SPEC.md` § Undo and redo), so it is passed in as view state
   * and written nowhere. The editor owns the state; the viewer, as ever,
   * authors nothing.
   *
   * Empty in the live view, which places no cars.
   */
  @property({ attribute: false }) pendingCar: PendingCar | null = null;
  /**
   * The layout's DPT, or `null` when calibration does not resolve one.
   *
   * The one property here that is neither media nor a thing to draw: it is the
   * **scale** the world-sized symbols are drawn at. A sensor is one track width
   * across (`geometry.ts` § `trackWidthPx`) and a car will be 2.09, so both
   * shrink with the photograph rather than staying a constant size on screen —
   * which is what makes a sensor's footprint comparable to the cars around it.
   *
   * `null` is a real state, not an error: an archive can carry sensors and no
   * calibration, since deleting a calibration point is allowed at any time. The
   * symbols then fall back to the screen-constant size, so they stay visible
   * and grabbable instead of vanishing at a size nothing can compute. Both
   * cases live in `geometry.ts`'s `sensorDiameterPx`, which the editor's
   * hit-test reads too — what is drawn is what is grabbable.
   */
  @property({ attribute: false }) dpt: number | null = null;
  /**
   * The objects a reveal is pointing at, or `null` when none is.
   *
   * Transient view state, like `pendingCar` and unlike everything else drawn
   * here: nothing about a highlight is in the manifest, and the editor takes it
   * away again on a timer. `null` in the live view, which has no history.
   */
  @property({ attribute: false }) highlight: ViewerHighlight | null = null;
  /**
   * The region of the authored frame on screen, or `null` for the whole of it
   * (#44).
   *
   * Transient view state like `pendingCar` and `highlight`: the editor owns it,
   * nothing about it is in the manifest, and it never enters the history
   * (`SPEC.md` § Undo and redo names zoom explicitly). **`null` is fit** —
   * literally the absence of a zoom, which is exactly what this element
   * rendered before the property existed, rather than a rect computed from the
   * frame.
   *
   * In **authored-frame** pixels, so one rect stays meaningful across every
   * image of an archive even where the images differ in pixel size. It is
   * applied as one transform above the media *and* the overlay, so the two
   * stay one box and every screen-pixel tolerance downstream stays correct
   * with no arithmetic changed.
   *
   * `null` in the live view, which sets no zoom: the capability is free there
   * because it is a property here, but nothing wires a control to it (#44).
   */
  @property({ attribute: false }) zoom: Rect | null = null;
  /**
   * The zoom rect being dragged out, or `null` when none is.
   *
   * The band, and the zoom's counterpart to `pendingCar`: the editor decides
   * what the gesture means and this element draws the feedback. Drawn in the
   * overlay with a screen-constant stroke, in the same frame as everything else
   * — never as an HTML box positioned in screen coordinates.
   */
  @property({ attribute: false }) zoomPreview: Rect | null = null;
  @property({ type: Object }) resolution: FrameSize = { width: 1920, height: 1080 };

  /**
   * Image pixels per screen pixel, as the viewport currently lays out.
   *
   * The state the `ResizeObserver` keeps, rather than `symbolSize` directly:
   * it is the *conversion*, so both a screen-constant symbol and a world-sized
   * one derive from one number, and it is the same quantity every pointer event
   * reports — which is what lets the hit-test size a grab the way the renderer
   * sized the symbol.
   */
  @state() private imagePxPerScreenPx = 1;

  /**
   * The loaded media's own pixel size, or `null` until it reports one.
   *
   * The overlay's viewBox, so that the SVG and the media letterbox into the
   * **same** box: two boxes fitted by the same rule coincide only while their
   * aspect ratios agree, and `resolution` is per archive while the images are
   * per image (#41). Until an image decodes there is nothing to follow and the
   * authored frame stands in — which is what the viewer always did.
   */
  @state() private mediaSize: FrameSize | null = null;

  /**
   * The viewport's size in screen pixels, or zeros until it has laid out.
   *
   * What the zoom transform is computed against: fitting a rect into a box
   * needs the box's aspect ratio, and no CSS length expresses that. Zeros are
   * the honest answer before layout — jsdom, a hidden pane — and
   * {@link zoomTransform} answers them with the identity rather than a
   * transform derived from a box that does not exist.
   */
  @state() private viewportSize: Size = { width: 0, height: 0 };

  @query('svg') private svgElement!: SVGSVGElement;
  /** The box the media letterboxes into — what {@link viewportSize} measures. */
  @query('.viewport') private viewportElement!: HTMLElement;
  /**
   * The group the overlay's content lives in — the authored frame, scaled onto
   * the media's pixel grid.
   *
   * Every coordinate the viewer emits or draws is in **its** user space, not
   * the SVG's, so this and not `svgElement` is what a pointer converts through.
   */
  @query('g.frame') private frameGroup!: SVGGElement;

  private resizeObserver: ResizeObserver | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver(() => {
      // Use requestAnimationFrame to avoid "update during update" warnings
      // especially when this is triggered during the first mount
      window.requestAnimationFrame(() => this.measureScale());
    });
    this.resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
  }

  /**
   * Measure as soon as there is something laid out to measure.
   *
   * The `ResizeObserver` is not enough on its own: its callback defers through
   * `requestAnimationFrame`, and a frame that never comes — a hidden pane, a
   * background tab, an occluded window — leaves every screen-constant symbol at
   * the ratio it was initialised with, so crosshairs and labels render at
   * whatever size the *image* pixels happen to be. Measuring here costs one
   * matrix read at mount and makes the first paint right.
   */
  protected firstUpdated() {
    this.measureScale();
  }

  /**
   * A new image is a new pixel grid, and the old one must not outlive it.
   *
   * Cleared on the way *in*, before the render that would draw with it: a
   * viewBox left at the previous image's size draws every object of the new one
   * against a frame it was never authored in.
   */
  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('src') || changed.has('stream')) this.mediaSize = null;
  }

  /**
   * The scale changed, so the measurement did — and no `ResizeObserver` fires
   * for it. The media's size is not the element's, and neither is the **zoom**:
   * a zoom moves the frame group's transform without the element resizing at
   * all, and every screen-constant symbol is sized off that transform.
   */
  protected updated(changed: Map<string, unknown>) {
    if (!changed.has('mediaSize') && !changed.has('resolution') && !changed.has('zoom')) return;
    // Deferred a frame, exactly as the `ResizeObserver` defers: the new
    // transform is not in the DOM until this update has painted, and measuring
    // it here would both read the old one and schedule a second update out of a
    // completed one, which Lit says out loud.
    window.requestAnimationFrame(() => this.measureScale());
  }

  /**
   * The transform the authored frame is on screen through, or `null` when there
   * is none — jsdom, a detached element, before the first layout.
   *
   * The **content group's**, not the SVG's: the group carries the scale that
   * puts the authored frame on the media's pixel grid, so its user space is the
   * frame the manifest is written in and the SVG's is not.
   */
  private frameMatrix(): DOMMatrix | null {
    return this.frameGroup?.getScreenCTM?.() ?? null;
  }

  /**
   * Image pixels per screen pixel, off one matrix.
   *
   * `a` and never `d`: the overlay does not rotate or skew, so the horizontal
   * scale is the whole story — and it stays the horizontal one under an aspect
   * mismatch, where the two differ and a grab radius has to pick a direction.
   */
  private static scaleOf(ctm: DOMMatrix): number {
    return 1 / ctm.a;
  }

  /**
   * Re-measure `imagePxPerScreenPx` from the laid-out overlay.
   *
   * Off the same transform every pointer event reports, and for the same
   * reason: the SVG's bounding rect is the whole element, letterbox bars
   * included, so a ratio taken from it is wrong by the letterbox whenever the
   * viewport's aspect ratio differs from the image's (#41) — the very thing
   * `ui/CLAUDE.md` forbids hand-rolling.
   */
  private measureScale() {
    // First, and outside the guard below: the viewport has a size well before
    // there is a media transform to read, and the zoom transform is computed
    // from it.
    this.measureViewport();

    const ctm = this.frameMatrix();
    // Zero before layout. The previous value is a better answer than one
    // derived from a matrix that has not been laid out.
    if (!ctm?.a) return;

    const ratio = RrViewer.scaleOf(ctm);
    if (this.imagePxPerScreenPx !== ratio) {
      this.imagePxPerScreenPx = ratio;
    }
  }

  /**
   * Re-measure the viewport, and say so when it changed.
   *
   * Reported as an event because the editor needs the same number for the zoom
   * cap and cannot measure it — it does not own this element's box. Only a
   * *change* is announced, so a resize storm costs one event per distinct size
   * and a browser that lays nothing out (jsdom) announces nothing at all.
   */
  private measureViewport() {
    const rect = this.viewportElement?.getBoundingClientRect?.();
    if (!rect) return;
    if (rect.width === this.viewportSize.width && rect.height === this.viewportSize.height) return;

    this.viewportSize = { width: rect.width, height: rect.height };
    this.dispatchEvent(
      new CustomEvent<ViewerViewportDetail>('rr-viewport', {
        detail: this.viewportSize,
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * The media reported its own size. Record it, and say whether it is the shape
   * the archive claims.
   */
  private onMediaLoad(e: Event) {
    const el = e.currentTarget as HTMLImageElement | HTMLVideoElement;
    const media =
      el instanceof HTMLVideoElement
        ? { width: el.videoWidth, height: el.videoHeight }
        : { width: el.naturalWidth, height: el.naturalHeight };
    if (media.width <= 0 || media.height <= 0) return;

    this.mediaSize = media;
    this.dispatchEvent(
      new CustomEvent<ViewerMediaFrameDetail>('rr-media-frame', {
        detail: {
          media,
          frame: this.resolution,
          aspectMismatch: overlayFit(media, this.resolution).aspectMismatch,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * A screen-constant symbol, in image pixels: what markers, crosshairs and
   * every label are drawn at, whatever the zoom.
   */
  private get symbolSize(): number {
    return SYMBOL_SIZE_SCREEN_PX * this.imagePxPerScreenPx;
  }

  /**
   * Screen coordinates to image pixels, through the SVG's own transform.
   *
   * `createSVGPoint` + the inverse of {@link frameMatrix}, and never a
   * hand-rolled subtraction of `getBoundingClientRect()`: the rect ignores the
   * letterbox
   * that `preserveAspectRatio="xMidYMid meet"` introduces, so the hand-rolled
   * version is correct only while the viewport happens to match the image's
   * aspect ratio and drifts silently as soon as it does not.
   *
   * Returns `null` where SVG geometry is unavailable — an unattached element,
   * or jsdom, which implements none of it.
   */
  private toImagePoint(
    clientX: number,
    clientY: number
  ): { point: Point; imagePxPerScreenPx: number } | null {
    const svg = this.svgElement;
    if (!svg?.createSVGPoint) return null;
    const ctm = this.frameMatrix();
    if (!ctm) return null;

    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const { x, y } = pt.matrixTransform(ctm.inverse());
    return { point: { x, y }, imagePxPerScreenPx: RrViewer.scaleOf(ctm) };
  }

  /**
   * Converts, then dispatches. All five events go through here, so there is one
   * place the detail is assembled and one place the conversion can be missed.
   *
   * @returns `false` when there was no transform to convert with, and so
   *          nothing was emitted.
   */
  private reportGesture(name: ViewerPointerEventName, originalEvent: PointerEvent): boolean;
  private reportGesture(name: 'rr-pointer-contextmenu', originalEvent: MouseEvent): boolean;
  private reportGesture(name: string, originalEvent: PointerEvent | MouseEvent): boolean {
    const converted = this.toImagePoint(originalEvent.clientX, originalEvent.clientY);
    if (!converted) return false;
    this.dispatchEvent(
      new CustomEvent<ViewerPointerDetail | ViewerContextMenuDetail>(name, {
        detail: { ...converted, originalEvent } as ViewerPointerDetail | ViewerContextMenuDetail,
        bubbles: true,
        composed: true,
      })
    );
    return true;
  }

  private onPointerDown(e: PointerEvent) {
    // Capture on the overlay, so a drag that wanders off the element — or off
    // the window — still delivers its move and up events here. Without it a
    // gesture can end somewhere the consumer never hears about, leaving a drag
    // live and the next press starting a second one on top of it.
    //
    // Only for a gesture that was actually reported: a capture held for a
    // gesture nobody heard about would divert the events that follow it to an
    // element with no listener.
    if (this.reportGesture('rr-pointer-down', e)) {
      this.svgElement?.setPointerCapture?.(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent) {
    this.reportGesture('rr-pointer-move', e);
  }

  private onPointerUp(e: PointerEvent) {
    this.reportGesture('rr-pointer-up', e);
    this.releaseCapture(e.pointerId);
  }

  /**
   * The browser took the gesture away — a touch interrupted, a system gesture.
   * Reported separately rather than folded into `up`, because a consumer that
   * commits on `up` must not commit on a gesture that never finished.
   */
  private onPointerCancel(e: PointerEvent) {
    this.reportGesture('rr-pointer-cancel', e);
    this.releaseCapture(e.pointerId);
  }

  private onContextMenu(e: MouseEvent) {
    this.reportGesture('rr-pointer-contextmenu', e);
  }

  /**
   * Guarded, and after the gesture's end event rather than before it:
   * releasing a capture the element does not hold throws, and a throw ahead of
   * the dispatch would leave the consumer's drag live with nothing to end it.
   */
  private releaseCapture(pointerId: number) {
    const svg = this.svgElement;
    if (svg?.hasPointerCapture?.(pointerId)) svg.releasePointerCapture(pointerId);
  }

  /**
   * The two sizes a sensor is drawn at: a world diameter and a screen label.
   *
   * Assembled here because this is the only place both numbers exist — `dpt`
   * comes down as a property and `symbolSize` is measured off the viewport.
   * With no DPT the diamond falls back to the screen size, which is what keeps
   * the sensors of an uncalibrated archive on screen and grabbable.
   */
  private sensorSize(): SensorSymbolSize {
    return {
      diameterPx: sensorDiameterPx(this.dpt, this.imagePxPerScreenPx),
      labelPx: this.symbolSize * LABEL_SIZE_RATIO,
    };
  }

  /**
   * The three sizes a car is drawn at: the DPT its rectangle is derived from, a
   * screen-constant handle, and a screen-constant warning label.
   *
   * The DPT is passed rather than a width, because the derivation — 2.09 track
   * widths, in every scale — belongs in one place (`geometry.ts` § `carWidthPx`),
   * and `null` is a real state the renderer answers by drawing no rectangle.
   * The label shares `LABEL_SIZE_RATIO` with the sensor's name and the
   * crosshair's coordinate: they are the same kind of annotation.
   */
  private carSize(): CarSymbolSize {
    return {
      dpt: this.dpt,
      handlePx: this.symbolSize * CAR_HANDLE_SIZE_RATIO,
      labelPx: this.symbolSize * LABEL_SIZE_RATIO,
    };
  }

  /**
   * The warning a car's class earns, or `null` when the vocabulary names it.
   *
   * Derived here rather than passed in, for the same reason a coupling is: it
   * is a property of the label this component was handed and of a build-time
   * constant, so there is nothing for a parent to compute or to keep in sync.
   * `class` is unvalidated at parse time on purpose (`SPEC.md` § Format), which
   * is exactly what makes a **visible** warning the editor's job.
   */
  private carWarning(car: CarLabel): CarWarning | null {
    return isKnownClass(car.class) ? null : { text: car.class, frame: this.resolution };
  }

  /**
   * The zoom rect being dragged out, dashed, over everything else.
   *
   * Last in the overlay for the same reason the rubber band is last of the car
   * layer: it is the gesture in flight, and it has to be legible over whatever
   * it is being drawn across.
   */
  private renderZoomBand(rect: Rect): SVGTemplateResult {
    const stroke = this.symbolSize * ZOOM_BAND_STROKE_RATIO;
    return svg`<rect
      class="zoom-band"
      x=${rect.x}
      y=${rect.y}
      width=${rect.width}
      height=${rect.height}
      stroke-width=${stroke}
      stroke-dasharray="${stroke * 3} ${stroke * 2}"
    />`;
  }

  render() {
    // Derived here rather than passed in: a coupling is exact coincidence
    // between two cars (`geometry.ts` § `couplerPoints`), so it is a property
    // of the list this component was handed and there is nothing for a parent
    // to compute. One handle is drawn per coincident pixel, and the cars
    // underneath leave their own handles off — see `carMarker.ts`.
    const couplers = couplerPoints(this.cars);
    const carSize = this.carSize();
    // The viewBox is the **media's** pixel grid, so the overlay letterboxes
    // into the box `object-fit: contain` puts the photograph in; the group
    // inside it carries the authored frame onto that grid. Before anything
    // loads the two are the same and the transform is the identity.
    const viewBoxSize = this.mediaSize ?? this.resolution;
    const fit = overlayFit(this.mediaSize, this.resolution);
    // One transform for the media and the overlay together, so the two stay one
    // box (#41) whatever the zoom is (#44). The identity when there is no zoom.
    const zoom = zoomTransform(this.zoom, this.mediaSize, this.resolution, this.viewportSize);

    return html`
      <div class="viewport">
       <div
        class="zoom-layer"
        style="--zoom-x: ${zoom.x}px; --zoom-y: ${zoom.y}px; --zoom-scale: ${zoom.scale}"
       >
        ${this.src ? html`<img .src=${this.src} @load=${this.onMediaLoad} />` : ''}
        ${this.stream
          ? html`<video
              .srcObject=${this.stream}
              autoplay
              playsinline
              @loadedmetadata=${this.onMediaLoad}
            ></video>`
          : ''}

        <svg
          viewBox="0 0 ${viewBoxSize.width} ${viewBoxSize.height}"
          preserveAspectRatio="xMidYMid meet"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerCancel}
          @contextmenu=${this.onContextMenu}
        >
          <g class="frame" transform="scale(${fit.sx}, ${fit.sy})">
            <!-- Cars first: their width rectangles are the only area fills here,
                 so drawing them underneath keeps a crosshair or a sensor placed
                 on a car visible instead of tinted over. -->
            ${this.cars.map((c, i) =>
              renderCar(
                c,
                carSize,
                coupledEnds(c, couplers),
                this.carWarning(c),
                this.highlight?.cars.includes(c.id) ?? false,
                this.carInks[i] ?? null
              )
            )}

            <!-- The shared handles, over the cars they join: one per coupling,
                 where the cars themselves drew none. -->
            ${couplers.map(at => renderCoupler(at, carSize))}

            <!-- The rubber band last of the car layer, so the chain in flight is
                 legible over the train it is being added to. -->
            ${this.pendingCar ? renderPendingCar(this.pendingCar, carSize) : ''}

            <!-- L0, over the authored cars and under everything else: the two
                 are drawn together only in the archive diagnostics, and there
                 the prediction is what is being read *against* the label, so it
                 goes on top of it. Sensors and crosshairs still win over both —
                 a point must never be buried under an area. -->
            ${this.detections.map((d, i) =>
              renderDetection(d, carSize, this.resolution, this.detectionInks[i] ?? null)
            )}

            ${this.calibrationPoints.map((p, i) =>
              // `resolution` is the group's user space, so it is also the frame
              // the label must stay inside — a point near an edge draws its
              // label inwards.
              renderCalibrationPoint(
                p,
                i,
                this.symbolSize,
                this.resolution,
                this.highlight?.calibration.includes(i) ?? false
              )
            )}

            ${this.sensors.map(s =>
              renderSensor(
                s,
                this.sensorSize(),
                this.resolution,
                this.highlight?.sensors.includes(s.id) ?? false,
                this.sensorStates?.get(s.id) ?? null
              )
            )}

            <!-- The zoom band in flight, over every object it crosses. -->
            ${this.zoomPreview ? this.renderZoomBand(this.zoomPreview) : ''}
          </g>
        </svg>
       </div>
      </div>
    `;
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.shadowRoot?.querySelector('video') || null;
  }

  getImageElement(): HTMLImageElement | null {
    return this.shadowRoot?.querySelector('img') || null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-viewer': RrViewer;
  }

  // The events are typed at the listener, not just at the dispatch: they cross
  // the shadow boundary and are handled two components up, where an untyped
  // `CustomEvent` would have to be cast back into shape by hand.
  interface HTMLElementEventMap {
    'rr-pointer-down': CustomEvent<ViewerPointerDetail>;
    'rr-pointer-move': CustomEvent<ViewerPointerDetail>;
    'rr-pointer-up': CustomEvent<ViewerPointerDetail>;
    'rr-pointer-cancel': CustomEvent<ViewerPointerDetail>;
    'rr-pointer-contextmenu': CustomEvent<ViewerContextMenuDetail>;
    'rr-media-frame': CustomEvent<ViewerMediaFrameDetail>;
    'rr-viewport': CustomEvent<ViewerViewportDetail>;
  }
}
