/**
 * An occupancy service as the live view's source (#331).
 *
 * One object is both the `FrameSource` and the `ResultSource`: the service
 * answers `latest` with a frame and that frame's L1 together, so L1 on screen
 * always belongs to the picture under it.
 *
 * `next()` and `resultFor` never reject. A request that fails becomes one
 * answer in which every sensor reads `unknown` under the notice "Cannot reach
 * the occupancy service", and the object asks again (#341).
 *
 * The sensors, resolution and DPT come from the service's manifest, read from
 * `<base>/archive/manifest.json` at `open()`, validated by
 * `R49Archive.setManifest`, and re-read on every reconnect of `events`
 * (occupancy-service#7 drops every event client after a save). An unsaved edit
 * in the editor does not change what the live view draws.
 *
 * It loads no detector and measures no drift (#336). Paths, parts and fields
 * are `liveContract.ts`'s.
 */

import { R49Archive, getDPT } from '@rails49/r49';
import type { ManifestData } from '@rails49/r49';
import type {
  FrameResult,
  FrameSource,
  ResultSource,
  ServiceDetails,
  ShownFrame,
  SourceFrame,
  SourceLayout,
} from './liveSources.js';
import type { SensorState } from './occupancy.js';
import {
  LATEST_TIMEOUT_MS,
  LIVE_BASE,
  errorText,
  eventsUrl,
  l0AgeMs,
  latestUrl,
  manifestUrl,
  readLatest,
} from './liveContract.js';
import type { LiveAnswer, LiveDetails, LivePayload, LiveSensorState } from './liveContract.js';

/** How long to wait after a failed `latest` before asking again. */
const FAILED_RETRY_MS = 1000;

/**
 * How long to wait before reopening an `events` connection that closed for
 * good. `EventSource` retries a dropped connection itself, but not one that got
 * a non-200 answer, which is what a restarting service gives.
 */
const EVENTS_RETRY_MS = 5000;

/** `EventSource.CLOSED`, which a fake in a test need not carry as a static. */
const EVENTSOURCE_CLOSED = 2;

/** The notice while the service answers with no frame. Each sensor carries the service's reason. */
const NO_PICTURE = 'No picture from the camera';

/** The notice while the service's answer cannot be read. */
const NO_SERVICE = 'Cannot reach the occupancy service';

/**
 * The occupancy service at `base` as one source for the live view.
 *
 * @param base where the service answers, on this origin. `LIVE_BASE` in the
 *             page; tests pass their own.
 */
