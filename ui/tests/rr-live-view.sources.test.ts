import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import '../src/rr-live-view.js';
import { RRLiveView } from '../src/rr-live-view.js';
import { RRStatsBar } from '../src/rr-stats-bar.js';
import type { FrameSource, ResultContext, ResultSource, SourceFrame } from '../src/liveSources.js';
import type { SensorState } from '../src/occupancy.js';

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
    const LAYOUT = {
      sensors: SENSORS,
      resolution: { width: 640, height: 480 },
      dpt: 20,
    };

    /**
     * A source that is both, as an occupancy service is: it hands over a
     * picture through `src`, answers it, and declares the layout the answers
     * are keyed on.
     */
    function fakeService(
      answers: {
        src?: string;
        fresh?: boolean;
        detections?: Detection[];
        l0Age?: number;
        notice?: string;
        states?: ReadonlyMap<string, SensorState>;
      }[],
      { openError = null as string | null, layoutLate = false } = {}
    ) {
      let turn = -1;
      // `layoutLate` stands in for a manifest that would not read at `open()`
      // and read on the next reconnect.
      let layout: typeof LAYOUT | null = layoutLate ? null : LAYOUT;
      const source = {
        asked: 0,
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
          return {
            ...(answer.detections !== undefined ? { detections: answer.detections } : {}),
            ...(answer.l0Age !== undefined ? { l0Age: answer.l0Age } : {}),
            ...(answer.notice !== undefined ? { notice: answer.notice } : {}),
            sensorStates: answer.states ?? new Map<string, SensorState>(),
          };
        },
      };
      return source satisfies FrameSource & ResultSource;
    }

    const mount = (source: FrameSource & ResultSource) =>
      fixture<RRLiveView>(
        html`<rr-live-view .sources=${{ frames: source, results: source }}></rr-live-view>`
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
  });

  it('runs on the camera and the shipped model when given none', async () => {
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
    await el.updateComplete;

    expect(loadDetector).toHaveBeenCalledTimes(1);
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    expect(viewer.stream).to.not.be.null;
  });
});
