import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import '../src/rr-live-view.js';
import { RRLiveView } from '../src/rr-live-view.js';
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
  ['S1abcdefghi', { state: 'occupied', detection: detections[0] }],
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
    check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));
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
    check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));
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

  it('runs on the camera and the shipped model when given none', async () => {
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
    await el.updateComplete;

    expect(loadDetector).toHaveBeenCalledTimes(1);
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    expect(viewer.stream).to.not.be.null;
  });
});
