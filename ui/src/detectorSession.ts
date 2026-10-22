/**
 * Opening a detector session, in one place.
 *
 * Two views need one now — the live view runs it per camera frame, and the
 * diagnostics view runs it over an archive's stills (#87) — and the setup
 * around `loadDetector` is not incidental: it points ORT at the runtime this
 * app serves, and it is the only place that knows the app's base path. Written
 * twice, the second copy is the one that silently 404s under a changed `base`,
 * which is exactly the failure `modelAssets.ts` exists to prevent for the model
 * filename.
 *
 * **The `onnxruntime-web/wasm` specifier is the load-bearing detail.** It must
 * match `lib/detector/src/browser.ts` character for character: two specifiers
 * are two module instances, and the `ort.env.wasm` configured here would not be
 * the one the detector's session reads. Putting the import in one file rather
 * than two is the point — see `docs/UI.md` § Model loading.
 */

// Must match the specifier `@occupancy/detector/browser` imports — see above.
import * as ort from 'onnxruntime-web/wasm';
import { loadDetector } from '@occupancy/detector/browser';
import type { Detector } from '@occupancy/detector/browser';
import { DETECTOR_MODEL_URL } from '../modelAssets.js';

/** Set once per page, not once per session — `ort.env` is module-global. */
let configured = false;

function configureRuntime(): void {
  if (configured) return;
  configured = true;

  // Same path everywhere: the runtime ships with the bundle. A cross-origin CDN
  // would fail COEP, which production sets to get threading (#15). Written as a
  // literal rather than through a constant because `tests/ortAssets.test.ts`
  // reads this assignment as source text — it is the link between the copy
  // target and the fetch, and neither the typechecker nor the build can see it.
  // Absolute under `base: '/'`, like `/shoelace` and the model URL.
  ort.env.wasm.wasmPaths = '/ort/';

  // Losing isolation costs ~1.5x and breaks nothing visibly — ORT just drops to
  // a single WASM thread. Say it, since nothing else can: there is no error, no
  // warning from ORT, and the only symptom is that everything is slower than
  // the numbers anyone measured.
  if (!self.crossOriginIsolated) {
    console.warn(
      'Not crossOriginIsolated: ONNX Runtime is limited to a single WASM ' +
        'thread. Check the COOP/COEP headers this page was served with.'
    );
  }
}

/**
 * Load the shipped detector.
 *
 * Rejects rather than resolving null: an unloaded detector is unrepresentable
 * by design (`loadDetector` is a factory for that reason), and what a *view*
 * does about a failure differs — the live view keeps its loop running and
 * reports every sensor `unknown`, the diagnostics view has nothing to report at
 * all and says so. Deciding that here would take the choice away from both.
 *
 * Each caller owns the session it opens and must `dispose()` it. Two views are
 * never mounted at once, so nothing is shared and nothing is reference-counted:
 * a cache would have to outlive the view that opened it, and the failure mode
 * is a WASM heap held for a session nobody is using.
 */
export async function openDetector(): Promise<Detector> {
  configureRuntime();
  return loadDetector(DETECTOR_MODEL_URL);
}

/** Where a failed load was pointed, for an error message that can be acted on. */
export const DETECTOR_SOURCE = DETECTOR_MODEL_URL;
