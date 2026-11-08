import { describe, it, expect, vi, afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { occupancyService } from '../src/occupancyService.js';
import { LATEST_TIMEOUT_MS } from '../src/liveContract.js';
import type { SourceFrame } from '../src/liveSources.js';
import {
  errorAnswer,
  htmlAnswer,
  jsonAnswer,
  multipartAnswer,
  useNodeFileGlobals,
} from './liveFixture.js';

// The service as a source (#331): a stubbed `fetch` over real multipart bodies,
// a fake `EventSource` — jsdom has none — and a stubbed `decode`, which jsdom
// does not implement either. What is real here is the whole of the object's
// own behaviour: which URL it asks, what it does with each answer, which
// sensors it keys on, and what it releases when the view is left.

const fileGlobals = useNodeFileGlobals();
beforeAll(() => fileGlobals.install());
afterAll(() => fileGlobals.restore());

const BASE = '/live';

const SENSOR_A = 'Sserviceaaa';
const SENSOR_B = 'Sservicebbb';

const DETECTION = {
  centre: { x: 100, y: 200 },
  length: 180,
  width: 42,
  angle: 0,
  class: 'stock',
  confidence: 0.84,
};

/** A v4 manifest the service would answer with, with `x` for the first sensor. */
function manifest(x = 10) {
  return {
    version: 4,
    layout: {
      name: 'Served Layout',
      scale: 'N',
      // 100 px over 10 model mm in N scale: DPT 89.6875.
      calibration: {
        points: [
          { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
          { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
        ],
      },
      sensors: [
        { id: SENSOR_A, x, y: 20 },
        { id: SENSOR_B, x: 60, y: 70 },
      ],
    },
    camera: { resolution: { width: 640, height: 480 } },
    images: [],
  };
}

const DPT = 89.6875;

/** A full `latest` payload, with every L1 state and an `l0`. */
function payload(id = 'f-1') {
  return {
    version: 1,
    frame_id: id,
    captured_at: '2026-11-05T10:00:01.500Z',
    sensors: {
      [SENSOR_A]: { state: 'occupied', confidence: 0.66 },
      [SENSOR_B]: { state: 'clear' },
      // A sensor the service reported and the manifest does not have. Nothing
      // draws it, so nothing may key on it.
      Sstranger001: { state: 'occupied', confidence: 0.99 },
    },
    l0: {
      frame_id: 'f-0',
      captured_at: '2026-11-05T10:00:01.200Z',
      detections: [DETECTION],
    },
  };
}

/** Every `EventSource` the module opened, with the hooks a test fires by hand. */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly listened: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  addEventListener(type: string) {
    this.listened.push(type);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  /** The server accepted the connection. */
  connect() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** A failure, either the kind EventSource retries or the kind it does not. */
  fail({ permanent }: { permanent: boolean }) {
    this.readyState = permanent ? 2 : 0;
    this.onerror?.();
  }
}

describe('occupancyService', () => {
  let answers: Response[];
  let asked: string[];
  let manifests: unknown[];
  let created: string[];
  let revoked: string[];
  let decodes: { resolve: () => void }[];

  /**
   * Hand out the queued answers for `latest`, repeating the last one.
   *
   * **Each is handed over as a `clone()`.** A body can be read once, and the
   * last answer queued is meant to repeat for the rest of the session — handing
   * back the same `Response` twice would make the second read fail and send the
   * object down its failure path, which is a different test than the one being
   * written.
   */
  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
        asked.push(url);
        if (url.startsWith(`${BASE}/archive/`)) {
          if (manifests.length === 0) manifests.push(manifest());
          // The last one queued repeats, as a service answering the same
          // manifest over and over would.
          const next = manifests.length > 1 ? manifests.shift() : manifests[0];
          return next instanceof Response ? next.clone() : jsonAnswer(next);
        }
        const answer = answers.length > 1 ? answers.shift()! : answers[0];
        if (answer === undefined) {
          // Nothing queued: hang until aborted, which is what long-polling a
          // service that never answers looks like.
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          });
        }
        return answer.clone();
      })
    );
  }

  beforeEach(() => {
    answers = [];
    asked = [];
    manifests = [];
    created = [];
    revoked = [];
    decodes = [];
    FakeEventSource.opened = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    // Per test, so a test can tell one handle from another: the global in
    // `setup.ts` returns `undefined` for every call.
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:frame-${created.length}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => revoked.push(url));
    // jsdom implements neither `decode` nor layout, so the decoded size is 0
    // here — nothing in service mode reads it.
    HTMLImageElement.prototype.decode = () => Promise.resolve();
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Open a service with `answers` queued, and the stream connected. */
  async function opened(queued: Response[] = []) {
    answers = queued;
    const source = occupancyService(BASE);
    const error = await source.open();
    FakeEventSource.opened[0]?.connect();
    return { source, error };
  }

  const latestAsks = () => asked.filter(url => url.startsWith(`${BASE}/latest`));

  describe('a full answer', () => {
    it('shows the frame, keys L1 on the held manifest, and draws the L0 it was sent', async () => {
      const { source, error } = await opened([multipartAnswer(payload())]);

      expect(error).to.be.null;
      expect(asked[0]).toBe('/live/archive/manifest.json');
      expect(source.layout).toEqual({
        sensors: manifest().layout.sensors,
        resolution: { width: 640, height: 480 },
        dpt: DPT,
      });

      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });

      expect(frame.src).toBe('blob:frame-0');
      expect(frame.fresh).to.not.equal(false);
      // The first ask carries no `after`; the id is only known afterwards.
      expect(latestAsks()[0]).toBe('/live/latest');

      // Each state as sent, and no `detection` on the occupied one: the
      // service's classifier reports a probability and no box.
      expect(result.sensorStates.get(SENSOR_A)).toEqual({ state: 'occupied', confidence: 0.66 });
      expect(result.sensorStates.get(SENSOR_B)).toEqual({ state: 'clear' });
      // A sensor the manifest does not have is not drawn, so it is not answered.
      expect(result.sensorStates.has('Sstranger001')).toBe(false);
      expect(result.sensorStates.size).toBe(2);

      expect(result.detections).toEqual([DETECTION]);
      // The served frame's capture time minus L0's own, both the service's clock.
      expect(result.l0Age).toBe(300);
      // Nothing of this page's inferred anything.
      expect(result.inference).toBeUndefined();
      expect(result.notice).toBeUndefined();

      source.close();
    });

    it('reads a sensor the service did not report as unknown, and says so', async () => {
      const quiet = { ...payload(), sensors: { [SENSOR_A]: { state: 'occupied', confidence: 0.5 } } };
      const { source } = await opened([multipartAnswer(quiet)]);

      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });

      expect(result.sensorStates.get(SENSOR_B)).toEqual({
        state: 'unknown',
        message: 'the service did not report this sensor',
      });
      source.close();
    });

    it("shows a service's own unknown reason as sent", async () => {
      const refused = {
        ...payload(),
        sensors: { [SENSOR_A]: { state: 'unknown', reason: 'drift' } },
      };
      const { source } = await opened([multipartAnswer(refused)]);

      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });

      expect(result.sensorStates.get(SENSOR_A)).toEqual({ state: 'unknown', message: 'drift' });
      source.close();
    });

    it('sends the id back unchanged on the next ask', async () => {
      const { source } = await opened([
        multipartAnswer(payload('f-1')),
        multipartAnswer(payload('f-2')),
      ]);

      await source.next();
      await source.next();

      expect(latestAsks()).toEqual(['/live/latest', '/live/latest?after=f-1']);
      source.close();
    });
  });

  describe('L0', () => {
    it('reports no L0 at all where the answer carries none', async () => {
      // Which is a service with no DPT: no boxes to draw and no car count.
      const bare = { version: 1, frame_id: 'f-1', sensors: {} };
      const { source } = await opened([multipartAnswer(bare)]);

      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });

      expect(result.detections).toBeUndefined();
      expect(result.l0Age).toBeUndefined();
      source.close();
    });

    it('reports an empty L0 as an empty list, which is 0 cars', async () => {
      const empty = {
        ...payload(),
        l0: { frame_id: 'f-0', captured_at: '2026-11-05T10:00:01.200Z', detections: [] },
      };
      const { source } = await opened([multipartAnswer(empty)]);

      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });

      expect(result.detections).toEqual([]);
      source.close();
    });
  });

  describe('which frames count as new', () => {
    it('asks again when the answer repeats the last id', async () => {
      const { source } = await opened([
        multipartAnswer(payload('f-1')),
        multipartAnswer(payload('f-1')),
        multipartAnswer(payload('f-2')),
      ]);

      await source.next();
      const started = performance.now();
      const second = (await source.next())!;

      // Three asks for two frames: the repeat was not a frame.
      expect(latestAsks()).toHaveLength(3);
      expect(second.src).toBe('blob:frame-1');
      // And the re-ask was paced. A service that answers "nothing new" at once
      // rather than holding the request would otherwise spin this loop.
      expect(performance.now() - started).toBeGreaterThan(100);
      source.close();
    });

    it('counts a different, lower id as a new frame', async () => {
      // The id is the service's token and this page never orders it, so a
      // service that restarted and numbered from scratch recovers on its next
      // answer rather than being ignored for the rest of the session.
      const { source } = await opened([
        multipartAnswer(payload('f-900')),
        multipartAnswer(payload('f-1')),
      ]);

      const first = (await source.next())!;
      const second = (await source.next())!;

      expect(first.src).toBe('blob:frame-0');
      expect(second.src).toBe('blob:frame-1');
      expect(second.fresh).to.not.equal(false);
      expect(latestAsks()[1]).toBe('/live/latest?after=f-900');
      source.close();
    });

    it('resolves only once the frame has decoded, so asks cannot outrun the device', async () => {
      HTMLImageElement.prototype.decode = () =>
        new Promise<void>(resolve => decodes.push({ resolve }));
      const { source } = await opened([multipartAnswer(payload())]);

      let frame: SourceFrame | null | undefined;
      void source.next().then(answer => (frame = answer));
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(frame).toBeUndefined();
      expect(latestAsks()).toHaveLength(1);

      decodes[0].resolve();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(frame?.src).toBe('blob:frame-0');
      source.close();
    });
  });

  describe('no frames, and a failed request', () => {
    /**
     * Every answer that cannot become a frame, and what the notice says.
     *
     * A JSON-only answer is the service saying it has none, and carries its own
     * reason. The rest are the request failing, which says so instead.
     */
    const broken: [string, () => Response, RegExp][] = [
      ['a JSON-only answer', () => jsonAnswer({ version: 1, reason: 'the camera stopped' }), /the camera stopped/],
      ['this page\'s own HTML', () => htmlAnswer(), /could not be read/],
      ['a 500', () => errorAnswer(500), /could not be read/],
      ['a malformed body', () => new Response('{', { headers: { 'content-type': 'application/json' } }), /could not be read/],
      ['a version it does not read', () => multipartAnswer({ ...payload(), version: 7 }), /could not be read/],
    ];

    for (const [what, answer, notice] of broken) {
      it(`gives unknown for every sensor on ${what}, and recovers on the next answer`, async () => {
        const { source } = await opened([answer(), multipartAnswer(payload('f-9'))]);

        const first = (await source.next())!;
        const blind = await source.resultFor(first, { drifted: false, dpt: null });

        // No new picture, so the one on screen stays and the turn does not
        // count toward the rate.
        expect(first.fresh).toBe(false);
        expect(first.src).toBeUndefined();
        expect(blind.detections).toBeUndefined();
        expect(blind.notice).toMatch(notice);
        expect([...blind.sensorStates.keys()]).toEqual([SENSOR_A, SENSOR_B]);
        for (const state of blind.sensorStates.values()) {
          expect(state.state).toBe('unknown');
        }

        // And the next answer recovers: the id was never advanced past a
        // failure, so nothing is skipped.
        const next = (await source.next())!;
        const good = await source.resultFor(next, { drifted: false, dpt: null });
        expect(next.src).toBe('blob:frame-0');
        expect(good.sensorStates.get(SENSOR_A)).toEqual({ state: 'occupied', confidence: 0.66 });
        expect(good.notice).toBeUndefined();

        source.close();
      });
    }

    it('calls a request with no answer a failure, and asks again', async () => {
      vi.useFakeTimers();
      const source = occupancyService(BASE);
      // `open()` and the first ask both need the stubbed clock advanced.
      const opening = source.open();
      await vi.advanceTimersByTimeAsync(0);
      await opening;

      let frame: SourceFrame | null | undefined;
      void source.next().then(answer => (frame = answer));
      await vi.advanceTimersByTimeAsync(LATEST_TIMEOUT_MS - 1);
      expect(frame).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2);
      expect(frame?.fresh).toBe(false);
      const blind = await source.resultFor(frame!, { drifted: false, dpt: null });
      expect(blind.notice).toMatch(/no answer in 5 s/);

      source.close();
    });

    it('keeps the picture it has while it cannot be read', async () => {
      const { source } = await opened([
        multipartAnswer(payload('f-1')),
        jsonAnswer({ version: 1, reason: 'the camera stopped' }),
      ]);

      const shown = (await source.next())!;
      const quiet = (await source.next())!;

      expect(shown.src).toBe('blob:frame-0');
      // The same pixels, marked not fresh, and no `src` — the view keeps
      // showing what it already has.
      expect(quiet.source).toBe(shown.source);
      expect(quiet.fresh).toBe(false);
      // And the handle is still live: nothing released it.
      expect(revoked).toEqual([]);
      source.close();
    });
  });

  describe('what paces the asks', () => {
    it('takes real time over a service that answers at once that it has no frames', async () => {
      // `latest` with `after` is a long poll, so a service with nothing new
      // holds the request — but the pacing must not depend on that.
      // `bin/live-stub.mjs --no-frames` answers immediately, and an unpaced
      // loop spins one fetch, one state map and one render per turn as fast as
      // the network allows. The threshold is an order-of-magnitude claim, not
      // the pause: exporting that constant so a test could name it would make a
      // timing choice part of this object's surface.
      const { source } = await opened([jsonAnswer({ version: 1, reason: 'no camera' })]);

      const started = performance.now();
      for (let turn = 0; turn < 4; turn++) {
        const frame = (await source.next())!;
        await source.resultFor(frame, { drifted: false, dpt: null });
      }
      const elapsed = performance.now() - started;

      expect(latestAsks()).toHaveLength(4);
      expect(elapsed).toBeGreaterThan(100);
      source.close();
    });
  });

  describe('the event stream', () => {
    it('holds one connection, and reads no L1 from it', async () => {
      // L1 on screen comes only from `latest`, so it always belongs to the
      // frame shown. L1 arriving here would be about another frame.
      const { source } = await opened([multipartAnswer(payload())]);

      expect(FakeEventSource.opened).toHaveLength(1);
      expect(FakeEventSource.opened[0].url).toBe('/live/events');
      expect(FakeEventSource.opened[0].onmessage).to.be.null;
      expect(FakeEventSource.opened[0].listened).toEqual([]);
      source.close();
    });

    it('re-reads the manifest on every connect after the first', async () => {
      // occupancy-service#7 drops every event client after a save, so a
      // connect is the full list of sensors.
      manifests = [manifest(10), manifest(77)];
      const { source } = await opened([multipartAnswer(payload())]);

      expect(source.layout!.sensors[0].x).toBe(10);
      // The first connect followed the read in `open()` and must not read again.
      expect(asked.filter(url => url.includes('manifest.json'))).toHaveLength(1);

      FakeEventSource.opened[0].fail({ permanent: false });
      FakeEventSource.opened[0].connect();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(asked.filter(url => url.includes('manifest.json'))).toHaveLength(2);
      expect(source.layout!.sensors[0].x).toBe(77);
      source.close();
    });

    it('reads the manifest on the first connect when opening could not', async () => {
      // A service that was still starting up answers `open()`'s read with a
      // 503. Skipping the first connect's read would leave the session holding
      // no manifest at all — answering no sensor, drawing none, and keeping the
      // notice — for the whole of its life, even once frames resumed.
      manifests = [errorAnswer(503), manifest(42)];
      answers = [multipartAnswer(payload())];
      const source = occupancyService(BASE);

      expect(await source.open()).to.be.a('string');
      expect(source.layout).to.be.null;

      FakeEventSource.opened[0].connect();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(source.layout!.sensors[0].x).toBe(42);
      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });
      expect(result.sensorStates.size).toBe(2);
      source.close();
    });

    it('keeps the manifest it holds when a re-read fails', async () => {
      manifests = [manifest(10), errorAnswer(503)];
      const { source } = await opened([multipartAnswer(payload())]);

      FakeEventSource.opened[0].connect();
      await new Promise(resolve => setTimeout(resolve, 0));

      // It was true a moment ago, where dropping it leaves every sensor
      // unanswerable over a request that may succeed on the next connect.
      expect(source.layout!.sensors[0].x).toBe(10);
      source.close();
    });

    it('reopens a connection that closed for good', async () => {
      // EventSource retries a dropped connection itself but not a non-200
      // answer, which is what a restarting service gives.
      vi.useFakeTimers();
      const source = occupancyService(BASE);
      const opening = source.open();
      await vi.advanceTimersByTimeAsync(0);
      await opening;
      FakeEventSource.opened[0].connect();

      FakeEventSource.opened[0].fail({ permanent: true });
      expect(FakeEventSource.opened[0].closed).toBe(true);
      expect(FakeEventSource.opened).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeEventSource.opened).toHaveLength(2);

      source.close();
    });

    it('does not reopen after the view was left', async () => {
      vi.useFakeTimers();
      const source = occupancyService(BASE);
      const opening = source.open();
      await vi.advanceTimersByTimeAsync(0);
      await opening;

      source.close();
      FakeEventSource.opened[0].fail({ permanent: true });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(FakeEventSource.opened).toHaveLength(1);
    });
  });

  describe('leaving the view', () => {
    it('aborts the request in flight, closes the stream, ends the loop and releases every handle', async () => {
      const { source } = await opened([
        multipartAnswer(payload('f-1')),
        multipartAnswer(payload('f-2')),
      ]);

      await source.next();
      await source.next();
      // The first handle went when the second frame replaced it on screen.
      expect(created).toEqual(['blob:frame-0', 'blob:frame-1']);
      expect(revoked).toEqual(['blob:frame-0']);

      // A third ask is in flight with nothing queued behind it, so it hangs
      // until the abort.
      answers = [];
      const pending = source.next();
      source.stop();
      source.close();

      // `null` is the loop's one way out.
      expect(await pending).to.be.null;
      expect(FakeEventSource.opened[0].closed).toBe(true);
      expect(revoked).toEqual(['blob:frame-0', 'blob:frame-1']);
      // And it stays ended: nothing asks again.
      const asksAtClose = latestAsks().length;
      expect(await source.next()).to.be.null;
      expect(latestAsks()).toHaveLength(asksAtClose);
    });

    it('releases a handle for a frame that was still decoding', async () => {
      // `shutdown()` releases what it knows about, and a frame decoding when
      // the view was left is not among it yet — so the decode releases its own
      // handle rather than pinning a blob for the page's lifetime.
      let finish!: () => void;
      HTMLImageElement.prototype.decode = () => new Promise<void>(resolve => (finish = resolve));
      const { source } = await opened([multipartAnswer(payload())]);

      const pending = source.next();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(created).toEqual(['blob:frame-0']);

      source.close();
      finish();

      expect(await pending).to.be.null;
      expect(revoked).toEqual(['blob:frame-0']);
    });

    it('tolerates a close with no open, which is leaving during a camera prompt', async () => {
      // The view closes the result source on disconnect whatever happened
      // before it (#341).
      const source = occupancyService(BASE);
      expect(() => source.close()).to.not.throw();
      expect(() => source.close()).to.not.throw();
      expect(asked).toEqual([]);
    });
  });

  describe('a manifest that will not read', () => {
    it('reports it as the source\'s error, and still answers every frame', async () => {
      manifests = [errorAnswer(500)];
      answers = [multipartAnswer(payload())];
      const source = occupancyService(BASE);

      const error = await source.open();

      expect(error).to.match(/500/);
      expect(source.layout).to.be.null;
      // No sensors to answer, and no rejection either.
      const frame = (await source.next())!;
      const result = await source.resultFor(frame, { drifted: false, dpt: null });
      expect(result.sensorStates.size).toBe(0);
      source.close();
    });

    it('refuses a manifest the format does not accept', async () => {
      manifests = [jsonAnswer({ version: 3, layout: {} })];
      const source = occupancyService(BASE);

      expect(await source.open()).to.be.a('string');
      expect(source.layout).to.be.null;
      source.close();
    });
  });
});
