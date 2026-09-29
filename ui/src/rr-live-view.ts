import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import type { R49Archive } from '@occupancy/r49';
import { getDPT } from '@occupancy/r49';
import { MAX_DRIFT_TRACK_FRACTION } from '@occupancy/config';
import { occupancy } from '@occupancy/detector';
import type { Detection, Frame, SensorState } from '@occupancy/detector';
import type { Detector } from '@occupancy/detector/browser';
import type { DriftResult } from '@occupancy/drift';
import { getCameraStream } from './capture.js';
import { openDetector, DETECTOR_SOURCE } from './detectorSession.js';
import { grabPlane, maxDriftPx, openDriftCheck } from './driftSession.js';
import type { DriftSession } from './driftSession.js';
import './rr-viewer.js';
import './rr-stats-bar.js';

import type { RrViewer } from './rr-viewer.js';

/** What `camera.resolution` stands in as when an archive declares none. */
const DEFAULT_RESOLUTION: Frame = { width: 1920, height: 1080 };

/**
 * How long to wait after one drift sample before taking the next.
 *
 * Not per frame: a check is **~0.27 s** against the archive's single reference
 * image (measured on the 2017 i7 in Chrome), where the detector is tens of
 * milliseconds against one graph. It is also measuring something that changes on
 * the timescale of somebody knocking the tripod — sampling it at 30 Hz would spend
 * the whole frame budget confirming that furniture has not moved. At 3 s that is
 * under a 10% duty cycle.
 *
 * It was ~0.9 s while every archive image was a reference; one reference (#118)
 * bought that back, which is a happy side effect of a change made for correctness.
 *
 * Measured from the end of the previous sample rather than the start, so a slow
 * device stretches the gap instead of queueing checks it cannot finish.
 */
const DRIFT_SAMPLE_INTERVAL_MS = 3000;

/**
 * The live view: camera stream, detector, and the two layers of the occupancy
 * output drawn over it.
 *
 * **This is the occupancy contract, not a demo.** What stood here before ran
 * the CNN once per sensor point and emitted marker glyphs — SPEC's "Testing and
 * Demo" item, explicitly not the contract. It is gone (#7, #85). The loop now
 * runs the detector **once per frame** and derives every sensor from its output
 * by pure geometry, which is what `SPEC.md` § Occupancy Output specifies: L1 is
 * a function of L0, never a second model, so it cannot contradict the boxes
 * drawn beside it and it costs the same for three sensors or three hundred.
 *
 * **The loop runs whether or not a model loaded.** That is not resilience for
 * its own sake: `occupancy()` is total, and with `detections: null` it answers
 * every sensor `unknown` / `no-model` — which is a state SPEC names and the
 * user needs to see. Suppressing the loop instead would leave the last frame's
 * answers on screen, which is the one thing worse than saying nothing.
 *
 * **On drift, it refuses L1 and keeps L0** (#94). The detector goes on running
 * and the dashed boxes go on being drawn, because they are computed *in the live
 * frame* and are true of it; what a moved camera invalidates is the mapping from
 * those boxes onto sensors, which were authored in the archive's frame. So every
 * sensor reads `unknown` / `drift` while the boxes stay — and the sensor
 * diamonds visibly sitting off the track beside correct boxes is the clearest
 * available statement of *why* the view is refusing. Occupancy is
 * machine-consumable, so withholding it is the honest response where a banner
 * alone would not be; the banner is for the human, and it carries the override.
 *
 * **Properties:** `archive`.
 */
@customElement('rr-live-view')
export class RRLiveView extends LitElement {
  @property({ attribute: false }) archive: R49Archive | null = null;

