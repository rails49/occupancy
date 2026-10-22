// The WASM-EP-only entry point, not the package root: the root pulls the jsep
// (WebGPU/WebNN) binary, which is over Cloudflare's per-file limit and which
// `executionProviders: ['wasm']` below never uses. See `ui/ortAssets.ts`.
import * as ort from 'onnxruntime-web/wasm';
import { DETECTOR_INPUT } from '@occupancy/config';
import { decodeDetections } from './decode.ts';
import { gridToReport } from './letterbox.ts';
import { paintLetterbox } from './preprocess.ts';
import { CONFIDENCE_THRESHOLD } from './thresholds.ts';
import type { Detection, Frame } from './types.ts';

const [GRID_WIDTH, GRID_HEIGHT] = DETECTOR_INPUT;

/**
 * A loaded detector. There is no unloaded one — see `loadDetector`.
 */
export interface Detector {
  /**
   * Every car the model finds in one picture (L0), in the frame named by
   * `report`.
   *
   * @param source The picture: a video element mid-stream, an image, a canvas,
   *               a bitmap — anything the 2D context can draw.
   * @param report The coordinate system to answer in, normally
   *               `camera.resolution`. The source's own pixel count, the model
   *               grid and the letterbox bars all stay inside.
   * @param options.minConfidence Overrides `CONFIDENCE_THRESHOLD` for
   *               this call, so diagnostics can see what a lower threshold
   *               would have caught without re-running inference.
   * @throws If the source has no dimensions yet — a video before its metadata
   *         arrives. That is the not-ready case, and it is a caller's timing
   *         bug rather than an empty frame.
   */
  detect(
    source: CanvasImageSource,
    report: Frame,
    options?: { readonly minConfidence?: number }
  ): Promise<readonly Detection[]>;

  /** Release the ORT session. The instance is unusable afterwards. */
  dispose(): Promise<void>;
}

/**
 * Where the ORT runtime is served from is the **app's** to say — it depends on
 * the app's base path, which a library cannot know. There is no safe default to
 * fall back to: `ui` deletes the copy ORT would otherwise resolve from
 * `import.meta.url` (see `ui/ortAssets.ts`), so an unset `wasmPaths` fetches a
 * URL that isn't there. Say so at the point of failure rather than surfacing it
 * as a 404 on a hashed filename.
 */
function assertWasmPathsConfigured(): void {
  if (!ort.env.wasm.wasmPaths) {
    throw new Error(
      'Set ort.env.wasm.wasmPaths to where the app serves the ONNX Runtime ' +
        'before loading a model — there is no default that works under a base path.'
    );
  }
}

/**
 * Load a detector from model bytes or a URL.
 *
 * A factory rather than a constructor plus an `await load()`, because the
 * half-built state is the whole problem: a session object holding a nullable
 * session has to answer `detect` somehow while unloaded, and every honest
 * answer ("no cars") is indistinguishable from a real empty frame. SPEC has a
 * name for that state — `unknown`, "model not loaded" — and it belongs to the
 * view, not to the session. So it is unrepresentable here: you cannot hold a
 * `Detector` that is not loaded, `detect` has no null branch, and the live view
 * holds `Detector | null` where the distinction is real and drives what the
 * user sees.
 *
 * @throws If the model's input shape disagrees with `DETECTOR_INPUT`. The grid
 *         is read off the loaded graph rather than trusted from config —
 *         a constant can disagree with the shipped model, a graph cannot
 *         disagree with itself — and drift between the two puts every box in
 *         the wrong place.
 */
export async function loadDetector(source: string | Blob | ArrayBuffer): Promise<Detector> {
  assertWasmPathsConfigured();

  // A URL and bytes are separate overloads, so the branch is real rather than a
  // cast: ORT fetches the one and adopts the other.
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  };

  const session =
    typeof source === 'string'
      ? await ort.InferenceSession.create(source, options)
      : await ort.InferenceSession.create(
          source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(source),
          options
        );

  assertInputGrid(session);
  return new BrowserDetector(session);
}

