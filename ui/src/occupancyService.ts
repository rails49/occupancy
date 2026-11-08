/**
 * An occupancy service as the live view's source — both halves of it (#331).
 *
 * One object is the `FrameSource` **and** the `ResultSource`, because the
 * service answers `latest` with a frame and that frame's L1 together: splitting
 * it in two would mean two requests for one answer, and L1 that could belong to
 * a different frame than the picture under it. `liveSources.ts` is written for
 * exactly this — a frame may carry data only its own source reads, and
 * `rr-live-view` hands this in as both.
 *
 * **It never rejects, ever.** `ResultSource.resultFor` is contracted not to, and
 * `next()` holds to the same rule: a request that failed, a body that would not
 * parse, a version this page does not read — each becomes one answer in which
 * every sensor reads `unknown`, with a notice that the service cannot be
 * reached, and the object asks again. The alternative was named in #341: a source that rejects leaves the
 * last good answers frozen under a live-looking screen.
 *
 * **The manifest is the service's, not the page's.** It is read from
 * `<base>/archive/manifest.json` when the view opens and validated by
 * `R49Archive.setManifest`, and the sensors, the resolution and the DPT the view
 * draws all come from it — so an unsaved edit in the editor cannot move what the
 * live view shows. It is re-read on every reconnect of `events`, because
 * occupancy-service#7 drops every event client after a save and a connect is
 * therefore the full list of sensors.
 *
 * **What this does not do.** It loads no detector and measures no drift: the
 * service publishes states this page cannot withhold, and drift in service mode
 * is #336. The wire — every path, part and field — is `liveContract.ts`'s.
 */

import { R49Archive, getDPT } from '@rails49/r49';
import type { ManifestData } from '@rails49/r49';
import type {
  FrameResult,
  FrameSource,
  ResultSource,
  SourceFrame,
  SourceLayout,
} from './liveSources.js';
import type { SensorState } from './occupancy.js';
import {
  LATEST_TIMEOUT_MS,
  LIVE_BASE,
  eventsUrl,
  l0AgeMs,
  latestUrl,
  manifestUrl,
  readLatest,
} from './liveContract.js';
import type { LiveAnswer, LivePayload, LiveSensorState } from './liveContract.js';

/**
 * How long to wait after a failed `latest` before asking again.
 *
 * A second, not a tight retry: a service that is down stays down for longer
 * than that, and hammering it adds a request per frame to whatever is already
 * wrong. Short enough that a service coming back is picked up while the user is
 * still looking at the notice.
 */
const FAILED_RETRY_MS = 1000;

/**
 * How long to wait before reopening an `events` connection that closed for
 * good.
 *
 * `EventSource` retries a *dropped* connection itself, but a non-200 answer
 * closes it permanently — which is exactly what a service that is restarting
 * answers with. A few seconds, because the thing being waited for is a process
 * coming back up.
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
 * @param base where the service answers, on this origin. One constant in
 *             practice (`LIVE_BASE`); a parameter so the tests can tell two
 *             apart, not so a user can set it.
 */
