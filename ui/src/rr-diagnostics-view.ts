import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { R49Archive } from '@occupancy/r49';
import { getDPT } from '@occupancy/r49';
import type { Detection, Frame } from '@occupancy/detector';
import type { Detector } from '@occupancy/detector/browser';
import { DETECTOR_CONFIDENCE_THRESHOLD } from '@occupancy/config';
import { openDetector, DETECTOR_SOURCE } from './detectorSession.js';
import { diagnoseImage, rollUp } from './diagnostics.js';
import type { ArchiveDiagnostics } from './diagnostics.js';
import './rr-diagnostics-report.js';
import './rr-diagnostics-queue.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/progress-bar/progress-bar.js';

/** What `camera.resolution` stands in as when an archive declares none. */
const DEFAULT_RESOLUTION: Frame = { width: 1920, height: 1080 };

/**
 * The confidence floor inference is actually run at.
 *
 * Far below `DETECTOR_CONFIDENCE_THRESHOLD` on purpose, and this is the whole
 * reason `detect` takes a `minConfidence` override. Running at the shipped
 * threshold would throw away every box between 0.05 and it — exactly the boxes
 * that answer "what would a lower threshold have caught?". Running low once and
 * filtering afterwards makes the threshold control free: re-scoring is
 * `diagnoseImage`, which is pure arithmetic over a few dozen rectangles, where
 * re-running inference is twenty seconds of WASM.
 */
const SWEEP_MIN_CONFIDENCE = 0.05;

