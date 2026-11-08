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

import type { Detection, Frame } from '@rails49/detector';
import type { Sensor, Track } from '@rails49/r49';
import type { LiveDetails } from './liveContract.js';
import type { SensorState } from './occupancy.js';

/**
 * What an occupancy service sent beyond L0 and L1, for `rr-service-details`
 * (#332): `LIVE.md`'s optional fields, with each sensor's patch as an object
 * URL. The source owns those URLs and releases them when its next answer
 * arrives.
 */
export interface ServiceDetails extends Omit<LiveDetails, 'patches'> {
  /** Sensor id to its patch's object URL. Absent where the service sent no `patches`. */
  readonly patches?: ReadonlyMap<string, string>;
}

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
  /**
   * What `rr-viewer` shows through `src`, for a source whose frames are
   * pictures rather than a stream (#331).
   *
   * Absent for a stream, where {@link FrameSource.stream} is the handover
   * instead, and absent on a turn that carried no new picture. The source owns
   * the URL and releases it; the view only shows it.
   */
  readonly src?: string;
  /**
   * Whether this turn carried a picture the view has not shown.
   *
   * Absent is `true` — a camera hands over the frame it just read. `false` is
   * an answer that carried no new frame: an occupancy service with nothing
   * to send, or a request of its that failed (#331). The view keeps the picture
   * already on screen, stops counting the turn toward the rate, and takes the
   * answers that came with it — which is how every sensor reads `unknown` and
   * the rate reads 0 while the service is quiet, instead of the last good
   * answers staying frozen on screen.
   *
   * Nothing may read pixels from a turn that is not fresh. `source` is then
   * whatever picture is still up, or an empty image where there has never been
   * one, and the view skips the drift grab for it.
   */
  readonly fresh?: boolean;
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
  /**
   * What `rr-viewer` shows, or `null` when the source is not a stream —
   * a service's frames arrive one at a time as {@link SourceFrame.src} (#331).
   */
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
  /**
   * L0 for this frame, or absent where the source publishes no L0 at all.
   *
   * Empty, never stale, when a model looked and found nothing. Absent is the
   * other fact: an occupancy service that has no DPT produces no boxes to
   * publish (#331), and nothing counted cars for this frame — so no boxes are
   * drawn and the stats bar shows no car count, where an empty list shows 0.
   */
  readonly detections?: readonly Detection[];
  /** L1 for the same frame, keyed by sensor id — one entry per sensor. */
  readonly sensorStates: ReadonlyMap<string, SensorState>;
  /**
   * Milliseconds the inference alone took, or absent when nothing inferred.
   *
   * Absent rather than `0`: the stats bar shows the last number it was given, and
   * a frame with no model behind it has not measured a faster one.
   */
  readonly inference?: number;
  /**
   * How far behind the frame on screen the L0 drawn over it is, in
   * milliseconds, or absent where the two are the same frame.
   *
   * A service infers on its own cadence and draws the newest L0 it has over the
   * frame it served, so the boxes may belong to an earlier moment than the
   * picture (#331). Both times are the source's clock; this page's plays no
   * part.
   */
  readonly l0Age?: number;
  /**
   * What to tell the user about this answer, or absent when there is
   * nothing to say.
   *
   * Distinct from {@link ResultSource.open}'s message, which is why the source
   * cannot answer at all. This one comes and goes with the answers: a service
   * with no frames says why, and a request that failed says that it did (#331).
   */
  readonly notice?: string;
  /**
   * What a service sent for this answer beyond L0 and L1 (#332). Absent from
   * the local model, and from a service's failed answer.
   */
  readonly details?: ServiceDetails;
}

/**
 * The layout a result source answers against, where it is not the view's
 * archive (#331).
 *
 * An occupancy service holds its own manifest, read from the service and not
 * from anything this page has open, and it is the sensors in *that* manifest
 * that its answers are keyed on and whose positions are drawn. The view takes
 * all three from here rather than from `archive`, which is also why an unsaved
 * edit in the editor cannot move what the live view draws.
 */
export interface SourceLayout {
  /** The sensors answered, in {@link resolution} pixels. */
  readonly sensors: readonly Sensor[];
  /** The frame those sensors and the detections are expressed in. */
  readonly resolution: Frame;
  /** Dots per track, or `null` where the layout resolves none. */
  readonly dpt: number | null;
  /** The layout's tracks, which the view draws while Details is open (#332). */
  readonly tracks: readonly Track[];
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
  /**
   * The layout these answers are about, or `null`/absent where the view's
   * `archive` is it.
   *
   * A getter, read by the view on every frame rather than once at `open()`:
   * a service re-reads its manifest whenever its event stream reconnects, and a
   * sensor that moved has to reach the viewer with the state keyed on it (#331).
   */
  readonly layout?: SourceLayout | null;
  /**
   * Ask for each sensor's patch from the next request on, or stop asking
   * (#332). Only a service has patches to send.
   */
  setPatches?(on: boolean): void;
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
