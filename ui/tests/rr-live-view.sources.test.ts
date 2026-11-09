import { describe, it, expect, vi, afterAll, afterEach, beforeAll, beforeEach, onTestFinished } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import '../src/rr-live-view.js';
import { RRLiveView } from '../src/rr-live-view.js';
import type { FrameAddDetail } from '../src/rr-live-view.js';
import { RRStatsBar } from '../src/rr-stats-bar.js';
import type {
  FrameSource,
  ResultContext,
  ResultSource,
  ServiceDetails,
  SourceFrame,
} from '../src/liveSources.js';
import type { SensorState } from '../src/occupancy.js';
import { occupancyService } from '../src/occupancyService.js';
import { jsonAnswer, multipartAnswer, useNodeFileGlobals } from './liveFixture.js';

// The live view against **fake** sources (#330), which is the half
// `rr-live-view.test.ts` cannot reach: that file drives the camera and the
// shipped detector through the same loop, and it is left untouched here on
// purpose — the split is only worth anything if the view it describes still
// behaves the way it did.
//
// A second file rather than more cases in the first one, for that reason.

const detections: Detection[] = [
  { centre: { x: 50, y: 50 }, length: 60, width: 42, angle: 0, class: 'stock', confidence: 0.9 },
];

const sensorStates = new Map<string, SensorState>([
  ['S1abcdefghi', { state: 'occupied', confidence: 0.9, detection: detections[0] }],
]);

const loadDetector = vi.fn(async (_source: string) => ({
  detect: vi.fn(async () => detections),
  dispose: vi.fn(async () => {}),
}));

vi.mock('@rails49/detector/browser', () => ({
  loadDetector: (source: string) => loadDetector(source),
}));

// As in `rr-live-view.test.ts`: the IO is stubbed and the arithmetic is real,
// so a measurement past the layout's tolerance still has to travel through
// `maxDriftPx` to reach `resultFor`.
const check = vi.fn(async () => ({ displacementPx: 0, refIndex: 0 }));
const openDriftCheck = vi.fn(async () => ({ check: { check }, refName: 'test.jpg' }));

vi.mock('../src/driftSession.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/driftSession.js')>();
  return {
    MAX_DRIFT_TRACK_FRACTION: actual.MAX_DRIFT_TRACK_FRACTION,
    maxDriftPx: actual.maxDriftPx,
    driftVerdict: actual.driftVerdict,
    openDriftCheck: (...args: unknown[]) => openDriftCheck(...(args as [])),
    grabPlane: () => ({ width: 4, height: 4, data: new Float32Array(16) }),
  };
});

/** A frame source that hands over a frame per `next()`, and counts its lifetime. */
function fakeFrames({ held = false } = {}) {
  let running = false;
  const source = {
    starts: 0,
    stops: 0,
    delivered: 0,
    /** Let a `start()` that was held finish, as a granted permission does. */
    grant: () => {},
    stream: null as MediaStream | null,
    settings: {} as MediaTrackSettings,
    async start() {
      source.starts++;
      if (held) await new Promise<void>(resolve => (source.grant = resolve));
      running = true;
    },
    stop() {
      running = false;
      source.stops++;
    },
    async next(): Promise<SourceFrame | null> {
      // A macrotask per frame, as one animation frame is for the camera: a
      // source that resolved synchronously would starve the test's timers.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!running) return null;
      source.delivered++;
      return { source: {} as CanvasImageSource, width: 640, height: 480 };
    },
  };
  return source satisfies FrameSource;
}

/** A result source that answers every frame the same way, and records what it was asked. */
function fakeResults() {
  const source = {
    opens: 0,
    closes: 0,
    asked: [] as ResultContext[],
    async open() {
      source.opens++;
      return null;
    },
    close() {
      source.closes++;
    },
    /** Set to make the next `resultFor` reject, which the contract forbids. */
    failNext: false,
    async resultFor(_frame: SourceFrame, context: ResultContext) {
      source.asked.push(context);
      if (source.failNext) {
        source.failNext = false;
        throw new Error('the source broke its contract');
      }
      return { detections, sensorStates, inference: 7 };
    },
  };
  return source satisfies ResultSource;
}

async function waitFor(el: RRLiveView, done: () => boolean, budgetMs = 1000) {
  for (let waited = 0; waited < budgetMs && !done(); waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10));
    await el.updateComplete;
  }
  await el.updateComplete;
}

