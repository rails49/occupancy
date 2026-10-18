// The WASM-EP-only entry point, not the package root: the root pulls the jsep
// (WebGPU/WebNN) binary, which is over Cloudflare's per-file limit and which
// `executionProviders: ['wasm']` below never uses. See `ui/ortAssets.ts`.
import * as ort from 'onnxruntime-web/wasm';
import { type Point } from '@rails49/r49';
import { BaseClassifier, type ClassifierConfig } from './base.ts';

/**
 * Where the ORT runtime is served from is the **app's** to say — it depends on
 * the app's base path, which a library cannot know. This module used to guess
 * `/ort/` — right for `ui` today by coincidence of its base, wrong the moment
 * any app mounts under a prefix, and it survived only because the app
 * overwrote it before the first session.
 *
 * There is no safe default left to fall back to: `ui` deletes the copy ORT
 * would otherwise resolve from `import.meta.url` (see `ui/ortAssets.ts`), so an
 * unset `wasmPaths` fetches a URL that isn't there. Say so at the point of
 * failure rather than surfacing it as a 404 on a hashed filename.
 */
function assertWasmPathsConfigured() {
  if (!ort.env.wasm.wasmPaths) {
    throw new Error(
      'Set ort.env.wasm.wasmPaths to where the app serves the ONNX Runtime ' +
      'before loading a model — there is no default that works under a base path.'
    );
  }
}

export class BrowserClassifier extends BaseClassifier {
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  constructor(config: ClassifierConfig) {
    super(config);
    this._canvas = document.createElement('canvas');
    this._canvas.width = config.crop_size;
    this._canvas.height = config.crop_size;
    const ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to create classification canvas context');
    this._ctx = ctx;
  }

  async load(source: string | Blob | ArrayBuffer) {
    assertWasmPathsConfigured();
    try {
      let modelData: string | Uint8Array;
      if (source instanceof Blob) {
        modelData = new Uint8Array(await source.arrayBuffer());
      } else if (source instanceof ArrayBuffer) {
        modelData = new Uint8Array(source);
      } else {
        modelData = source;
      }

      const options: ort.InferenceSession.SessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      };

      this._session = await ort.InferenceSession.create(modelData as any, options);
      console.log('ONNX browser session loaded successfully');
    } catch (err) {
      console.error('Failed to load ONNX model in browser', err);
      throw err;
    }
  }

  async classify(
    image: CanvasImageSource,
    point: Point,
    img_dpt: number
  ): Promise<string[]> {
    if (!this._session) return [];

    const { sx, sy, srcSize, cropSize } = this.getScalingMath(point, img_dpt);

    // Extract patch using Canvas
    this._ctx.clearRect(0, 0, cropSize, cropSize);
    this._ctx.drawImage(image, sx, sy, srcSize, srcSize, 0, 0, cropSize, cropSize);

    // Browser ImageData is RGBA, so we need to convert it to RGB for the shared preprocessor
    const imageData = this._ctx.getImageData(0, 0, cropSize, cropSize);
    const { data } = imageData;
    const rgbData = new Uint8Array(cropSize * cropSize * 3);
    for (let i = 0; i < cropSize * cropSize; i++) {
      rgbData[i * 3] = data[i * 4];
      rgbData[i * 3 + 1] = data[i * 4 + 1];
      rgbData[i * 3 + 2] = data[i * 4 + 2];
    }

    const inputTensor = this.preprocessToTensor(
      rgbData,
      cropSize,
      (data, dims) => new ort.Tensor('float32', data, dims)
    );

    const feeds = { [this._session.inputNames[0]]: inputTensor };
    const results = await this._session.run(feeds);
    const output = results[this._session.outputNames[0]];
    
    return this.getLabelsFromResult(output.data as Float32Array);
  }
}