  @state() private _stream: MediaStream | null = null;
  /** L0 for the frame on screen. Empty, not stale, when no model is loaded. */
  @state() private _detections: readonly Detection[] = [];
  /** L1 for the same frame, keyed by sensor id — total, one entry per sensor. */
  @state() private _sensorStates: ReadonlyMap<string, SensorState> = new Map();
  @state() private _fps = 0;
  @state() private _inference = 0;
  /**
   * The layout's DPT, or `null` when calibration resolves none.
   *
   * Resolved when the archive arrives rather than once per frame, and that is
   * what makes the "no calibration" notice honest: computed in the loop it
   * would start at `null` and stay there for any session where no frame ever
   * runs — a camera that was refused, a stream that never reaches `readyState`
   * 2 — and accuse a perfectly calibrated layout. The live view never edits the
   * manifest, so nothing else can move it.
   */
  @state() private _dpt: number | null = null;
  /**
   * Why the detector is not loaded, or `null` when it is.
   *
   * Held as the message rather than a boolean: the causes are different jobs —
   * a fresh clone has never run `export_onnx.py`, a deployed bundle that 404s
   * was built without the model — and the sensors all read `unknown` either
   * way, which says nothing about which.
   */
  @state() private _modelError: string | null = null;
  /**
   * The most recent drift measurement, or `null` before the first one lands.
   *
   * `null` is "not measured yet", never "steady" — which is why the refusal
   * reads it as such. A session's first few seconds run unrefused because
   * nothing has been measured, not because something was.
   */
  @state() private _drift: DriftResult | null = null;
  /**
   * Why drift cannot be measured, or `null` when it can.
   *
   * Distinct from `_drift === null`: this one says the check itself is
   * unavailable — an archive with no images, a decode that failed — and a view
   * that cannot measure drift must not imply that it found none.
   */
  @state() private _driftError: string | null = null;
  /**
   * Whether the user has overridden the refusal for this session.
   *
   * The override exists because the check's false-positive rate is young: every
   * number behind `layout.max_drift_track_fraction` comes from synthetic warps,
   * and a live camera brings rolling shutter and autofocus that no warp
   * reproduces (#89 § Notes). It is deliberately **not** sticky across a
   * remount — a new session should start by telling the truth again.
   */
  @state() private _overrideDrift = false;

  @query('rr-viewer') private _viewer!: RrViewer;

