/**
 * The shapes the drift check is expressed in.
 *
 * Types only, so nothing that merely wants to name a `GrayPlane` pulls in the
 * FFT.
 */

/**
 * A single-channel image: grayscale, row-major, values in `0…1`.
 *
 * The parameter type is this and not `ImageData` on purpose. `ImageData` does
 * not exist in Node, and `tools/drift-bench` — the thing that decides whether
 * this code works at all — is a Node program: making the browser's type the
 * boundary would lock the benchmark out of the interface it is supposed to be
 * validating. Browser callers convert with {@link fromImageData}.
 *
 * Colour is discarded rather than weighted per channel because drift is a
 * question about *structure*: where the edges are, not what colour they are.
 */
export interface GrayPlane {
  readonly width: number;
  readonly height: number;
  /** Length `width * height`, row-major, values in `0…1`. */
  readonly data: Float32Array;
}

/**
 * What a frame's comparison against the reference set came to.
 *
 * There is no verdict here, deliberately. Whether `displacementPx` counts as
 * drift is the consumer's: `MAX_DRIFT_TRACK_FRACTION` in `ui/src/driftSession.ts` — the
 * live view refuses on it and the editor warns on it, two responses to one
 * number (SPEC's asymmetric-response decision, map #89). A module that decided
 * would force both surfaces to agree about policy as well as measurement.
 */
export interface DriftResult {
  /**
   * How far the camera appears to have moved, in **reference-frame pixels**.
   *
   * The reference frame is the native pixel grid of the archive's images —
   * `camera.resolution`, normally — which SPEC makes the one stable frame
   * sensors and calibration are authored in. So this number is one DPT multiply
   * from millimetres, and it does not change meaning when the module's internal
   * working resolution does.
   *
   * The statistic is the **median** over blocks, minimised over references. A
   * moved camera displaces every block coherently; a moved car displaces only
   * the blocks it passes through, so the median reads the camera and ignores
   * the traffic.
   */
  readonly displacementPx: number;
  /**
   * Which reference the frame agreed with best — an index into the array given
   * to `createDriftCheck`.
   *
   * Reported because the editor's warning copy wants to name the image it is
   * comparing against, and because a frame that matches the *oldest* reference
   * best is a different story from one that matches the newest.
   */
  readonly refIndex: number;
}

/**
 * A comparison bound to one reference set.
 *
 * Obtained from `createDriftCheck`, never constructed: the expensive half of
 * the arithmetic — windowing and per-block FFT of every reference — depends
 * only on the references and is fixed for the session's life. A factory makes
 * that cache part of the object instead of caller folklore, and makes an
 * unprepared check unrepresentable.
 */
export interface DriftCheck {
  /** How many references this check holds. `refIndex` is an index into them. */
  readonly refCount: number;
  /**
   * Compare one frame against every reference.
   *
   * Async because hundreds of milliseconds of FFT on phone-class hardware is a
   * fact about the interface, not an implementation detail: promising sync
   * would forbid ever moving this into a worker.
   *
   * @param frame the live or freshly captured frame, at any resolution — it is
   *              resampled onto the reference's grid internally
   * @throws if `frame` is empty or its `data` length disagrees with its
   *         dimensions
   */
  check(frame: GrayPlane): Promise<DriftResult>;
}
