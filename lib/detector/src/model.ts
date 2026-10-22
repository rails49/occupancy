/**
 * The detector model's filename: what `./model` resolves to, and what the
 * browser fetches once a build has copied it.
 *
 * The quantized artifact, not `detector.onnx` (9.6 MiB) or the fp32 export:
 * INT8 at 3.4 MiB against Cloudflare Pages' 25 MiB per-file ceiling. Written
 * here and in the `./model` entry of this package's `package.json`, and
 * nowhere else (`tests/model.test.ts` holds the two to one name).
 *
 * The file is gitignored and absent on a fresh clone; a consumer copies it
 * only if it exists.
 */
export const DETECTOR_MODEL_FILE = 'detector_int8.ort';
