/**
 * Which model the bundle ships, in one place.
 *
 * Two files have to agree about this and they run in different worlds: the
 * static-copy target in `vite.config.ts`, which puts the file in the bundle at
 * build time, and the `loadDetector` call in `src/rr-live-view.ts`, which
 * fetches it at run time. They used to be two string literals, and a rename
 * that touched one of them produced a 404 at the moment the camera came up —
 * the one place a build cannot check and a typecheck cannot see. So the URL is
 * derived from the filename rather than written beside it.
 *
 * The detector is the **only** model in the bundle. The CNN is retained and
 * retrainable (`SPEC.md` § Option 2) but nothing loads it: L1 is a pure
 * function of L0, so the per-sensor answer is a geometric consequence of the
 * detector's boxes and there is nothing left for a second model to say. One
 * model, one ORT session, one vocabulary — settled in issue #7.
 *
 * `tests/modelAssets.test.ts` holds the chain to these values.
 */

/**
 * The quantized detector, and not `detector.onnx` (9.6 MiB) or the fp32 export.
 *
 * INT8 at 3.4 MiB against Cloudflare Pages' 25 MiB per-file ceiling — the same
 * ceiling that shapes the ORT binary choice next door in `ortAssets.ts`.
 */
export const DETECTOR_MODEL_FILE = 'detector_int8.ort';

/**
 * Where `detector/export_onnx.py` writes, relative to `ui/`.
 *
 * The model is gitignored, and absent on a fresh clone: the copy target is
 * conditional on the file existing, so a build with no local model succeeds and the live
 * view reports every sensor `unknown` / `no-model` rather than failing to
 * start. That is the same shape the classifier's copy had, and it is what keeps
 * `bin/test.sh` runnable without downloading anything.
 */
export const DETECTOR_MODEL_DIR = '../detector/models';

/**
 * The URL the browser fetches it from.
 *
 * Absolute under the app's `base: '/'`, like `/ort/` and `/shoelace` —
 * changing `base` means changing all of them (see `docs/UI.md` §
 * Absolute asset paths).
 */
export const DETECTOR_MODEL_URL = `/models/${DETECTOR_MODEL_FILE}`;

/** The `vite-plugin-static-copy` target, relative to `ui/`. */
export const detectorCopyTarget = {
  src: `${DETECTOR_MODEL_DIR}/${DETECTOR_MODEL_FILE}`,
  dest: 'models',
};