export function occupancyService(base: string = LIVE_BASE): FrameSource & ResultSource {
  /** Whether the view still wants frames. `stop()` clears it and ends the loop. */
  let running = false;
  /** Whether the connection is alive at all — `close()` clears it for good. */
  let live = false;
  /** The service's own manifest, held and re-read; `null` until one validates. */
  let layout: SourceLayout | null = null;
  /** The last `frame_id` seen, sent back as `after` unchanged. */
  let lastId: string | null = null;
  /** The object URL the view is showing, which the next frame releases. */
  let shown: string | null = null;
  /** The last decoded picture, kept so a turn with no new frame can name it. */
  let picture: SourceFrame | null = null;
  /** The answers that came with the frame `next()` just handed over. */
  let pending: FrameResult | null = null;
  /** The request in flight, so leaving the view aborts it. */
  let inFlight: AbortController | null = null;
  /** How long to wait before the next ask, in ms, or `0` to ask at once. Set after a failure. */
  let pause = 0;
  let events: EventSource | null = null;
  let reopening: ReturnType<typeof setTimeout> | null = null;
  /** How many times `events` has connected. The first one read the manifest already. */
  let connects = 0;

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const text = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** Release an object URL, if there is one. */
  function release(url: string | null) {
    if (url !== null) URL.revokeObjectURL(url);
  }

  /**
   * Read the service's manifest and hold what the view draws from it.
   *
   * Validated through `R49Archive.setManifest`, which is the format's own
   * check: a service answering something that is not a v4 manifest is a service
   * whose sensor ids this page would key answers on blind.
   */
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
    };
  }

  /**
   * One `latest` answer, or why there is none.
   *
   * The timeout is a `setTimeout` over this request's own controller rather
   * than `AbortSignal.timeout`, so that `stop()` aborting and the clock running
   * out are the same mechanism and can be told apart by which one fired.
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
      const response = await fetch(latestUrl(base, lastId), { signal: controller.signal });
      return { answer: await readLatest(response) };
    } catch (err) {
      if (timedOut) return { failed: `no answer in ${LATEST_TIMEOUT_MS / 1000} s` };
      // Aborted by `stop()`: the session is over and the caller checks
      // `running` before doing anything with this.
      if (!running) return { failed: 'the view was left' };
      return { failed: text(err) };
    } finally {
      clearTimeout(timer);
      if (inFlight === controller) inFlight = null;
    }
  }

  /**
   * Decode a frame and make it the picture on screen.
   *
   * `decode()` and not an `onload`: `next()` must resolve only once there are
   * pixels, so a slow device holds the loop instead of letting requests outrun
   * it. The previous URL is released here — the view is about to be handed this
   * one, and the `<img>` showing the old one has long since loaded it.
   */
  async function decode(blob: Blob): Promise<SourceFrame> {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      // Left the view while this was decoding. `shutdown()` released the
      // handles it knew about, and this one was not among them yet — so it is
      // released here rather than left pinning a blob for the page's lifetime.
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
   * A turn that carried no new picture: the one on screen, marked not fresh.
   *
   * With nothing ever shown there is an empty image behind it, which nothing
   * reads — the view skips the drift grab on a turn like this, and a service
   * runs no model of this page's. See {@link SourceFrame.fresh}.
   */
  function stale(): SourceFrame {
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

  /** One sensor's state, as the service sent it. */
  function stateOf(entry: LiveSensorState): SensorState {
    switch (entry.state) {
      case 'occupied':
        // No `detection`: a service's classifier scores a patch and reports no
        // box (ADR 0022), and the boxes in `l0` are L0's and belong to whatever
        // frame the service inferred — pairing one with a sensor here would
        // invent an answer the service did not give.
        return { state: 'occupied', confidence: entry.confidence };
      case 'clear':
        return { state: 'clear' };
      case 'unknown':
        return { state: 'unknown', serviceReason: entry.reason };
    }
  }

  /**
   * The answers for one served frame.
   *
   * Keyed on the **held manifest**, not on what the service sent: a sensor the
   * service did not report reads `unknown` and says so, and a sensor the
   * manifest does not have is simply not drawn — the view's sensors are the
   * manifest's, and an answer about one it has never heard of has nowhere to go.
   */
  function answersFor(payload: LivePayload): FrameResult {
    const states = new Map<string, SensorState>();
    for (const sensor of layout?.sensors ?? []) {
      const entry = payload.l1[sensor.id];
      states.set(sensor.id, entry ? stateOf(entry) : { state: 'unknown', reason: 'not-reported' });
    }

    const l0 = payload.l0;
    if (l0 === undefined) {
      // No L0 at all, which is not an empty L0: no boxes are drawn and no car
      // count is shown. A service with no DPT produces none.
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
   * Hold one connection to `events`, and keep holding it.
   *
   * Nothing reads a message off it. L1 on screen comes only from `latest`, so
   * it always belongs to the frame shown; L1 arriving here would be about some
   * other frame, and drawing it over this one is the disagreement the single
   * source exists to prevent. What the stream is *for* is the connect: every
   * reconnect re-reads the manifest.
   */
  function connect() {
    if (!live || events !== null) return;
    if (typeof EventSource === 'undefined') {
      console.error('This browser has no EventSource, so sensor edits will not be picked up');
      return;
    }
    const stream = new EventSource(eventsUrl(base));
    events = stream;
    stream.onopen = () => {
      connects++;
      // The first connect follows the read in `open()`, so it has nothing to
      // add — unless that read **failed**, which is what a service that was
      // still starting up answers with: without this the session would hold no
      // manifest for the whole of its life and answer no sensor at all, even
      // once frames resumed. Every later connect is a client that was dropped —
      // occupancy-service#7 drops them all after a save — so the manifest may
      // have changed under it.
      if (connects > 1 || layout === null) void refresh();
    };
    stream.onerror = () => {
      // A dropped connection `EventSource` retries by itself. A non-200 answer
      // leaves it CLOSED for good, which is what a restarting service gives,
      // so that one is reopened here.
      if (stream.readyState !== EVENTSOURCE_CLOSED) return;
      stream.close();
      if (events === stream) events = null;
      if (!live) return;
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
      // Keeping the old manifest is the honest fallback: it was true a moment
      // ago, where dropping it would leave every sensor unanswerable over a
      // request that may succeed on the next connect.
      console.error('Failed to re-read the occupancy service manifest', err);
    }
  }

  /** Everything this holds, released. Safe to call twice, and without an `open()`. */
  function shutdown() {
    running = false;
    live = false;
    inFlight?.abort();
    inFlight = null;
    if (reopening !== null) clearTimeout(reopening);
    reopening = null;
    events?.close();
    events = null;
    release(shown);
    shown = null;
    picture = null;
    pending = null;
    // A session that was left mid-wait must not make the next one sit out a
    // pause it never earned.
    pause = 0;
  }

  return {
    // No stream and no camera: the frames arrive one at a time as
    // `SourceFrame.src`, and there are no camera settings for the drift rows to
    // record because nothing here measures drift (#336).
    stream: null,
    settings: {},

    get layout() {
      return layout;
    },

    async start() {
      running = true;
      live = true;
    },

    async open() {
      running = true;
      live = true;
      connects = 0;
      // Before `events`, so the first connect is not mistaken for a reconnect
      // and does not read the manifest a second time.
      let error: string | null = null;
      try {
        await readManifest();
      } catch (err) {
        console.error(`Failed to read the occupancy service manifest at ${base}`, err);
        error = text(err);
      }
      connect();
      return error;
    },

    stop() {
      shutdown();
    },

    // Called even where `open()` never was — the view closes the result source
    // on disconnect whatever happened before it (#341) — so this has to be a
    // no-op in that case, which `shutdown()` is.
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

        if ('failed' in result) {
          // One answer saying so, then ask again. The screen keeps its picture
          // and loses its answers, which is the honest pair.
          console.error(`Cannot read the occupancy service at ${base}: ${result.failed}`);
          pause = FAILED_RETRY_MS;
          pending = unreachable();
          return stale();
        }

        const { payload, frame } = result.answer;

        if (frame === null) {
          // Only the `json` part: the service has no frame. `LIVE.md` has it
          // wait about 1 s before answering so, which paces this loop. The
          // picture stays with no boxes, and each sensor carries the
          // service's reason.
          pending = { sensorStates: answersFor(payload).sensorStates, notice: NO_PICTURE };
          return stale();
        }

        // **Different**, not greater. The id is the service's token and this
        // page never orders it, so a service that restarted and numbered from
        // scratch recovers on its next answer instead of being ignored forever.
        if (payload.frame_id === lastId) {
          // The same frame as last time is not a new frame, and its answers
          // belong to the picture already up. Ask again: `after` held the
          // request for about 1 s.
          continue;
        }

        let decoded: SourceFrame;
        try {
          decoded = await decode(frame);
        } catch (err) {
          // The session ending is not a decode this page should report.
          if (!running) return null;
          console.error(`Cannot decode the occupancy service's frame: ${text(err)}`);
          pause = FAILED_RETRY_MS;
          pending = unreachable();
          return stale();
        }

        lastId = payload.frame_id;
        pending = answersFor(payload);
        return decoded;
      }
      return null;
    },

    /**
     * The answers that came with the frame just handed over.
     *
     * The loop asks for a frame and then for its answers, one for one, so this
     * is the answer `next()` set. `context` is unread: the drift refusal is not
     * this page's to apply to a service's states, and the DPT is the service's
     * manifest's.
     */
    async resultFor(): Promise<FrameResult> {
      return pending ?? unreachable();
    },
  };
}