/** Everything the model said about one image, before any threshold is applied. */
interface RawImageResult {
  readonly filename: string;
  readonly detections: readonly Detection[];
}

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly done: number; readonly total: number }
  | { readonly kind: 'complete' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Archive diagnostics: the shipped detector run over an opened `.r49`, read
 * against the labels a human authored (#87).
 *
 * **This is the first thing that measures the artifact that ships.** The only
 * figures that exist for the detector come from the training run's own
 * validation split on `best.pt`; nothing has ever scored the quantized model
 * this app actually loads, whose quantization is Conv-only because quantizing
 * the whole graph zeroed every score (#82). (Its filename is deliberately not
 * written here — `modelAssets.ts` is the one place that names it, and
 * `tests/modelAssets.test.ts` fails if any view does.) What this view reports
 * is agreement between one model and
 * one archive's labels — **not** an accuracy figure, and not a generalization
 * estimate, which `SPEC.md` § Accuracy makes a property of a held-out protocol
 * over a corpus that does not exist yet.
 *
 * Two surfaces, one behind the other: the report answers "how is it doing on
 * this archive", and reviewing a row opens the queue on that image's
 * disagreements. They are one surface at two zoom levels rather than two views
 * to choose between (#86).
 *
 * **Properties:** `archive`.
 */
@customElement('rr-diagnostics-view')
export class RRDiagnosticsView extends LitElement {
  @property({ attribute: false }) archive: R49Archive | null = null;

  @state() private _run: RunState = { kind: 'idle' };
  @state() private _raw: readonly RawImageResult[] = [];
  @state() private _urls: ReadonlyMap<string, string> = new Map();
  @state() private _dpt: number | null = null;
  @state() private _threshold = DETECTOR_CONFIDENCE_THRESHOLD;
  /** The image whose queue is open, or `null` on the report. */
  @state() private _reviewing: string | null = null;

  /**
   * Raised to abandon a run. A view switch mid-sweep must not leave twenty
   * seconds of inference running against a detached element, and the archive
   * can be replaced underneath us while a sweep is in flight.
   */
  private _abandon: AbortController | null = null;
  private _detector: Detector | null = null;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      background: var(--sl-color-neutral-0);
      color: var(--sl-color-neutral-900);
      font: 13px/1.45 var(--sl-font-sans, system-ui), sans-serif;
    }

    .notice {
      padding: 0.6rem 1rem;
      background: var(--sl-color-warning-100);
      color: var(--sl-color-warning-800);
      font-size: 0.9rem;
    }

    .notice.error {
      background: var(--sl-color-danger-100);
      color: var(--sl-color-danger-800);
    }

    .centre {
      margin: auto;
      max-width: 30rem;
      padding: 2rem;
      text-align: center;
      color: var(--sl-color-neutral-600);
    }

    .progress {
      padding: 1.5rem 2rem;
    }

    .progress p {
      display: flex;
      justify-content: space-between;
      color: var(--sl-color-neutral-600);
    }

    rr-diagnostics-report,
    rr-diagnostics-queue {
      flex-grow: 1;
      min-height: 0;
    }
  `;

  disconnectedCallback() {
    super.disconnectedCallback();
    void this._teardown();
  }

  protected willUpdate(changed: Map<string, unknown>) {
    if (!changed.has('archive')) return;
    const manifest = this.archive?.getManifest();
    this._dpt = manifest ? getDPT(manifest) : null;
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('archive')) void this._restart();
  }

  private async _teardown() {
    this._abandon?.abort();
    this._abandon = null;
    for (const url of this._urls.values()) URL.revokeObjectURL(url);
    this._urls = new Map();
    const detector = this._detector;
    this._detector = null;
    await detector?.dispose();
  }

  private async _restart() {
    await this._teardown();
    this._raw = [];
    this._reviewing = null;
    this._run = { kind: 'idle' };
    if (!this.archive || this._dpt === null) return;
    await this._sweep();
  }

  /**
   * Run the detector over every image in the archive.
   *
   * Sequential, not parallel: there is one ORT session and one WASM heap, so
   * concurrent `detect` calls would queue inside the session anyway while
   * making the progress count meaningless and holding every decoded bitmap in
   * memory at once.
   */
  private async _sweep() {
    const archive = this.archive;
    if (!archive) return;

    const abandon = new AbortController();
    this._abandon = abandon;
    const manifest = archive.getManifest();
    const frame = manifest.camera.resolution ?? DEFAULT_RESOLUTION;
    const images = manifest.images;

    this._run = { kind: 'running', done: 0, total: images.length };

    try {
      this._detector = await openDetector();
    } catch (err) {
      // Fatal here, unlike the live view. There, `occupancy()` is total and a
      // missing model still yields an honest `unknown` per sensor; here there
      // is no partial answer to give — the entire content of this view is the
      // model's output.
      this._run = {
        kind: 'failed',
        message:
          `No detector could be loaded from ${DETECTOR_SOURCE}. Build one with ` +
          `\`uv run python export_onnx.py\` in \`detector/\`, then rebuild the UI. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      };
      return;
    }

    const urls = new Map<string, string>();
    const raw: RawImageResult[] = [];

    try {
      for (const image of images) {
        if (abandon.signal.aborted) return releaseUrls(urls);

        const bytes = await archive.getImage(image.filename);
        if (!bytes) continue;

        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
        urls.set(image.filename, url);
        // An abandoned sweep must not publish. By the time one resumes, a
        // replacement sweep may already have published its own map, and this
        // assignment would overwrite it with handles `_teardown` has revoked —
        // for images belonging to an archive that is no longer open. The
        // symptom is a report full of broken thumbnails naming files it never
        // swept, which no leak check would see: the handles are freed, they are
        // just freed and still on screen.
        if (abandon.signal.aborted) return releaseUrls(urls);
        this._urls = new Map(urls);

        const element = await decodeImage(url);
        // The rule from #108: every `return` past a handle's creation hands the
        // URLs back, because `_teardown` can only revoke what was published
        // before it ran. An abort landing on *this* await is covered either way
        // — the map went out above — but keeping both returns symmetric is what
        // stops the next `await` inserted into this loop from reopening the
        // leak. `releaseUrls` is idempotent for exactly that reason.
        if (abandon.signal.aborted) return releaseUrls(urls);

        const detections = await this._detector.detect(element, frame, {
          minConfidence: SWEEP_MIN_CONFIDENCE,
        });

        raw.push({ filename: image.filename, detections });
        this._raw = [...raw];
        this._run = { kind: 'running', done: raw.length, total: images.length };
      }

      if (!abandon.signal.aborted) this._run = { kind: 'complete' };
    } catch (err) {
      if (abandon.signal.aborted) return releaseUrls(urls);
      this._run = {
        kind: 'failed',
        message: `Inference failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Score whatever has been swept so far, at the current threshold.
   *
   * Derived on every render rather than cached: it is pure arithmetic over the
   * boxes already in hand, and caching it would need invalidating on both the
   * threshold and the sweep's progress — two sources for one derived value,
   * which is how a stale readout gets shipped.
   */
  private get _diagnostics(): ArchiveDiagnostics | null {
    const manifest = this.archive?.getManifest();
    if (!manifest || this._dpt === null) return null;

    const byFilename = new Map(this._raw.map(r => [r.filename, r.detections]));
    const scored = manifest.images
      .filter(image => byFilename.has(image.filename))
      .map(image =>
        diagnoseImage({
          filename: image.filename,
          labeledComplete: image.labeled_complete,
          labels: image.labels,
          detections: byFilename
            .get(image.filename)!
            .filter(d => d.confidence >= this._threshold),
          dpt: this._dpt!,
        })
      );

    return rollUp(scored);
  }

  private _onThreshold(e: CustomEvent<{ value: number }>) {
    this._threshold = e.detail.value;
  }

  private _onReview(e: CustomEvent<{ filename: string }>) {
    this._reviewing = e.detail.filename;
  }

  private _onCloseReview() {
    this._reviewing = null;
  }

  render() {
    if (!this.archive) {
      return html`<div class="centre">
        <p>Open a layout to check the detector against its labels.</p>
      </div>`;
    }

    if (this._dpt === null) {
      return html`<div class="notice">
        This layout has no calibration, so no DPT resolves and no car width can be derived — there
        is no rectangle to compare a prediction against. Place calibration points in the editor.
      </div>`;
    }

    if (this._run.kind === 'failed') {
      return html`<div class="notice error">${this._run.message}</div>`;
    }

    const diagnostics = this._diagnostics;
    const resolution = this.archive.getManifest().camera.resolution ?? DEFAULT_RESOLUTION;

    if (this._run.kind === 'running' && this._raw.length === 0) {
      return html`<div class="progress">
        <p><span>Loading the detector…</span></p>
        <sl-progress-bar indeterminate></sl-progress-bar>
      </div>`;
    }

    const reviewing = this._reviewing
      ? (diagnostics?.images.find(i => i.filename === this._reviewing) ?? null)
      : null;

    return html`
      ${this._run.kind === 'running'
        ? html`<div class="progress">
            <p>
              <span>Running the detector over this archive…</span>
              <span>${this._run.done} of ${this._run.total}</span>
            </p>
            <sl-progress-bar
              value=${(this._run.done / Math.max(this._run.total, 1)) * 100}
            ></sl-progress-bar>
          </div>`
        : ''}
      ${reviewing
        ? html`<rr-diagnostics-queue
            .image=${reviewing}
            .imageUrl=${this._urls.get(reviewing.filename) ?? null}
            .dpt=${this._dpt}
            .resolution=${resolution}
            @rr-diagnostics-close=${this._onCloseReview}
          ></rr-diagnostics-queue>`
        : html`<rr-diagnostics-report
            .diagnostics=${diagnostics}
            .imageUrls=${this._urls}
            .dpt=${this._dpt}
            .resolution=${resolution}
            .threshold=${this._threshold}
            .sweeping=${this._run.kind === 'running'}
            @rr-diagnostics-threshold=${this._onThreshold}
            @rr-diagnostics-review=${this._onReview}
          ></rr-diagnostics-report>`}
    `;
  }
}

/**
 * An image element the detector can draw, once its bytes have actually decoded.
 *
 * `detect` throws on a source with no dimensions, and an `<img>` assigned a
 * `src` has none until it decodes. `decode()` is the promise that says when —
 * `complete` is a poll, and polling it here would be a race the sweep loses on
 * exactly the largest images.
 */
/**
 * Revoke every blob URL a sweep created.
 *
 * Idempotent: `URL.revokeObjectURL` on an already-revoked handle is a no-op, so
 * an abandoned sweep can release its whole map without needing to know which
 * entries `_teardown` already dealt with.
 */
function releaseUrls(urls: ReadonlyMap<string, string>): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  const element = new Image();
  element.src = url;
  return element.decode().then(() => element);
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-diagnostics-view': RRDiagnosticsView;
  }
}
