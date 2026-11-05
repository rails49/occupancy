/**
 * Where the live view's frames and its answers come from (#330).
 *
 * The loop in `rr-live-view` asks a **frame source** for a frame and then asks a
 * **result source** for that frame's L0 and L1. Today both are local — the
 * camera and the shipped detector — and the split is what lets a video file or a
 * service stand in for either without the loop, the drift check, the notices or
 * the stats bar knowing which is running (#286, #331, rails49/detector#64).
 *
 * **One object may be both.** A service answers `latest` with a frame and its
 * results together, so #331 hands the same object in as `frames` and as
 * `results`; a frame may therefore carry data that only its own source reads,
 * which is why {@link SourceFrame} is a floor and not a ceiling.
 *
 * Nothing here loads a model or touches a camera: the two implementations are
 * `cameraFrameSource.ts` and `localModelResultSource.ts`, and they are what the
 * view falls back to when it is given no sources.
 */

import type { Detection } from '@rails49/detector';
import type { SensorState } from './occupancy.js';

/**
 * One frame to run on, with the intrinsic size it arrived at.
 *
 * The size comes with it because the drift check grabs the frame into a canvas
 * and the *intrinsic* size is the one to grab at — not `camera.resolution`. A
 * phone that ignored the requested 1920x1080 hands back whatever it felt like;
 * the drift check normalizes resolution internally, so feeding it the real
 * pixels loses nothing where scaling them to a declared frame first would
 * resample twice.
 *
 * An implementation may carry more on its frames — a service's frame arrives
 * with its results attached (#331) — and only that source reads the extra.
 */
export interface SourceFrame {
  /** What `detect` and the drift grab read pixels from. */
  readonly source: CanvasImageSource;
  /** The width it decoded at, in its own pixels. */
  readonly width: number;
  /** The height it decoded at, in its own pixels. */
  readonly height: number;
}

/**
 * Where frames come from: a camera, a video file, a service.
 *
 * `next()` is the loop's pacing as well as its input — it resolves when there is
 * something to run on, so a source that is not ready yet holds the loop rather
 * than spinning it.
 */
export interface FrameSource {
  /** Acquire whatever the frames come from. Reports a refusal itself; see `cameraFrameSource`. */
  start(): Promise<void>;
  /** Release it. A `next()` already being waited for resolves `null`. */
  stop(): void;
  /**
   * The next frame to run on, once there is one.
   *
   * `null` after {@link stop}, which is what ends the loop — the one way out, so
   * a stopped source cannot leave the view running on frames nobody owns.
   */
  next(): Promise<SourceFrame | null>;
  /** What `rr-viewer` shows, or `null` when the source is not a stream. */
  readonly stream: MediaStream | null;
  /** The camera settings the drift rows record (#217), empty when there are none. */
  readonly settings: MediaTrackSettings;
}

/**
 * What the view needs to know about a frame to answer it.
 *
 * **Live, not a snapshot.** The view hands over a view onto its own state, and
 * a source reads each field when it is about to answer rather than when it was
 * called — see {@link ResultContext.drifted}.
 */
export interface ResultContext {
  /**
   * Whether the view is refusing on camera drift, in which case L1 is withheld
   * (#94). The view measures drift and decides; the source applies it.
   *
   * **Read it when answering, not on entry.** Drift is sampled beside the loop
   * and lands whenever the check finishes, so a sample that lands while this
   * frame is still being inferred refuses *this* frame — which is how the gate
   * behaved while the loop and the model were one file, and what
   * `rr-live-view.test.ts` pins. Destructuring it in the parameter list reads
   * it on entry and costs the refusal a frame.
   */
  readonly drifted: boolean;
  /**
   * The layout's DPT, or `null` when calibration resolves none. Resolved once
   * from the archive by the view, so #166 stays one fix.
   */
  readonly dpt: number | null;
}

/**
 * L0, L1 and what the answer cost, for one frame.
 *
 * `sensorStates` holds **every** sensor, always: `occupancy()` is total, and a
 * source that answered a subset would put the view back in the business of
 * building `unknown`s of its own.
 */
export interface FrameResult {
  /** L0 for this frame. Empty, never stale, when nothing was inferred. */
  readonly detections: readonly Detection[];
  /** L1 for the same frame, keyed by sensor id — one entry per sensor. */
  readonly sensorStates: ReadonlyMap<string, SensorState>;
  /**
   * Milliseconds the inference alone took, or absent when nothing inferred.
   *
   * Absent rather than `0`: the stats bar shows the last number it was given, and
   * a frame with no model behind it has not measured a faster one.
   */
  readonly inference?: number;
}

/**
 * Where a frame's answers come from: the model in this page, or a service.
 *
 * `resultFor` never rejects. A frame that fails is one frame, and the loop must
 * keep running and report `unknown` for it rather than freezing the last
 * answer on screen.
 */
export interface ResultSource {
  /**
   * Prepare to answer.
   *
   * @returns why it cannot, as the message to show, or `null` when it can. Held
   *          as the message rather than a boolean because the causes are
   *          different jobs — no model published yet, a bundle built without
   *          one — and every sensor reads `unknown` either way.
   */
  open(): Promise<string | null>;
  /** Release the model, or the connection. */
  close(): void;
  /** L0 and L1 for one frame. Never rejects. */
  resultFor(frame: SourceFrame, context: ResultContext): Promise<FrameResult>;
}

/**
 * The pair `rr-live-view` runs on.
 *
 * Two fields rather than one object so that the local case — a camera and the
 * shipped detector — is expressible at all; #331's service fills both with the
 * same object.
 */
export interface LiveSources {
  readonly frames: FrameSource;
  readonly results: ResultSource;
}