export function occupancyService(base: string = LIVE_BASE): FrameSource & ResultSource {
  /** Between `start()` or `open()` and `stop()` or `close()`. */
  let running = false;
  /** The service's own manifest, held and re-read; `null` until one validates. */
  let layout: SourceLayout | null = null;
  /** The last `frame_id` seen, sent back as `after` unchanged. */
  let lastId: string | null = null;
  /** The object URL the view is showing, which the next frame releases. */
  let shown: string | null = null;
  /**
   * The bytes behind that URL, with the id of the answer they came in, for
   * Freeze (#334); `null` while the current answer carries no frame.
   *
   * Held separately from the object URL because a URL is not readable bytes:
   * fetching it back would be a second read of a frame this object already
   * has, and one that fails once the URL is revoked. It is replaced at the
   * moment the URL is, so what Freeze adds is always the picture on screen.
   */
  let shownFrame: ShownFrame | null = null;
  /** Whether to ask for patches, from the next request on (#332). */
  let patches = false;
  /** The patch URLs of the last answer, which the next answer releases. */
  let patchUrls: string[] = [];
  /** The last decoded picture, kept so a turn with no new frame can hand it over again. */
  let picture: SourceFrame | null = null;
  /** The answers that came with the frame `next()` just handed over. */
  let pending: FrameResult | null = null;
  /** The request in flight, so leaving the view aborts it. */
  let inFlight: AbortController | null = null;
  /** How long to wait before the next ask, in ms. Set after a failure. */
  let pause = 0;
  let events: EventSource | null = null;
  let reopening: ReturnType<typeof setTimeout> | null = null;
  /** How many times `events` has connected. */
  let connects = 0;

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /** Release an object URL, if there is one. */
  function release(url: string | null) {
    if (url !== null) URL.revokeObjectURL(url);
  }

  /** Release the last answer's patch URLs. */
  function releasePatches() {
    for (const url of patchUrls) URL.revokeObjectURL(url);
    patchUrls = [];
  }

  /** One answer's details, with its patches as object URLs in place of the last answer's. */
  function detailsOf(live: LiveDetails): ServiceDetails {
    releasePatches();
    const { patches: parts, ...fields } = live;
    if (parts === undefined) return fields;
    const urls = new Map<string, string>();
    for (const [id, blob] of parts) {
      const url = URL.createObjectURL(blob);
      patchUrls.push(url);
      urls.set(id, url);
    }
    return { ...fields, patches: urls };
  }

  /** Read the service's manifest and hold what the view draws from it. */
  async function readManifest(): Promise<void> {
    const response = await fetch(manifestUrl(base));
    if (!response.ok) throw new Error(`the manifest answered ${response.status}`);
    const archive = new R49Archive();
    archive.setManifest((await response.json()) as ManifestData);
    const manifest = archive.getManifest();
    layout = {
      sensors: manifest.layout.sensors ?? [],
      resolution: manifest.camera.resolution,
      dpt: getDPT(manifest),
      tracks: manifest.layout.tracks ?? [],
    };
  }

  /**
   * One `latest` answer, or why there is none.
   *
   * The timeout aborts this request's own controller, as `stop()` does;
   * `timedOut` tells the two apart.
   */
  async function ask(): Promise<{ answer: LiveAnswer } | { failed: string }> {
    const controller = new AbortController();
    inFlight = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LATEST_TIMEOUT_MS);
    try {
      const response = await fetch(latestUrl(base, lastId, patches), { signal: controller.signal });
      return { answer: await readLatest(response) };
    } catch (err) {
      if (timedOut) return { failed: `no answer in ${LATEST_TIMEOUT_MS / 1000} s` };
      // Aborted by `stop()`. The caller checks `running` before using this.
      if (!running) return { failed: 'the view was left' };
      return { failed: errorText(err) };
    } finally {
      clearTimeout(timer);
      if (inFlight === controller) inFlight = null;
    }
  }

  /**
   * Decode a frame and make it the picture on screen.
   *
   * `next()` resolves only after this, so a slow device holds the loop. The
   * previous URL is released here.
   */
  async function decode(blob: Blob): Promise<SourceFrame> {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      // Left the view while this was decoding. `shutdown()` did not know this
      // URL, so the catch below releases it.
      if (!running) throw new Error('the view was left while a frame was decoding');
      release(shown);
      shown = url;
      picture = {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        src: url,
      };
      return picture;
    } catch (err) {
      release(url);
      throw err;
    }
  }

  /**
   * The picture already on screen, marked not fresh, for a turn with no new
   * frame. With nothing shown yet it is an empty image, which nothing reads.
   * See {@link SourceFrame.fresh}.
   */
  function samePicture(): SourceFrame {
    if (picture !== null) {
      return { source: picture.source, width: picture.width, height: picture.height, fresh: false };
    }
    return { source: new Image(), width: 0, height: 0, fresh: false };
  }

  /** Every sensor in the held manifest `unknown` because the service cannot be read. */
  function unreachable(): FrameResult {
    const states = new Map<string, SensorState>();
    for (const sensor of layout?.sensors ?? []) {
      states.set(sensor.id, { state: 'unknown', reason: 'no-service' });
    }
    return { sensorStates: states, notice: NO_SERVICE };
  }

  /** Log a failed turn, answer it with `unreachable()`, and ask again after a pause. */
  function failed(detail: string): SourceFrame {
    console.error(`Cannot read the occupancy service at ${base}: ${detail}`);
    pause = FAILED_RETRY_MS;
    releasePatches();
    // The picture stays up, but nothing may be added from it: this answer
    // carried no frame, and the one on screen is out of date (#334).
    shownFrame = null;
    pending = unreachable();
    return samePicture();
  }

  /** One sensor's state, as the service sent it. */
  function stateOf(entry: LiveSensorState): SensorState {
    switch (entry.state) {
      case 'occupied':
        // No `detection`: a classifier reports no box (ADR 0022), and the boxes
        // in `l0` may belong to an earlier frame.
        return { state: 'occupied', confidence: entry.confidence };
      case 'clear':
        return { state: 'clear' };
      case 'unknown':
        return { state: 'unknown', serviceReason: entry.reason };
    }
  }

  /**
   * The answers for one served frame, keyed on the held manifest. A sensor the
   * service did not report reads `unknown` (`not-reported`). A sensor the
   * manifest lacks is not drawn, so it gets no state.
   */
  function answersFor(payload: LivePayload): FrameResult {
    const states = new Map<string, SensorState>();
    for (const sensor of layout?.sensors ?? []) {
      const entry = payload.l1[sensor.id];
      states.set(sensor.id, entry ? stateOf(entry) : { state: 'unknown', reason: 'not-reported' });
    }

    const l0 = payload.l0;
    if (l0 === undefined) {
      // No L0, which differs from an empty L0: no boxes and no car count.
      return { sensorStates: states };
    }
    const age = l0AgeMs(payload);
    return {
      ...(l0.detections === undefined ? {} : { detections: l0.detections }),
      sensorStates: states,
      ...(age === null ? {} : { l0Age: age }),
    };
  }

  /**
   * Hold one connection to `events`. No message is read from it: L1 on screen
   * comes only from `latest`. Each reconnect re-reads the manifest.
   */
  function connect() {
    if (!running || events !== null) return;
    const stream = new EventSource(eventsUrl(base));
    events = stream;
    stream.onopen = () => {
      connects++;
      // The first connect follows the read in `open()`. It reads again only if
      // that read failed, as it does while a service is starting up.
      if (connects > 1 || layout === null) void refresh();
    };
    stream.onerror = () => {
      if (stream.readyState !== EVENTSOURCE_CLOSED) return;
      stream.close();
      if (events === stream) events = null;
      if (!running) return;
      reopening = setTimeout(() => {
        reopening = null;
        connect();
      }, EVENTS_RETRY_MS);
    };
  }

  /** Re-read the manifest, keeping the held one where the read fails. */
  async function refresh() {
    try {
      await readManifest();
    } catch (err) {
      console.error('Failed to re-read the occupancy service manifest', err);
    }
  }

  /** Everything this holds, released. Safe to call twice, and without an `open()`. */
  function shutdown() {
    running = false;
    inFlight?.abort();
    inFlight = null;
    if (reopening !== null) clearTimeout(reopening);
    reopening = null;
    events?.close();
    events = null;
    release(shown);
    shown = null;
    shownFrame = null;
    releasePatches();
    picture = null;
    pending = null;
    pause = 0;
  }

  return {
    // Frames arrive one at a time as `SourceFrame.src`. No camera settings:
    // nothing here measures drift (#336).
    stream: null,
    settings: {},

    get layout() {
      return layout;
    },

    // The frame on screen, for Freeze (#334). A getter: it moves with the
    // picture, and the view reads it once per turn.
    get shownFrame() {
      return shownFrame;
    },

    async start() {
      running = true;
    },

    async open() {
      running = true;
      connects = 0;
      let error: string | null = null;
      try {
        await readManifest();
      } catch (err) {
        console.error(`Failed to read the occupancy service manifest at ${base}`, err);
        error = errorText(err);
      }
      connect();
      return error;
    },

    stop() {
      shutdown();
    },

    setPatches(on: boolean) {
      patches = on;
    },

    // The view calls this even where `open()` never ran (#341).
    close() {
      shutdown();
    },

    async next(): Promise<SourceFrame | null> {
      while (running) {
        if (pause > 0) {
          const waited = pause;
          pause = 0;
          await sleep(waited);
          if (!running) return null;
        }

        const result = await ask();
        if (!running) return null;
        if ('failed' in result) return failed(result.failed);

        const { payload, frame, details } = result.answer;

        if (frame === null) {
          // The service has no frame. `LIVE.md` has it wait about 1 s before
          // answering so, which paces this loop. The picture stays with no
          // boxes, and each sensor carries the service's reason.
          pending = {
            sensorStates: answersFor(payload).sensorStates,
            notice: NO_PICTURE,
            details: detailsOf(details),
          };
          // Nothing to freeze: the picture on screen is older than what the
          // service is now saying about the camera (#334).
          shownFrame = null;
          return samePicture();
        }

        // A frame is new when its id differs from the last, not when it is
        // greater, so a restarted service that numbers from scratch recovers.
        // A repeated id is not a new frame; `after` held the request for about
        // 1 s, so ask again.
        if (payload.frame_id === lastId) continue;

        let decoded: SourceFrame;
        try {
          decoded = await decode(frame);
        } catch (err) {
          if (!running) return null;
          return failed(`the frame did not decode: ${errorText(err)}`);
        }

        lastId = payload.frame_id;
        // Set once the frame is the one on screen, so a press while a newer
        // answer is still decoding adds the picture the person is looking at.
        // `readLatest` refuses an answer whose frame and `frame_id` disagree,
        // which is why there is an id to carry here.
        shownFrame = { id: payload.frame_id!, bytes: frame };
        pending = { ...answersFor(payload), details: detailsOf(details) };
        return decoded;
      }
      return null;
    },

    /**
     * The answers that came with the frame `next()` just handed over. `context`
     * is unread: a service applies its own drift refusal and DPT.
     */
    async resultFor(): Promise<FrameResult> {
      return pending ?? unreachable();
    },
  };
}