/** The loaded graph's input grid, checked against the committed constant. */
function assertInputGrid(session: ort.InferenceSession): void {
  const input = session.inputMetadata[0];
  if (!input?.isTensor) {
    throw new Error("the model's first input is not a tensor; this is not a detector graph");
  }

  // NCHW: the last two dimensions are height then width.
  const shape = input.shape;
  const height = shape[shape.length - 2];
  const width = shape[shape.length - 1];

  if (width !== GRID_WIDTH || height !== GRID_HEIGHT) {
    throw new Error(
      `the model takes ${width}x${height}, but DETECTOR_INPUT says ` +
        `${GRID_WIDTH}x${GRID_HEIGHT}. Re-export the model or fix config.yaml — ` +
        `preprocessing to the wrong grid puts every box in the wrong place.`
    );
  }
}

class BrowserDetector implements Detector {
  readonly #session: ort.InferenceSession;
  // One canvas for the life of the session: `detect` runs per video frame, and
  // allocating a 960x544 backing store each time is the kind of garbage a live
  // view notices.
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;

  constructor(session: ort.InferenceSession) {
    this.#session = session;
    this.#canvas = document.createElement('canvas');
    this.#canvas.width = GRID_WIDTH;
    this.#canvas.height = GRID_HEIGHT;

    const ctx = this.#canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('failed to create the detector 2D context');
    this.#ctx = ctx;
  }

  async detect(
    source: CanvasImageSource,
    report: Frame,
    options?: { readonly minConfidence?: number }
  ): Promise<readonly Detection[]> {
    const frame = sourceFrame(source);
    const grid = { width: GRID_WIDTH, height: GRID_HEIGHT };

    paintLetterbox(this.#ctx, source, frame, grid);

    const feeds = { [this.#session.inputNames[0]]: this.#toTensor() };
    const results = await this.#session.run(feeds);
    const output = results[this.#session.outputNames[0]];

    return decodeDetections(
      output.data as Float32Array,
      output.dims,
      gridToReport(frame, grid, report),
      options?.minConfidence ?? CONFIDENCE_THRESHOLD
    );
  }

  /**
   * The canvas as the network's input: RGB, planar, scaled to `0…1`.
   *
   * No mean/std normalization — Ultralytics bakes that into the graph, and
   * `export_onnx.py`'s calibration reader feeds it the same plain division.
   */
  #toTensor(): ort.Tensor {
    const { data } = this.#ctx.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT);
    const area = GRID_WIDTH * GRID_HEIGHT;
    const planar = new Float32Array(3 * area);

    for (let i = 0; i < area; i++) {
      planar[i] = data[i * 4] / 255;
      planar[i + area] = data[i * 4 + 1] / 255;
      planar[i + 2 * area] = data[i * 4 + 2] / 255;
    }

    return new ort.Tensor('float32', planar, [1, 3, GRID_HEIGHT, GRID_WIDTH]);
  }

  async dispose(): Promise<void> {
    await this.#session.release();
  }
}

/**
 * The source's own pixel count.
 *
 * Each source type states its intrinsic size under a different name, and the
 * *attribute* `width` on a video or an image is the CSS box rather than the
 * media — so the branch is on which property exists, not on which is non-zero.
 * A zero after that is the not-ready case, which is worth a sentence rather
 * than a division by zero three frames later.
 */
function sourceFrame(source: CanvasImageSource): Frame {
  const candidate = source as Partial<
    Record<'videoWidth' | 'videoHeight' | 'naturalWidth' | 'naturalHeight' | 'width' | 'height', number>
  >;

  let width: number | undefined;
  let height: number | undefined;

  if (typeof candidate.videoWidth === 'number') {
    width = candidate.videoWidth;
    height = candidate.videoHeight;
  } else if (typeof candidate.naturalWidth === 'number') {
    width = candidate.naturalWidth;
    height = candidate.naturalHeight;
  } else if (typeof candidate.width === 'number') {
    width = candidate.width;
    height = candidate.height;
  }

  if (!width || !height) {
    throw new Error(
      'the source has no dimensions yet — a video before its metadata arrives, ' +
        'or an image before it decodes. Wait for it rather than detecting on nothing.'
    );
  }

  return { width, height };
}
