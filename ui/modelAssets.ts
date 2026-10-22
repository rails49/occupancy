/**
 * Which model the bundle ships, and where the browser finds it.
 *
 * Two files have to agree about this and they run in different worlds: the
 * static-copy target in `vite.config.ts`, which puts the file in the bundle at
 * build time, and the `loadDetector` call in `src/detectorSession.ts`, which
 * fetches it at run time. They used to be two string literals, and a rename
 * that touched one of them produced a 404 at the moment the camera came up —
 * the one place a build cannot check and a typecheck cannot see.
 *
 * Neither side names the file now. The detector package does (ADR 0019): the
 * build copies whatever its `./model` entry resolves to, and the browser
 * fetches the package's `DETECTOR_MODEL_FILE` from the directory the copy
 * writes to. That directory and the entry are `modelCopy.ts`'s, which the
 * config can import; this module is the run-time half.
 *
 * The detector is the **only** model in the bundle. The CNN is retained and
 * retrainable (`SPEC.md` § Option 2) but nothing loads it: L1 is a pure
 * function of L0, so the per-sensor answer is a geometric consequence of the
 * detector's boxes and there is nothing left for a second model to say. One
 * model, one ORT session, one vocabulary — settled in issue #7.
 *
 * `tests/modelAssets.test.ts` holds the chain to these values.
 */

import { DETECTOR_MODEL_FILE } from '@occupancy/detector';
import { DETECTOR_MODEL_DEST } from './modelCopy.js';

export { DETECTOR_MODEL_FILE };

/**
 * The URL the browser fetches it from.
 *
 * Absolute under the app's `base: '/'`, like `/ort/` and `/shoelace` —
 * changing `base` means changing all of them (see `docs/UI.md` §
 * Absolute asset paths).
 */
export const DETECTOR_MODEL_URL = `/${DETECTOR_MODEL_DEST}/${DETECTOR_MODEL_FILE}`;
