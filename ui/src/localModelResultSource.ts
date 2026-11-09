/**
 * The model in this page as a result source (#330).
 *
 * It holds the detector's lifetime, what the inference cost and why the load
 * failed, and it is the only thing in the live path that calls `occupancy()`.
 * The alternative — a service — answers the same two questions over the network
 * (#331), which is why the view asks for L0 and L1 together rather than running
 * a model itself.
 *
 * **The loop runs whether or not the model loaded.** `occupancy()` is total, and
 * with `detections: null` it answers every sensor `unknown` / `no-model` — a
 * state SPEC names and the user needs to see. That is also what a failed
 * `detect` reports, for one frame: refusing to answer is better than leaving the
 * previous frame's answers on screen.
 *
 * **The loop also runs on turns that carried no frame.** A camera with no
 * picture to give takes its turn anyway (#345), and the answer is every sensor
 * `unknown` / `no-frame` with no L0 at all — for the same reason: the previous
 * frame's answers staying on screen is the one outcome worse than saying
 * nothing.
 */

import type { R49Archive } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import type { Detector } from '@rails49/detector/browser';
import { openDetector, DETECTOR_SOURCE } from './detectorSession.js';
import { sourceDpt } from './geometry.js';
import { occupancy } from './occupancy.js';
import type { FrameResult, ResultContext, ResultSource, SourceFrame } from './liveSources.js';

/**
 * The shipped detector, run over the archive's sensors.
 *
 * @param archive the layout being watched. The manifest is read per frame, so a
 *                sensor authored while the view is open is answered.
 */
export function localModelResultSource(archive: R49Archive): ResultSource {
  let detector: Detector | null = null;
  let closed = false;

  return {
    async open() {
      // Reopening is a new session, not a reversal: a source the app holds
      // across mounts is handed back on the next one, and a latched `closed`
      // would make it answer `unknown` for the whole of it with no error to
      // show for it.
      closed = false;
      try {
        // The runtime path and the crossOriginIsolated warning live in
        // `detectorSession.ts`, which the diagnostics view shares (#87).
        const opened = await openDetector();
        // Closed while the session was still loading — leaving the view, in
        // other words. Release it rather than holding a WASM heap for a view
        // nobody is looking at.
        if (closed) void opened.dispose();
        else detector = opened;
        return null;
      } catch (err) {
        // Not fatal, and deliberately so — see the module comment. The loop
        // runs anyway and every sensor reports `unknown` / `no-model`.
        console.error(`Failed to load the detector from ${DETECTOR_SOURCE}`, err);
        return err instanceof Error ? err.message : String(err);
      }
    },

    close() {
      closed = true;
      void detector?.dispose();
      detector = null;
    },

    async resultFor(frame: SourceFrame, context: ResultContext): Promise<FrameResult> {
      const manifest = archive.getManifest();
      // The frame every coordinate is authored in (`SPEC.md` § Output
      // encoding). `detect` is asked to answer in it, so the capture's own
      // pixel count — a phone that ignored the requested 1920x1080 — reaches
      // this file only to put the DPT in the capture's pixels.
      const authored = manifest.camera.resolution;

      const { dpt } = context;

      // A turn that carried no frame: the camera has none to give, before its
      // first picture or after they stopped (#345). Nothing may read pixels
      // from it (`SourceFrame.fresh`), so the detector is not asked at all —
      // there is no frame to ask it about.
      if (frame.fresh === false) {
        return {
          // No `detections` and no `inference`, both absent rather than empty:
          // nothing published L0 for this turn, so no boxes are drawn and no
          // car count is claimed, and the inference readout keeps the last real
          // measurement rather than dropping to zero.
          sensorStates: occupancy({
            // An empty list where a model is loaded, so `occupancy` gets past
            // `no-model` to `no-frame`; `null` where none is, which is the one
            // reason that outranks it.
            detections: detector ? [] : null,
            sensors: manifest.layout.sensors,
            dpt,
            frame: authored,
            drifted: context.drifted,
            noFrame: true,
          }),
        };
      }

      // `null` is the distinction `occupancy` reads: no model at all, rather
      // than a model that found nothing. An empty array would report every
      // sensor `clear`, which is the confident-looking miss SPEC forbids.
      let detections: readonly Detection[] | null = null;
      let inference: number | undefined;
      if (detector) {
        if (dpt === null) {
          // `detect` resamples by the DPT, so with none there are no boxes. An
          // empty list, so that `occupancy` gets past `no-model` to `no-calibration`.
          detections = [];
        } else {
          const before = performance.now();
          try {
            detections = await detector.detect(
              frame.source,
              authored,
              sourceDpt(dpt, frame.width, authored.width)
            );
            // The detect call alone — preprocessing, the session, the decode. Not
            // the whole frame: L1 and the render are the part that scales with
            // the layout, and folding them in would hide which one is slow.
            inference = performance.now() - before;
          } catch (err) {
            // A frame that fails is one frame. The loop stays alive and this
            // frame reads `unknown`.
            console.error('Detection failed for this frame', err);
          }
        }
      }

      return {
        // L0 is handed over as found even while refusing — the boxes are
        // computed in the live frame and are true of it. `drifted` is what
        // withholds L1, and it is `occupancy()` that turns it into one
        // `unknown` per sensor, so nothing here builds an unknown-map of its
        // own (the whole reason that function is total).
        detections: detections ?? [],
        sensorStates: occupancy({
          detections,
          sensors: manifest.layout.sensors,
          dpt,
          frame: authored,
          // Read here rather than on entry: a drift sample that landed while
          // the inference above was running refuses this frame. See
          // `ResultContext.drifted`.
          drifted: context.drifted,
        }),
        inference,
      };
    },
  };
}