describe('rr-live-view with sources of its own', () => {
  let archive: R49Archive;

  beforeEach(() => {
    loadDetector.mockClear();
    check.mockClear();
    check.mockImplementation(async () => ({ displacementPx: 0, refIndex: 0 }));
    openDriftCheck.mockClear();
    openDriftCheck.mockImplementation(async () => ({ check: { check }, refName: 'test.jpg' }));

    archive = new R49Archive();
    archive.setManifest({
      version: 4,
      layout: {
        name: 'Sources Test',
        scale: 'N',
        // 100 px over 10 model mm in N scale: DPT 89.6875, the number the
        // drift tolerance and `resultFor`'s `dpt` are both read against.
        calibration: {
          points: [
            { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
            { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
          ],
        },
        sensors: [{ id: 'S1abcdefghi', x: 50, y: 50 }],
      },
      camera: { resolution: { width: 100, height: 100 } },
      images: [{ filename: 'test.jpg', labeled_complete: false, labels: [] }],
    });

    const track = { stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720 }) };
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }),
    };
  });

  const DPT = 89.6875;

  it('draws what the result source answers, reports it, and loads no model', async () => {
    const frames = fakeFrames();
    const results = fakeResults();

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
    await waitFor(el, () => frames.delivered > 1 && stats.fps > 0);

    expect(results.opens).toBe(1);
    // The whole point of the split: nothing in this view opened a session.
    expect(loadDetector).not.toHaveBeenCalled();

    expect(viewer.detections).toEqual(detections);
    expect(viewer.sensorStates).toBe(sensorStates);
    expect(stats.cars).toBe(1);
    expect(stats.occupied).toBe(1);
    expect(stats.inference).toBe(7);
    expect(stats.fps).toBeGreaterThan(0);
  });

  it('asks the result source with the drift verdict and the layout DPT', async () => {
    const frames = fakeFrames();
    const results = fakeResults();

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    await waitFor(el, () => results.asked.length > 0);

    // Resolved from the archive by the view, so #166 stays one fix, and
    // `drifted` is the refusal — not the measurement.
    expect(results.asked[0]).toEqual({ drifted: false, dpt: DPT });
  });

  it('asks it to withhold L1 once the camera has drifted past the tolerance', async () => {
    check.mockImplementation(async () => ({ displacementPx: 60, refIndex: 0 }));
    const frames = fakeFrames();
    const results = fakeResults();

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    await waitFor(el, () => results.asked.some(context => context.drifted));

    expect(results.asked.some(context => context.drifted)).toBe(true);
    expect(el.shadowRoot!.querySelector('.notice.refusing')).to.not.be.null;
  });

  it('keeps the refusal live while a frame is being answered', async () => {
    // Drift is sampled beside the loop and lands whenever the check finishes,
    // so a sample arriving while this frame is being answered refuses *this*
    // frame — which is how the gate behaved while the loop and the model were
    // one file. The context the source is handed is a view onto the view's
    // state, not a copy taken on entry.
    check.mockImplementation(async () => ({ displacementPx: 60, refIndex: 0 }));
    const frames = fakeFrames();
    const results = fakeResults();

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

    // The first frame was asked before anything had been measured, and that
    // same context now reports the refusal.
    expect(results.asked[0].drifted).toBe(true);
  });

  it('stops the frames and closes the results when the view is left, ending the loop', async () => {
    const frames = fakeFrames();
    const results = fakeResults();

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    await waitFor(el, () => results.asked.length > 0);

    el.remove();
    const asked = results.asked.length;
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(frames.stops).toBe(1);
    expect(results.closes).toBe(1);
    // The loop ends on the `null` the stopped source gives, so nothing goes on
    // asking for results against a detached view.
    expect(results.asked.length).toBe(asked);
  });

  it('opens nothing when the view is left while the frames are being acquired', async () => {
    // Leaving Live while the permission prompt is up: loading a model and
    // decoding the drift reference for a detached element costs a WASM heap and
    // hundreds of milliseconds, and leaves a loop running on nothing.
    const frames = fakeFrames({ held: true });
    const results = fakeResults();

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    el.remove();
    frames.grant();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(results.opens).toBe(0);
    expect(results.asked).toHaveLength(0);
    expect(openDriftCheck).not.toHaveBeenCalled();
  });

  it('survives a result source that rejects, rather than freezing the screen', async () => {
    // `resultFor` is contracted never to reject; a loop that died on one would
    // leave the last answers on screen for the rest of the session, which is
    // the one outcome worse than saying nothing.
    const frames = fakeFrames();
    const results = fakeResults();
    results.failNext = true;

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive} .sources=${{ frames, results }}></rr-live-view>`,
    );
    await waitFor(el, () => results.asked.length > 1);

    expect(results.asked.length).toBeGreaterThan(1);
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    expect(viewer.sensorStates).toBe(sensorStates);
  });

  describe('a source that brings its own frames and its own layout (#331)', () => {
    const SENSORS = [{ id: 'Sservice001', x: 10, y: 20 }];
    const TRACKS = [
      {
        nodes: [
          { x: 0, y: 20, heading: 0 },
          { x: 100, y: 20, heading: 0 },
        ],
      },
    ];
    const LAYOUT = {
      sensors: SENSORS,
      resolution: { width: 640, height: 480 },
      dpt: 20,
      tracks: TRACKS,
    };

    /**
     * A source that is both, as an occupancy service is: it hands over a
     * picture through `src`, answers it, and declares the layout the answers
     * are keyed on.
     */
    interface Answer {
      src?: string;
      fresh?: boolean;
      detections?: Detection[];
      l0Age?: number;
      notice?: string;
      states?: ReadonlyMap<string, SensorState>;
      details?: ServiceDetails;
      /** The frame this answer carried, which Freeze offers (#334). */
      frame?: { id: string; bytes: Blob };
      /** Make `resultFor` reject for this answer, which the contract forbids. */
      fail?: boolean;
    }

    function fakeService(
      answers: Answer[],
      { openError = null as string | null, layoutLate = false } = {}
    ) {
      let turn = -1;
      // `layoutLate` stands in for a manifest that would not read at `open()`
      // and read on the next reconnect.
      let layout: typeof LAYOUT | null = layoutLate ? null : LAYOUT;
      const source = {
        asked: 0,
        /** Each `setPatches` call, in order. */
        patches: [] as boolean[],
        setPatches(on: boolean) {
          source.patches.push(on);
        },
        stream: null as MediaStream | null,
        settings: {} as MediaTrackSettings,
        get layout() {
          return layout;
        },
        /** Stand in for a reconnect that re-read the manifest with a sensor moved. */
        moveSensor(x: number) {
          layout = { ...LAYOUT, sensors: [{ id: 'Sservice001', x, y: 20 }] };
        },
        /** Stand in for a reconnect that read the manifest `open()` could not. */
        readLayout() {
          layout = LAYOUT;
        },
        async start() {},
        stop() {},
        async open() {
          return openError;
        },
        /**
         * Say something new from the next turn on. The last answer queued
         * repeats, so this is what makes a state the test can wait for.
         */
        say(answer: Answer) {
          answers.push(answer);
        },
        // The frame the current answer carried, as the service holds it (#334).
        get shownFrame() {
          return answers[Math.max(turn, 0)]?.frame ?? null;
        },
        close() {},
        async next(): Promise<SourceFrame | null> {
          await new Promise(resolve => setTimeout(resolve, 0));
          // The last answer repeats for the rest of the session, as a service
          // with nothing new to send would.
          turn = Math.min(turn + 1, answers.length - 1);
          const answer = answers[turn];
          return {
            source: {} as CanvasImageSource,
            width: 640,
            height: 480,
            ...(answer.src !== undefined ? { src: answer.src } : {}),
            ...(answer.fresh !== undefined ? { fresh: answer.fresh } : {}),
          };
        },
        async resultFor() {
          const answer = answers[Math.max(turn, 0)];
          source.asked++;
          if (answer.fail) throw new Error('the source broke its contract');
          return {
            ...(answer.detections !== undefined ? { detections: answer.detections } : {}),
            ...(answer.l0Age !== undefined ? { l0Age: answer.l0Age } : {}),
            ...(answer.notice !== undefined ? { notice: answer.notice } : {}),
            ...(answer.details !== undefined ? { details: answer.details } : {}),
            sensorStates: answer.states ?? new Map<string, SensorState>(),
          };
        },
      };
      return source satisfies FrameSource & ResultSource;
    }

    const mount = (source: FrameSource & ResultSource, archive: R49Archive | null = null) =>
      fixture<RRLiveView>(
        html`<rr-live-view
          .archive=${archive}
          .sources=${{ frames: source, results: source, service: true }}
        ></rr-live-view>`
      );

    it('shows the frame through src and draws the layout the source declares', async () => {
      const states = new Map<string, SensorState>([
        ['Sservice001', { state: 'occupied', confidence: 0.8 }],
        ['Sclear00001', { state: 'clear' }],
        ['Sunreported', { state: 'unknown', reason: 'not-reported' }],
        ['Srefused001', { state: 'unknown', serviceReason: 'camera cannot see this sensor' }],
      ]);
      const source = fakeService([{ src: 'blob:one', detections, l0Age: 120, states }]);

      const el = await mount(source);
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
      await waitFor(el, () => viewer.src !== null);

      expect(viewer.src).toBe('blob:one');
      // Nothing reads pixels back: the viewer is handed the URL, not asked for
      // its element.
      expect(viewer.stream).to.be.null;
      // The source's layout, not this view's archive — which it has none of.
      expect(viewer.sensors.map(s => s.id)).toEqual(['Sservice001']);
      expect(viewer.resolution).toEqual({ width: 640, height: 480 });
      expect(viewer.dpt).toBe(20);
      // Each L1 state and reason reaches the viewer as the source gave it.
      expect(viewer.sensorStates).toEqual(states);
      expect(stats.cars).toBe(1);
      expect(stats.l0Age).toBe(120);
    });

    it('draws no boxes and shows no car count where the source published no L0', async () => {
      const source = fakeService([{ src: 'blob:one' }]);

      const el = await mount(source);
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
      await waitFor(el, () => viewer.src !== null);

      expect(viewer.detections).toEqual([]);
      // `null`, not 0: nothing counted cars for this frame.
      expect(stats.cars).to.be.null;
      expect(stats.l0Age).to.be.null;
    });

    it('shows 0 cars for an L0 that found none', async () => {
      const source = fakeService([{ src: 'blob:one', detections: [] }]);

      const el = await mount(source);
      await waitFor(el, () => el.shadowRoot!.querySelector('rr-viewer')!.src !== null);

      expect(el.shadowRoot!.querySelector('rr-stats-bar')!.cars).toBe(0);
    });

    it('times the first frame after a gap from nothing, not from before the gap', async () => {
      // Two new frames with a gap between them make no rate: each is the first
      // of its run.
      const rates: [RRStatsBar, number][] = [];
      const setFps = Object.getOwnPropertyDescriptor(RRStatsBar.prototype, 'fps')!.set!;
      const spy = vi
        .spyOn(RRStatsBar.prototype, 'fps', 'set')
        .mockImplementation(function (this: RRStatsBar, value) {
          rates.push([this, value]);
          setFps.call(this, value);
        });
      onTestFinished(() => spy.mockRestore());
      const source = fakeService([
        { src: 'blob:one' },
        { fresh: false },
        { src: 'blob:two' },
        { fresh: false },
      ]);

      const el = await mount(source);
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      await waitFor(el, () => viewer.src === 'blob:two' && source.asked > 4);

      // Only this view's bar: views left running by earlier tests set theirs too.
      const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
      const ours = rates.filter(([bar]) => bar === stats).map(([, rate]) => rate);
      expect(ours.filter(rate => rate !== 0)).toEqual([]);
    });

    it('keeps the last picture, drops the rate to 0 and shows the notice on a turn with no frame', async () => {
      const shown = new Map<string, SensorState>([['Sservice001', { state: 'clear' }]]);
      const blind = new Map<string, SensorState>([
        ['Sservice001', { state: 'unknown', serviceReason: 'no frames' }],
      ]);
      const source = fakeService([
        { src: 'blob:one', detections, states: shown },
        { fresh: false, notice: 'No picture from the camera', states: blind },
      ]);

      const el = await mount(source);
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
      await waitFor(el, () => viewer.src === 'blob:one');
      await waitFor(el, () => stats.fps === 0 && source.asked > 1);

      // The picture stays up — it is still the last thing the service sent.
      expect(viewer.src).toBe('blob:one');
      // And nothing else does: no boxes, every sensor unknown with the
      // service's own reason, no rate, and the reason on screen.
      expect(viewer.detections).toEqual([]);
      expect(viewer.sensorStates!.get('Sservice001')).toEqual({
        state: 'unknown',
        serviceReason: 'no frames',
      });
      expect(stats.fps).toBe(0);
      expect(stats.cars).to.be.null;
      expect(el.shadowRoot!.textContent).to.contain('No picture from the camera');
    });

    it('re-reads the layout every frame, so a sensor that moved reaches the viewer', async () => {
      const source = fakeService([{ src: 'blob:one' }]);

      const el = await mount(source);
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      await waitFor(el, () => viewer.sensors.length > 0);
      expect(viewer.sensors[0].x).toBe(10);

      source.moveSensor(99);
      await waitFor(el, () => viewer.sensors[0]?.x === 99);
      expect(viewer.sensors[0].x).toBe(99);
    });

    it("shows the source's own error, not the local model's story", async () => {
      // "Link a rails49/detector checkout" is actionable for this build's
      // model and nonsense for a service whose manifest would not read.
      const source = fakeService([{ src: 'blob:one' }], {
        openError: 'the manifest answered 503',
        layoutLate: true,
      });

      const el = await mount(source);
      await waitFor(el, () => (el.shadowRoot!.textContent ?? '').includes('503'));

      const text = el.shadowRoot!.textContent ?? '';
      expect(text).to.contain('503');
      expect(text).to.not.contain('rails49/detector');
    });

    it('drops that error once the source answers from a layout after all', async () => {
      // A service whose manifest failed at `open()` and read on the next
      // reconnect was prepared after all, and must not keep the notice saying
      // it could not be read.
      const source = fakeService([{ src: 'blob:one' }], {
        openError: 'the manifest answered 503',
        layoutLate: true,
      });

      const el = await mount(source);
      await waitFor(el, () => (el.shadowRoot!.textContent ?? '').includes('503'));

      source.readLayout();
      await waitFor(el, () => !(el.shadowRoot!.textContent ?? '').includes('503'));

      expect(el.shadowRoot!.textContent).to.not.contain('503');
      expect(el.shadowRoot!.querySelector('rr-viewer')!.sensors).toHaveLength(1);
    });

    it('measures no drift and shows none of the page\'s own notices', async () => {
      // The drift check, the recorder, the alignment readout and the model and
      // DPT notices are about this page running a model over an archive it
      // holds. A service does that elsewhere, and this page cannot withhold
      // what it publishes (#331; drift in service mode is #336).
      const source = fakeService([{ src: 'blob:one' }]);

      const el = await mount(source);
      await waitFor(el, () => el.shadowRoot!.querySelector('rr-viewer')!.src !== null);

      expect(openDriftCheck).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(loadDetector).not.toHaveBeenCalled();
      expect(el.shadowRoot!.querySelector('.recorder')).to.be.null;
      expect(el.shadowRoot!.querySelector('.notice')).to.be.null;
      const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
      expect(stats.alignment).to.be.null;
      expect(stats.alignmentTolerance).to.be.null;
    });

    // #333 binds the service's own archive to the page while the live view is
    // watching that service, so "no archive" stopped being what tells service
    // mode apart. Measuring drift against the service's archive would be this
    // page second-guessing the judgement it is only relaying.
    it('measures no drift with the service\'s own archive bound (#333)', async () => {
      const source = fakeService([{ src: 'blob:one' }]);

      const el = await mount(source, archive);
      await waitFor(el, () => el.shadowRoot!.querySelector('rr-viewer')!.src !== null);

      expect(openDriftCheck).not.toHaveBeenCalled();
      expect(loadDetector).not.toHaveBeenCalled();
      expect(el.shadowRoot!.querySelector('.recorder')).to.be.null;
      // The layout drawn is still the source's, not the archive's.
      expect(el.shadowRoot!.querySelector('rr-viewer')!.dpt).toBe(20);
    });

    describe('Freeze (#334)', () => {
      const button = (el: RRLiveView, label: string) =>
        [...el.shadowRoot!.querySelectorAll('button')].find(b => b.textContent!.trim() === label);
      const freeze = (el: RRLiveView) => button(el, 'Freeze');

      /** Every `rr-frame-add` the view sent, in order. */
      function adds(el: RRLiveView) {
        const seen: FrameAddDetail[] = [];
        el.addEventListener('rr-frame-add', e => seen.push((e as CustomEvent<FrameAddDetail>).detail));
        return seen;
      }

      const frame = (id: string, text: string) => ({ id, bytes: new Blob([text]) });

      it('stands beside Details and sends the frame on screen, with the feed running', async () => {
        const onScreen = frame('f-1', 'first frame');
        const source = fakeService([{ src: 'blob:one', frame: onScreen }]);

        const el = await mount(source);
        const sent = adds(el);
        await waitFor(el, () => freeze(el)?.disabled === false);

        // Details first, as #332 put it there; Freeze is the second button of
        // the same bar, where the recorder stands in local mode.
        const bar = [...el.shadowRoot!.querySelectorAll('.details-bar button')];
        expect(bar.map(b => b.textContent!.trim())).toEqual(['Details', 'Freeze']);

        const turns = source.asked;
        freeze(el)!.click();
        await el.updateComplete;

        expect(sent).toHaveLength(1);
        // The bytes as the source holds them, and the id of the answer they
        // came in — the view reads neither.
        expect(sent[0].bytes).toBe(onScreen.bytes);
        expect(sent[0].frameId).toBe('f-1');

        // The picture does not stop: the loop goes on asking and the viewer
        // goes on being handed frames.
        await waitFor(el, () => source.asked > turns + 1);
        expect(source.asked).toBeGreaterThan(turns + 1);
        expect(el.shadowRoot!.querySelector('rr-viewer')!.src).toBe('blob:one');
      });

      it('is disabled before the first frame, on an answer with none, and enabled by the next', async () => {
        const source = fakeService([{ src: 'blob:one', frame: frame('f-1', 'first') }]);

        const el = await mount(source);
        // The first answer is a macrotask away, so this is the state before
        // any frame has arrived.
        expect(freeze(el)!.disabled).toBe(true);

        await waitFor(el, () => freeze(el)!.disabled === false);
        expect(freeze(el)!.disabled).toBe(false);

        // An answer with only the `json` part: the picture stays on screen and
        // it is out of date, so there is nothing to add.
        source.say({ fresh: false, notice: 'No picture from the camera' });
        await waitFor(el, () => freeze(el)!.disabled);
        expect(freeze(el)!.disabled).toBe(true);
        expect(el.shadowRoot!.querySelector('rr-viewer')!.src).toBe('blob:one');

        // A failed request is the same answer from the view's side.
        source.say({ fresh: false, notice: 'Cannot reach the occupancy service' });
        await waitFor(el, () => source.asked > 2);
        expect(freeze(el)!.disabled).toBe(true);

        source.say({ src: 'blob:two', frame: frame('f-2', 'second') });
        await waitFor(el, () => freeze(el)!.disabled === false);
        expect(freeze(el)!.disabled).toBe(false);
      });

      it('offers the picture on screen even while the answers are being skipped', async () => {
        // `resultFor` is contracted never to reject and the loop skips a frame
        // that does: the frame on offer therefore goes with the **picture**,
        // not with the answers, or Freeze could add a frame nobody is looking
        // at.
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const second = frame('f-2', 'second frame');
        const source = fakeService([{ src: 'blob:one', frame: frame('f-1', 'first frame') }]);

        const el = await mount(source);
        const sent = adds(el);
        await waitFor(el, () => freeze(el)?.disabled === false);

        source.say({ src: 'blob:two', frame: second, fail: true });
        const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
        await waitFor(el, () => viewer.src === 'blob:two');

        freeze(el)!.click();
        await el.updateComplete;

        expect(sent).toHaveLength(1);
        expect(sent[0].frameId).toBe('f-2');
        expect(sent[0].bytes).toBe(second.bytes);
      });

      it('sends nothing while there is no frame to send', async () => {
        const source = fakeService([{ fresh: false, notice: 'No picture from the camera' }]);

        const el = await mount(source);
        const sent = adds(el);
        await waitFor(el, () => source.asked > 1);

        freeze(el)!.click();
        await el.updateComplete;

        expect(sent).toEqual([]);
      });
    });

    describe('Details (#332)', () => {
      const detailsButton = (el: RRLiveView) =>
        [...el.shadowRoot!.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Details');
      const panel = (el: RRLiveView) => el.shadowRoot!.querySelector('rr-service-details');

      it('opens a panel with what the service sent, asking for patches while it is open', async () => {
        const states = new Map<string, SensorState>([['Sservice001', { state: 'clear' }]]);
        const details: ServiceDetails = { scores: new Map([['Sservice001', 0.1]]) };
        const source = fakeService([{ src: 'blob:one', states, details }]);

        const el = await mount(source);
        await waitFor(el, () => source.asked > 0);
        expect(panel(el)).to.be.null;
        expect(detailsButton(el)!.getAttribute('aria-pressed')).toBe('false');

        detailsButton(el)!.click();
        await el.updateComplete;
        expect(source.patches).toEqual([false, true]);
        expect(detailsButton(el)!.getAttribute('aria-pressed')).toBe('true');
        expect(panel(el)!.details).toBe(details);
        expect(panel(el)!.sensors).toEqual(SENSORS);
        expect(panel(el)!.states).toBe(states);

        detailsButton(el)!.click();
        await el.updateComplete;
        expect(source.patches).toEqual([false, true, false]);
        expect(panel(el)).to.be.null;
      });

      it('draws the tracks only while the panel is open', async () => {
        const source = fakeService([{ src: 'blob:one' }]);

        const el = await mount(source);
        const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
        await waitFor(el, () => source.asked > 0);
        expect(viewer.tracks).toEqual([]);

        detailsButton(el)!.click();
        await el.updateComplete;
        expect(viewer.tracks).toEqual(TRACKS);

        detailsButton(el)!.click();
        await el.updateComplete;
        expect(viewer.tracks).toEqual([]);
      });

      it('is closed each time the view opens', async () => {
        const source = fakeService([{ src: 'blob:one' }]);

        const first = await mount(source);
        await waitFor(first, () => source.asked > 0);
        detailsButton(first)!.click();
        first.remove();

        const second = await mount(source);
        await waitFor(second, () => source.asked > 1);
        expect(panel(second)).to.be.null;
        // The same object, so it is told to stop asking for patches.
        expect(source.patches.at(-1)).toBe(false);
      });
    });
  });

  describe('Details over a service\'s multipart answers (#332)', () => {
    // The real `occupancyService` under the view, with `fetch` stubbed by
    // multipart bodies built byte by byte, so each field travels the whole
    // way: `readLatest`, the source's object URLs, the view, the panel.
    const fileGlobals = useNodeFileGlobals();
    beforeAll(() => fileGlobals.install());
    afterAll(() => fileGlobals.restore());

    const ID = 'C3"A';
    const TRACK = { nodes: [{ x: 0, y: 20, heading: 0 }, { x: 100, y: 20, heading: 0 }] };
    const MANIFEST = {
      version: 4,
      layout: {
        name: 'Served',
        scale: 'N',
        calibration: {
          points: [
            { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
            { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
          ],
        },
        sensors: [
          { id: ID, x: 10, y: 20 },
          { id: 'C3.B', x: 60, y: 20 },
        ],
        tracks: [TRACK],
      },
      camera: { resolution: { width: 640, height: 480 } },
      images: [],
    };

    class QuietEventSource {
      onopen = null;
      onerror = null;
      close() {}
    }

    let asked: string[];
    let extra: Record<string, unknown>;
    /** The spies this block makes, restored one by one: `vi.restoreAllMocks` would also strip `setup.ts`'s `ResizeObserver`. */
    let spies: { mockRestore(): void }[];

    beforeEach(() => {
      asked = [];
      extra = {};
      let frame = 0;
      vi.stubGlobal('EventSource', QuietEventSource);
      let made = 0;
      spies = [
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:made-${made++}`),
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
      ];
      HTMLImageElement.prototype.decode = () => Promise.resolve();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          asked.push(url);
          if (url.endsWith('manifest.json')) return jsonAnswer(MANIFEST);
          // Paced like `after` at a service, so the loop does not spin.
          await new Promise(resolve => setTimeout(resolve, 5));
          const patches = url.includes('patches=1');
          const payload = {
            version: 1,
            frame_id: `f-${++frame}`,
            captured_at: '2026-11-05T10:00:01.500Z',
            l1: { [ID]: { state: 'clear' }, 'C3.B': { state: 'clear' } },
            scores: { [ID]: 0.02 },
            threshold: 0.45,
            changes: { [ID]: 7 },
            timings: { classify_ms: 31, rate_fps: 14.5 },
            camera: { state: 'ok', frame_age_ms: 20 },
            drift: { px: 2, tolerance_px: 9.75, past: false },
            last_messages: { [ID]: { occupancy: { message: 'ON', time: '2026-11-05T10:15:30Z' } } },
            // `C3.B` names a part the answer lacks, so its cell is empty.
            ...(patches ? { patches: { [ID]: 'patch-0', 'C3.B': 'patch-9' } } : {}),
            ...extra,
          };
          const parts = patches ? [{ name: 'patch-0', bytes: new Uint8Array([1, 2, 3]) }] : [];
          return multipartAnswer(payload, undefined, parts);
        })
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const spy of spies) spy.mockRestore();
    });

    const mountService = () => {
      const service = occupancyService('/live');
      return fixture<RRLiveView>(
        html`<rr-live-view
          .sources=${{ frames: service, results: service, service: true }}
        ></rr-live-view>`
      );
    };
    const latest = () => asked.filter(url => url.includes('/latest'));
    const patchImg = (el: RRLiveView) =>
      el.shadowRoot!.querySelector('rr-service-details')?.shadowRoot!.querySelector('img') ?? null;

    it('shows each sensor\'s patch and fields while open, and asks for patches only then', async () => {
      const el = await mountService();
      await waitFor(el, () => latest().length > 1);
      expect(latest().some(url => url.includes('patches=1'))).toBe(false);

      el.shadowRoot!.querySelector<HTMLButtonElement>('.details-bar button')!.click();
      await waitFor(el, () => patchImg(el) !== null);

      const panel = el.shadowRoot!.querySelector('rr-service-details')!.shadowRoot!;
      expect(patchImg(el)!.getAttribute('src')).to.match(/^blob:made-/);
      // One patch: `C3.B`'s part is missing.
      expect(panel.querySelectorAll('img')).toHaveLength(1);
      const text = panel.textContent!.replace(/\s+/g, ' ');
      for (const sent of [
        '0.02', // scores
        '0.45', // threshold
        '7', // changes
        'classify 31.0 ms',
        'service 14.5 fps',
        'ok', // camera
        '20 ms', // frame age
        '2.0 px, within 9.8 px',
        'occupancy: ON',
      ]) {
        expect(text).to.contain(sent);
      }
      expect(el.shadowRoot!.querySelector('rr-viewer')!.tracks).toEqual([TRACK]);

      el.shadowRoot!.querySelector<HTMLButtonElement>('.details-bar button')!.click();
      await el.updateComplete;
      const closedAt = latest().length;
      await waitFor(el, () => latest().length > closedAt + 1);
      // One request may have left before the click; none after it asks.
      expect(latest().slice(closedAt + 1).some(url => url.includes('patches=1'))).toBe(false);
    });

    it('keeps L1 on the viewer when an optional field has the wrong shape', async () => {
      extra = { scores: 'all of them' };
      const el = await mountService();
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      await waitFor(el, () => viewer.sensorStates!.size > 0);

      expect(viewer.sensorStates!.get(ID)).toEqual({ state: 'clear' });
      el.shadowRoot!.querySelector<HTMLButtonElement>('.details-bar button')!.click();
      await waitFor(el, () => patchImg(el) !== null);
      const text = el.shadowRoot!.querySelector('rr-service-details')!.shadowRoot!.textContent!;
      expect(text).to.not.contain('Score');
    });
  });

  it('runs on the camera and the shipped model when given none', async () => {
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
    await el.updateComplete;

    expect(loadDetector).toHaveBeenCalledTimes(1);
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    expect(viewer.stream).to.not.be.null;
    // Details is a service's (#332), and so is Freeze (#334): no bar, no
    // panel, no tracks. Freeze with the camera is out of scope — the editor's
    // Capture from Camera is that path.
    expect(el.shadowRoot!.querySelector('.details-bar')).to.be.null;
    expect([...el.shadowRoot!.querySelectorAll('button')].map(b => b.textContent!.trim())).to.not
      .contain('Freeze');
    expect(el.shadowRoot!.querySelector('rr-service-details')).to.be.null;
    expect(viewer.tracks).toEqual([]);
  });
});
