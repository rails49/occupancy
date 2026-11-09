import { LitElement, html, css } from 'lit';
import { lookTheme } from '@rails49/look';
import { customElement, property, state, query } from 'lit/decorators.js';
import type { R49Archive } from '@rails49/r49';
import { getDPT } from '@rails49/r49';
import type { Detection, Frame } from '@rails49/detector';
import type { DriftResult } from '@occupancy/drift';
import { cameraFrameSource } from './cameraFrameSource.js';
import { localModelResultSource } from './localModelResultSource.js';
import type {
  FrameSource,
  LiveSources,
  ResultSource,
  ServiceDetails,
  SourceFrame,
  SourceLayout,
} from './liveSources.js';
import type { SensorState } from './occupancy.js';
import {
  MAX_DRIFT_TRACK_FRACTION,
  driftVerdict,
  grabPlane,
  maxDriftPx,
  openDriftCheck,
} from './driftSession.js';
import type { DriftSession } from './driftSession.js';
import { downloadDriftCsv, driftCsvName, driftRow } from './driftRecording.js';
import type { DriftRow } from './driftRecording.js';
import './rr-viewer.js';
import './rr-stats-bar.js';
import './rr-service-details.js';

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
 * The live view: a frame, its occupancy answer, and the two layers of that
 * output drawn over the frame.
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
 * **"Record drift" keeps every sample** (#217): while on, each drift reading is
 * appended as a row, and turning it off or leaving the view downloads the rows
 * as a CSV. Recording goes on while refusing, as sampling does.
 *
 * **The frames and the answers come from sources** (#330). The loop asks a
 * `FrameSource` for a frame and a `ResultSource` for that frame's L0 and L1, so
 * a video file or a service can stand in for either without this file knowing
 * (#286, #331). `sources` is `null` for the camera and the model in this page,
 * and what stays here is the drift check, the notices, the recording, `_dpt`
 * and the frame rate — the view's own judgement, which is the same whatever is
 * answering.
 *
 * In service mode (sources that declare themselves a service's, #331) the view
 * runs no drift check and shows no recorder, alignment readout, or model and
 * DPT notices: the service publishes states this page cannot withhold. An
 * archive may be bound at the same time — the service's own, since #333 — and
 * it changes none of that. See `_judging`. In its
 * place a Details button opens `rr-service-details` below the viewer, and
 * while it is open the viewer draws the layout's tracks and the service is
 * asked for patches (#332).
 *
 * **Properties:** `archive`, `sources`.
 */
@customElement('rr-live-view')
export class RRLiveView extends LitElement {
  @property({ attribute: false }) archive: R49Archive | null = null;
  /**
   * Where frames and results come from, or `null` for the camera and the model
   * in this page.
   *
   * Read **on connect**, like the camera it replaces: the loop, the drift
   * check and the result source's lifetime all hang off one mount, and
   * swapping a source mid-session would mean tearing down and rebuilding all
   * three. A different source is a different session.
   */
  @property({ attribute: false }) sources: LiveSources | null = null;

  @state() private _stream: MediaStream | null = null;
  /**
   * The picture on screen, for a source whose frames arrive one at a time
   * (#331), or `null` for a stream and before the first frame.
   *
   * The URL is the source's: it created it and it releases it, and this holds
   * only what to show.
   */
  @state() private _src: string | null = null;
  /**
   * L0 for the frame on screen. Empty, not stale, when a model looked and found
   * nothing; `null` where the source published no L0 at all (#331) — then no
   * boxes are drawn and the stats bar shows no car count.
   */
  @state() private _detections: readonly Detection[] | null = null;
  /** L1 for the same frame, keyed by sensor id — total, one entry per sensor. */
  @state() private _sensorStates: ReadonlyMap<string, SensorState> = new Map();
  @state() private _fps = 0;
  /** Milliseconds in the last inference, or `null` where nothing has run one. */
  @state() private _inference: number | null = null;
  /** How far behind the picture the boxes over it are, or `null` without L0 (#331). */
  @state() private _l0Age: number | null = null;
  /**
   * What the source says about the answers it just gave, or `null` when it says
   * nothing (#331).
   *
   * Separate from `_sourceError`, which is why it cannot answer at all: this
   * one comes and goes with the frames — a service with nothing to send, a
   * request of its that failed — and has to clear itself when the next answer
   * lands.
   */
  @state() private _notice: string | null = null;
  /**
   * The layout the source answers against, or `null` where `archive` is it
   * (#331).
   *
   * Re-read on every frame, not once: a service re-reads its manifest when its
   * event stream reconnects, and a sensor that moved has to reach the viewer.
   */
  @state() private _sourceLayout: SourceLayout | null = null;
  /**
   * The archive's DPT, or `null` when its calibration resolves none.
   *
   * Resolved when the archive arrives rather than once per frame, and that is
   * what makes the "no calibration" notice honest: computed in the loop it
   * would start at `null` and stay there for any session where no frame ever
   * runs — a camera that was refused, a stream that never reaches `readyState`
   * 2 — and accuse a perfectly calibrated layout. The live view never edits the
   * manifest, so nothing else can move it.
   */
  @state() private _archiveDpt: number | null = null;
  /**
   * Why the result source cannot answer, or `null` when it can.
   *
   * Held as the message rather than a boolean: the causes are different jobs —
   * the published package holds no model yet, a deployed bundle that 404s
   * was built without the model — and the sensors all read `unknown` either
   * way, which says nothing about which. The notice still names the local
   * model, which is the only source that reports an error today.
   */
  @state() private _sourceError: string | null = null;
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
   * The override exists because the check's false-positive rate is young:
   * `MAX_DRIFT_TRACK_FRACTION` is set from one rig's stills
   * (`docs/research/drift-tolerance-basis.md`) and the bench's grades are
   * synthetic warps, while a live camera brings rolling shutter and autofocus
   * that neither reproduces (#89 § Notes). It is deliberately **not** sticky
   * across a remount — a new session should start by telling the truth again.
   */
  @state() private _overrideDrift = false;
  /** When recording started and the drift rows since, or `null` when not recording (#217). */
  @state() private _recording: { started: Date; rows: readonly DriftRow[] } | null = null;
  /** Whether the Details panel is open (#332). Closed each time the view opens. */
  @state() private _detailsOpen = false;
  /** What the service sent beyond L0 and L1 with the last answer, or `null` (#332). */
  @state() private _details: ServiceDetails | null = null;

  @query('rr-viewer') private _viewer!: RrViewer;

  private _frames: FrameSource | null = null;
  private _results: ResultSource | null = null;
  private _driftSession: DriftSession | null = null;
  private _driftInFlight = false;
  private _driftSampledAt = 0;
  private _running = false;
  private _lastFrameTime = 0;

  static styles = [
    lookTheme,
    css`
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

    .recorder,
    .details-bar {
      padding: 0.25rem 1rem;
      background: var(--sl-color-neutral-100);
      color: var(--sl-color-neutral-700);
      font-size: 0.9rem;
    }

    /* The table's width must not widen the view: the panel scrolls it. */
    rr-service-details {
      flex: 0 1 auto;
      max-height: 40%;
      contain: inline-size;
    }

    .notice button,
    .recorder button,
    .details-bar button {
      margin-left: 0.75rem;
      padding: 0.15rem 0.6rem;
      font: inherit;
      color: inherit;
      background: color-mix(in srgb, currentColor 12%, transparent);
      border: 1px solid currentColor;
      border-radius: 4px;
      cursor: pointer;
    }
  `,
  ];

  protected willUpdate(changed: Map<string, unknown>) {
    if (changed.has('archive')) {
      const manifest = this.archive?.getManifest();
      this._archiveDpt = manifest ? getDPT(manifest) : null;
    }
  }

  /**
   * The DPT everything here reads: the source's layout where it brings one,
   * this view's archive otherwise.
   *
   * A service's DPT is the service's manifest's, and it is what the service's
   * own boxes are sized by (#331). Nothing in this file resolves it twice, so
   * #166 stays one fix either way.
   */
  private get _dpt(): number | null {
    return this._sourceLayout ? this._sourceLayout.dpt : this._archiveDpt;
  }

  /**
   * Whether this page runs the model itself: the camera path, and a video file
   * standing in for it, with or without an archive. False in service mode,
   * which the sources declare (#331).
   *
   * The drift check, the recorder, the alignment readout, Cars and Inference
   * before a first answer, and the notices about a missing model or DPT belong
   * to the camera path only.
   *
   * It read "sources handed in and no archive" until #333. An archive opened
   * from the service is now bound to the page while the live view watches that
   * same service, so the absence of an archive no longer tells the two apart —
   * and measuring drift against the service's own archive would be this page
   * second-guessing the judgement it is only relaying.
   */
  private get _judging(): boolean {
    return this.sources?.service !== true;
  }

  async connectedCallback() {
    super.connectedCallback();
    // The frames are acquired whatever else happens, as the camera was: a
    // layout that is not loaded yet still shows what the camera sees.
    this._frames = this.sources?.frames ?? cameraFrameSource(() => this._viewer);
    this._results =
      this.sources?.results ?? (this.archive ? localModelResultSource(this.archive) : null);
    this._detailsOpen = false;
    this._results?.setPatches?.(false);
    await this._frames.start();
    // Left again while the frames were being acquired — the permission prompt
    // is a dialog the user can walk away from. `disconnectedCallback` has
    // already stopped the source; opening a model and decoding the drift
    // reference for a detached element would cost a WASM heap and hundreds of
    // milliseconds for a session that is over.
    if (!this.isConnected) return;
    this._stream = this._frames.stream;
    void this._run();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._running = false;
    this._frames?.stop();
    this._stream = null;
    // Leaving the view mid-recording downloads the rows rather than dropping them.
    this._stopRecording();
    this._results?.close();
    // Nothing to dispose — a drift check holds only JS memory — but dropping it
    // is what stops an in-flight sample from writing state into a detached view.
    this._driftSession = null;
  }

  /**
   * Open the result source, prepare the drift check, then run the loop.
   *
   * The result source is the one requirement, not the archive (#331): an
   * occupancy service brings its own layout, and what the view draws comes from
   * it whether or not an archive is bound as well. Without a source there is
   * nothing to ask — no archive and no service — and the frames go on showing
   * with nothing read off them.
   */
  private async _run() {
    if (!this._results) return;
    // Set before the awaits, so that leaving the view while a model is still
    // loading stops the loop before it starts.
    this._running = true;

    // A source that cannot answer is not fatal, and deliberately so — see the
    // class comment. The loop starts anyway and every sensor reports `unknown`.
    this._sourceError = await this._results.open();
    // Before the first frame, so the viewer draws the service's sensors rather
    // than none while the first `latest` is in flight.
    this._sourceLayout = this._results.layout ?? null;

    await this._openDriftCheck();

    await this._loop();
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
    // Not in service mode, whatever archive is bound: the service runs its own
    // check (#336), and since #333 the archive bound may be the service's own.
    if (!this._judging || !this.archive) return;
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
    return this._driftVerdict?.past ?? false;
  }

  /** The latest measurement judged against the tolerance, or `null` without one or the other. */
  private get _driftVerdict() {
    return this._drift && driftVerdict(this._drift.displacementPx, this._dpt);
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
  private _maybeSampleDrift(frame: SourceFrame) {
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
        const at = new Date();
        const plane = grabPlane(frame.source, frame.width, frame.height);
        const result = await session.check.check(plane);
        // A view that was disconnected mid-check, or handed a different archive,
        // must not take the answer: it is about references this view no longer
        // holds.
        if (this._running && this._driftSession === session) {
          this._drift = result;
          this._driftError = null;
          // A frame grabbed before recording started is not part of the recording.
          if (this._recording && at >= this._recording.started) {
            const settings = this._frames?.settings ?? {};
            const row = driftRow(at, result.displacementPx, this._dpt, this._overrideDrift, settings);
            this._recording = { ...this._recording, rows: [...this._recording.rows, row] };
          }
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

  /** Start recording, or stop and download what was recorded. */
  private _toggleRecording() {
    if (this._recording === null) {
      this._recording = { started: new Date(), rows: [] };
      return;
    }
    this._stopRecording();
  }

  /** Download what was recorded, if recording, and stop. */
  private _stopRecording() {
    if (this._recording === null) return;
    downloadDriftCsv(this._recording.rows, driftCsvName(this._recording.started));
    this._recording = null;
  }

  /** Open or close the Details panel, and ask for patches only while it is open. */
  private _toggleDetails() {
    this._detailsOpen = !this._detailsOpen;
    this._results?.setPatches?.(this._detailsOpen);
  }

  private _renderDetailsButton() {
    return html`<div class="details-bar">
      <button aria-pressed=${this._detailsOpen ? 'true' : 'false'} @click=${this._toggleDetails}>
        Details
      </button>
    </div>`;
  }

  private _renderRecorder() {
    const rows = this._recording?.rows.length ?? 0;
    return html`<div class="recorder">
      <button aria-pressed=${this._recording ? 'true' : 'false'} @click=${this._toggleRecording}>
        ${this._recording
          ? `Stop and download drift (${rows} ${rows === 1 ? 'row' : 'rows'})`
          : 'Record drift'}
      </button>
    </div>`;
  }

  /**
   * One frame at a time: ask the frame source for pixels, then the result
   * source for what they mean.
   *
   * The loop's one way out is the `null` a stopped source gives, which is why
   * `next()` is awaited rather than polled — the pacing belongs to the source
   * (an animation frame for the camera, a poll for a service), and the view
   * runs exactly as fast as it is fed.
   */
  private async _loop() {
    const frames = this._frames;
    const results = this._results;
    if (!frames || !results) return;
    // Captured once: the context below reads the refusal off the view, and an
    // object literal's getter cannot see `this`.
    const view = this;

    while (this._running) {
      const frame = await frames.next();
      if (frame === null || !this._running) return;

      // A turn that carried no new picture carries no new pixels either, so
      // there is nothing to measure drift against and nothing to count toward
      // the rate — and the rate is 0 rather than stale, because none is what
      // the view is getting (#331). The answers that came with it are still
      // taken below: that is how every sensor reads `unknown` while a service
      // is quiet instead of the last good answers staying frozen on screen.
      const fresh = frame.fresh !== false;
      const startTime = performance.now();
      if (fresh) {
        this._maybeSampleDrift(frame);
        if (this._lastFrameTime) this._fps = 1000 / (startTime - this._lastFrameTime);
        this._lastFrameTime = startTime;
        if (frame.src !== undefined) this._src = frame.src;
      } else {
        // The next new frame starts the count again rather than being timed
        // from before the gap.
        this._fps = 0;
        this._lastFrameTime = 0;
      }

      // `drifted` is the refusal and `_dpt` is resolved once — from the source's
      // layout where it brings one, from the archive otherwise — rather than per
      // frame, so #166 stays one fix. The source turns the two into one state
      // per sensor: this view never builds an `unknown` of its own.
      //
      // A getter, not a value: drift lands beside the loop, and a sample that
      // arrives while this frame is being answered refuses this frame rather
      // than the next one — see `ResultContext.drifted`.
      let result;
      try {
        result = await results.resultFor(frame, {
          get drifted() {
            return view._refusing;
          },
          dpt: this._dpt,
        });
      } catch (err) {
        // `resultFor` is contracted never to reject, and the session is not
        // bet on that: a loop that died here would leave the last frame's
        // answers on screen for the rest of it, which is the one outcome worse
        // than saying nothing. Skip the frame and ask again.
        console.error('The result source rejected this frame', err);
        continue;
      }
      // An answer that lands after the view was left is about a session that is
      // over.
      if (!this._running) return;

      // Absent is "no L0 at all", which draws no boxes and shows no car count;
      // an empty list is a model that looked and found none, which shows 0.
      this._detections = result.detections ?? null;
      this._sensorStates = result.sensorStates;
      this._l0Age = result.l0Age ?? null;
      // Per answer, so it clears itself when the next one lands.
      this._notice = result.notice ?? null;
      this._details = result.details ?? null;
      // Absent is "nothing inferred", so the readout keeps the last real
      // measurement rather than dropping to zero for a frame.
      if (result.inference !== undefined) this._inference = result.inference;
      // Read every frame: a service that re-read its manifest on a reconnect
      // has new sensor positions, and the states below are keyed on them.
      this._sourceLayout = results.layout ?? null;
      // A source answering from a layout was prepared, whatever `open()`
      // said: a service whose manifest failed then and succeeded on a reconnect
      // must not keep the notice saying it could not be read. The local model
      // brings no layout, so its own error is untouched.
      if (this._sourceLayout !== null) this._sourceError = null;
    }
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

    const verdict = this._driftVerdict!;
    const px = verdict.px.toFixed(1);
    const tolerance = verdict.tolerancePx.toFixed(1);
    const tracks = verdict.tracks.toFixed(2);
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

  /**
   * Why the source cannot answer at all, in the words that fit who it is.
   *
   * The local case names the one job that failed and the command that fixes it:
   * the model is this build's, so "link a rails49/detector checkout" is
   * actionable. A service's failure is its own — a manifest that would not read
   * — and inventing a local cause for it would send the reader to the wrong
   * place (#331).
   */
  private _renderSourceError() {
    if (this._sourceError === null) return '';
    if (!this._judging) {
      return html`<div class="notice">
        The occupancy service could not be read, so every sensor reads
        <strong>unknown</strong>. (${this._sourceError})
      </div>`;
    }
    return html`<div class="notice">
      No detector loaded, so every sensor reads <strong>unknown</strong>. No model has been
      published yet; to run one, link a rails49/detector checkout that has one, then rebuild
      the UI. (${this._sourceError})
    </div>`;
  }

  render() {
    const manifest = this.archive?.getManifest();
    // The source's layout wins where it brings one: a service answers from a
    // manifest it read from the service, so an unsaved edit in the editor
    // cannot move what this view draws (#331).
    const layout = this._sourceLayout;
    const sensors = layout?.sensors ?? manifest?.layout.sensors ?? [];
    const resolution = layout?.resolution ?? manifest?.camera.resolution ?? DEFAULT_RESOLUTION;
    const showDetails = this._detailsOpen && !this._judging;

    return html`
      <rr-stats-bar
        .fps=${this._fps}
        .cars=${this._detections?.length ?? (this._judging ? 0 : null)}
        .occupied=${this._occupiedCount}
        .inference=${this._judging ? this._inference ?? 0 : null}
        .l0Age=${this._l0Age}
        .alignment=${this._judging ? this._drift?.displacementPx ?? null : null}
        .alignmentTolerance=${this._judging ? this._driftTolerancePx : null}
      ></rr-stats-bar>

      ${this._renderSourceError()}

      ${this._notice ? html`<div class="notice">${this._notice}</div>` : ''}

      ${this._judging && this._dpt === null
        ? html`<div class="notice">
            This layout has no calibration, so no DPT resolves. The detector needs it, so no cars
            are detected and every sensor reads <strong>unknown</strong>. Place calibration points
            in the editor.
          </div>`
        : ''}

      ${this._judging ? this._renderDriftNotice() : ''}

      ${this._judging ? this._renderRecorder() : this._renderDetailsButton()}

      <rr-viewer
        .src=${this._src}
        .stream=${this._stream}
        .detections=${this._detections ?? []}
        .sensors=${sensors}
        .sensorStates=${this._sensorStates}
        .dpt=${this._dpt}
        .resolution=${resolution}
        .tracks=${showDetails ? layout?.tracks ?? [] : []}
      ></rr-viewer>

      ${showDetails
        ? html`<rr-service-details
            .details=${this._details}
            .sensors=${sensors}
            .states=${this._sensorStates}
            .rate=${this._fps}
          ></rr-service-details>`
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-live-view': RRLiveView;
  }
}