  private _detector: Detector | null = null;
  private _driftSession: DriftSession | null = null;
  private _driftInFlight = false;
  private _driftSampledAt = 0;
  private _running = false;
  private _lastFrameTime = 0;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      height: 100%;
      position: relative;
      background: var(--sl-color-neutral-0);
    }

    rr-viewer {
      flex-grow: 1;
    }

    .notice {
      padding: 0.5rem 1rem;
      background: var(--sl-color-warning-100);
      color: var(--sl-color-warning-800);
      font-size: 0.9rem;
    }

    /* A refusal is louder than the two notices above it, and deliberately: they
       report a capability that is missing, this reports an answer being
       withheld from a system that could otherwise give one. */
    .notice.refusing {
      background: var(--sl-color-danger-100);
      color: var(--sl-color-danger-800);
    }

    .notice button {
      margin-left: 0.75rem;
      padding: 0.15rem 0.6rem;
      font: inherit;
      color: inherit;
      background: color-mix(in srgb, currentColor 12%, transparent);
      border: 1px solid currentColor;
      border-radius: 4px;
      cursor: pointer;
    }
  `;

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('archive')) {
      const manifest = this.archive?.getManifest();
      this._dpt = manifest ? getDPT(manifest) : null;
    }
  }

  async connectedCallback() {
    super.connectedCallback();
    await this._startCamera();
    this._startDetection();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopCamera();
    this._running = false;
    void this._detector?.dispose();
    this._detector = null;
    // Nothing to dispose — a drift check holds only JS memory — but dropping it
    // is what stops an in-flight sample from writing state into a detached view.
    this._driftSession = null;
  }

  private async _startCamera() {
    try {
      this._stream = await getCameraStream();
    } catch (err) {
      console.error('Failed to access camera', err);
    }
  }

  private _stopCamera() {
    if (this._stream) {
      this._stream.getTracks().forEach(track => track.stop());
      this._stream = null;
    }
  }

  private async _startDetection() {
    if (!this.archive) return;
    this._running = true;

    try {
      // The runtime path and the crossOriginIsolated warning live in
      // `detectorSession.ts`, which the diagnostics view shares (#87).
      this._detector = await openDetector();
      this._modelError = null;
    } catch (err) {
      // Not fatal, and deliberately so — see the class comment. The loop starts
      // anyway and every sensor reports `unknown` / `no-model`.
      this._modelError = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load the detector from ${DETECTOR_SOURCE}`, err);
    }

    await this._openDriftCheck();

    this._loop();
  }

  /**
   * Prepare the drift check, before the loop starts.
   *
   * Awaited rather than raced with the first frames: the per-reference FFTs are
   * the expensive half, and doing them while the loop is already running would
   * put a multi-hundred-millisecond stall into the first second of a session for
   * no gain — the loop cannot refuse on a measurement that does not exist yet
   * either way.
   *
   * A failure here is not fatal, for the same reason a missing model is not: the
   * view still has a job. It reports that drift is unmeasured, which is a weaker
   * claim than reporting no drift and the only honest one available.
   */
  private async _openDriftCheck() {
    if (!this.archive) return;
    try {
      this._driftSession = await openDriftCheck(this.archive);
      this._driftError =
        this._driftSession === null
          ? 'this layout has no images to compare the camera against'
          : null;
    } catch (err) {
      this._driftSession = null;
      this._driftError = err instanceof Error ? err.message : String(err);
      console.error('Failed to prepare the camera-drift check', err);
    }
  }

  /**
   * The media element the frame is read from, once it has one to read, with the
   * intrinsic size it decoded at.
   *
   * The readiness check is here rather than inside `detect`, which throws on a
   * source with no dimensions: a video before its metadata arrives is the
   * normal first few frames of a session, not an error to report.
   *
   * The size comes out with it because the drift check needs to grab the frame
   * into a canvas, and the *intrinsic* size is the one to grab at — not
   * `camera.resolution`. A phone that ignored the requested 1920x1080 hands back
   * whatever it felt like; the drift check normalizes resolution internally, so
   * feeding it the real pixels loses nothing, where scaling them to a declared
   * frame first would resample twice.
   */
  private _readySource(): { source: CanvasImageSource; width: number; height: number } | null {
    const video = this._viewer?.getVideoElement();
    if (video) {
      return video.readyState >= 2 && video.videoWidth > 0
        ? { source: video, width: video.videoWidth, height: video.videoHeight }
        : null;
    }

    const img = this._viewer?.getImageElement();
    if (img) {
      return img.complete && img.naturalWidth > 0
        ? { source: img, width: img.naturalWidth, height: img.naturalHeight }
        : null;
    }

    return null;
  }

  /**
   * The drift tolerance for this layout, in `camera.resolution` pixels, or
   * `null` when no DPT resolves.
   *
   * A fraction of a track width, so it depends on the layout's scale and on how
   * close the camera is — see `driftSession.maxDriftPx`. `null` withholds the
   * verdict rather than defaulting it: an uncalibrated layout already reports
   * every sensor `unknown` / `no-calibration`, and inventing a pixel tolerance
   * for it would be a second wrong answer in a quieter voice.
   */
  private get _driftTolerancePx(): number | null {
    return maxDriftPx(this._dpt);
  }

  /**
   * Whether the camera has moved further than the layout tolerates.
   *
   * `false` until something has been measured. An unmeasured session is not a
   * steady one, but it is also not evidence of drift, and the notice says which
   * of the two it is rather than letting this boolean imply either. Also `false`
   * when no tolerance resolves — see `_driftTolerancePx`.
   */
  private get _drifted(): boolean {
    const tolerance = this._driftTolerancePx;
    return this._drift !== null && tolerance !== null && this._drift.displacementPx > tolerance;
  }

  /** Drift found, and not overridden — the state that withholds L1. */
  private get _refusing(): boolean {
    return this._drifted && !this._overrideDrift;
  }

  /**
   * Take a drift sample if one is due, without blocking the frame.
   *
   * Deliberately not awaited by the caller. A check yields to the host between
   * references (`@occupancy/drift`'s async signature is reserved for exactly
   * this), so leaving it to run alongside the render loop costs the loop a few
   * interleaved milliseconds instead of the whole check — and the loop keeps
   * drawing L0 and reporting the refusal from the *previous* sample while the
   * next one is computed.
   *
   * Runs while refusing too. Nothing else would ever clear a refusal: putting
   * the camera back is the fix, and a gate that stopped measuring the moment it
   * fired could not see it happen.
   */
  private _maybeSampleDrift(source: CanvasImageSource, width: number, height: number) {
    const session = this._driftSession;
    if (!session || this._driftInFlight) return;
    if (this._drift !== null && performance.now() - this._driftSampledAt < DRIFT_SAMPLE_INTERVAL_MS) {
      return;
    }

    this._driftInFlight = true;
    void (async () => {
      try {
        // The grab is synchronous and must happen now, on this frame: awaiting
        // first would measure whatever the camera was pointing at by the time
        // the check got round to it.
        const plane = grabPlane(source, width, height);
        const result = await session.check.check(plane);
        // A view that was disconnected mid-check, or handed a different archive,
        // must not take the answer: it is about references this view no longer
        // holds.
        if (this._running && this._driftSession === session) {
          this._drift = result;
          this._driftError = null;
        }
      } catch (err) {
        if (this._running && this._driftSession === session) {
          this._driftError = err instanceof Error ? err.message : String(err);
        }
        console.error('Camera-drift check failed for this frame', err);
      } finally {
        this._driftInFlight = false;
        this._driftSampledAt = performance.now();
      }
    })();
  }

  private async _loop() {
    if (!this._running || !this.archive) return;

    const ready = this._readySource();
    if (!ready) {
      requestAnimationFrame(() => this._loop());
      return;
    }
    const { source } = ready;

    this._maybeSampleDrift(source, ready.width, ready.height);

    const startTime = performance.now();
    if (this._lastFrameTime) this._fps = 1000 / (startTime - this._lastFrameTime);
    this._lastFrameTime = startTime;

    const manifest = this.archive.getManifest();
    // The frame every coordinate is authored in (`SPEC.md` § Output encoding).
    // `detect` is asked to answer in it, so the capture's own pixel count — a
    // phone that ignored the requested 1920x1080 — never reaches this file.
    const frame = manifest.camera.resolution ?? DEFAULT_RESOLUTION;

    // `null` is the distinction `occupancy` reads: no model at all, rather than
    // a model that found nothing. An empty array would report every sensor
    // `clear`, which is the confident-looking miss SPEC forbids.
    let detections: readonly Detection[] | null = null;
    if (this._detector) {
      const before = performance.now();
      try {
        detections = await this._detector.detect(source, frame);
        // The detect call alone — preprocessing, the session, the decode. Not
        // the whole frame: L1 and the render are the part that scales with the
        // layout, and folding them in would hide which one is slow.
        this._inference = performance.now() - before;
      } catch (err) {
        // A frame that fails is one frame. Keep the loop alive and report
        // `unknown` for it rather than freezing the last answer on screen.
        console.error('Detection failed for this frame', err);
      }
    }

    this._detections = detections ?? [];
    // L0 is handed over as found even while refusing — the boxes are true of the
    // frame they were computed in. `drifted` is what withholds L1, and it is
    // `occupancy()` that turns it into one `unknown` per sensor, so this view
    // never builds an unknown-map of its own (the whole reason that function is
    // total).
    this._sensorStates = occupancy({
      detections,
      sensors: manifest.layout.sensors,
      dpt: this._dpt,
      frame,
      drifted: this._refusing,
    });

    requestAnimationFrame(() => this._loop());
  }

  /** How many sensors read `occupied` — the number a controller would act on. */
  private get _occupiedCount(): number {
    let count = 0;
    for (const state of this._sensorStates.values()) {
      if (state.state === 'occupied') count++;
    }
    return count;
  }

  /**
   * The drift notice: the refusal, the override, or the fact that neither can be
   * said.
   *
   * Three states and no fourth. A measurement inside tolerance renders nothing —
   * "the camera has not moved" is what the view says by working, and a green bar
   * repeating it every session would train the user to stop reading this row,
   * which is where the refusal appears.
   *
   * The refusal names the number and not just the verdict, because the number is
   * what tells a nudged tripod from a camera somebody re-aimed at a different
   * layout — and because the tolerance is young enough that a user
   * deciding whether to trust it needs to see what it decided on.
   */
  private _renderDriftNotice() {
    if (this._driftError !== null) {
      return html`<div class="notice">
        Camera drift is <strong>not being checked</strong> — ${this._driftError}. Sensor states are
        reported as usual, so a camera that has moved since these images were shot will read wrong
        rather than say so.
      </div>`;
    }

    if (!this._drifted) return '';

    const px = this._drift!.displacementPx.toFixed(1);
    const tolerance = this._driftTolerancePx!.toFixed(1);
    const tracks = (this._drift!.displacementPx / this._dpt!).toFixed(2);
    const against = this._driftSession?.refName;
    // "against", not "closest match": there is one reference now — the archive's
    // first image — so there is nothing to have been closest among (#118).
    const reference = against ? html` (reference: <code>${against}</code>)` : '';

    if (this._overrideDrift) {
      return html`<div class="notice">
        Classifying despite <strong>${px} px</strong> of camera drift${reference} — sensor states may
        be wrong, because the sensors were authored against a view the camera no longer has.
        <button @click=${() => (this._overrideDrift = false)}>Refuse again</button>
      </div>`;
    }

    // Both units, because they answer different questions. The pixel count is
    // what to compare against the readout in the stats bar; the track-width
    // figure is what says whether a sensor can still be expected to sit on the
    // car it reads, which is the failure this tolerance is set from.
    return html`<div class="notice refusing">
      The camera has drifted <strong>${px} px</strong> from this layout's reference image${reference} —
      <strong>${tracks} track widths</strong>, past the ${tolerance} px
      (${MAX_DRIFT_TRACK_FRACTION} of a track) this layout allows.
      <strong>Refusing to classify</strong>: every sensor reads <strong>unknown</strong>, and the
      boxes below are still real. Re-aim the camera to the view the archive was shot from.
      <button @click=${() => (this._overrideDrift = true)}>Classify anyway</button>
    </div>`;
  }

  render() {
    const manifest = this.archive?.getManifest();
    const resolution = manifest?.camera.resolution ?? DEFAULT_RESOLUTION;

    return html`
      <rr-stats-bar
        .fps=${this._fps}
        .cars=${this._detections.length}
        .occupied=${this._occupiedCount}
        .inference=${this._inference}
        .alignment=${this._drift?.displacementPx ?? null}
        .alignmentTolerance=${this._driftTolerancePx}
      ></rr-stats-bar>

      ${this._modelError
        ? html`<div class="notice">
            No detector loaded, so every sensor reads <strong>unknown</strong>. Build one with
            <code>uv run python export_onnx.py</code> in <code>detector/</code>, then rebuild the
            UI. (${this._modelError})
          </div>`
        : ''}

      ${this._dpt === null
        ? html`<div class="notice">
            This layout has no calibration, so no DPT resolves and every sensor reads
            <strong>unknown</strong>. Cars are still detected — the boxes below are real; only the
            per-sensor answer needs the car width DPT derives. Place calibration points in the
            editor.
          </div>`
        : ''}

      ${this._renderDriftNotice()}

      <rr-viewer
        .stream=${this._stream}
        .detections=${this._detections}
        .sensors=${manifest?.layout.sensors ?? []}
        .sensorStates=${this._sensorStates}
        .dpt=${this._dpt}
        .resolution=${resolution}
      ></rr-viewer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-live-view': RRLiveView;
  }
}
