import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive } from '@rails49/r49';
import type { Detection } from '@occupancy/detector';
import '../src/rr-live-view.js';
import { RRLiveView } from '../src/rr-live-view.js';

// What the detector would find, when it loads. The loop is driven by
// requestAnimationFrame off a <video> jsdom never gives a readyState to, so
// these tests assert what the view is *wired* to do — which model URL it asks
// for, what it hands the viewer, what it says when the model is missing — and
// not that a frame ran. jsdom lays nothing out and decodes no video; claiming
// otherwise here would be claiming the suite proves something it cannot.
const detections: Detection[] = [
  { centre: { x: 480, y: 270 }, length: 200, width: 42, angle: 0, class: 'stock', confidence: 0.9 },
];

const loadDetector = vi.fn(async (_source: string) => ({
  detect: vi.fn(async () => detections),
  dispose: vi.fn(async () => {}),
}));

vi.mock('@occupancy/detector/browser', () => ({
  loadDetector: (source: string) => loadDetector(source),
}));

// `driftSession`'s IO is mocked rather than exercised: it decodes blobs through
// `createImageBitmap` and reads pixels back out of a canvas, and jsdom does
// neither. What these tests can prove is the wiring — that a measurement past the
// layout's tolerance withholds L1, keeps L0, and offers the override — which is
// the whole of #94. The measurement itself is `lib/drift`'s to prove, and
// `tools/drift-bench` scores it against the corpus.
//
// `maxDriftPx` and `driftVerdict` are the **real** implementations, not stubs. It is pure arithmetic
// over `MAX_DRIFT_TRACK_FRACTION` and a DPT, and they are what make the
// tolerance geometric rather than absolute — stubbing them would leave the suite
// unable to tell a DPT-relative threshold from the fixed pixel count this
// replaced.
const check = vi.fn(async () => ({ displacementPx: 0, refIndex: 0 }));
const openDriftCheck = vi.fn(async () => ({ check: { check }, refName: 'test.jpg' }));

vi.mock('../src/driftSession.js', async importOriginal => {
  // Safe to import for real: the module builds no canvas at import time, only
  // inside the two functions replaced below.
  const actual = await importOriginal<typeof import('../src/driftSession.js')>();
  return {
    maxDriftPx: actual.maxDriftPx,
    driftVerdict: actual.driftVerdict,
    openDriftCheck: (...args: unknown[]) => (openDriftCheck as any)(...args),
    grabPlane: () => ({ width: 4, height: 4, data: new Float32Array(16) }),
  };
});

/**
 * Give the view a frame to read.
 *
 * jsdom decodes no video, so `<video>.readyState` never leaves 0 and the rAF
 * loop returns early forever — which is why the tests above assert wiring
 * rather than frames. The drift gate cannot be asserted that way: it only ever
 * fires from inside the loop. Standing in a ready-looking source is the smallest
 * lie that lets the real loop, the real `occupancy()` call and the real notice
 * run; nothing downstream of here reads a pixel (`detect` and `grabPlane` are
 * both mocked).
 */
function standInReadySource(el: RRLiveView) {
  const viewer = el.shadowRoot!.querySelector('rr-viewer')! as any;
  viewer.getVideoElement = () => ({ readyState: 2, videoWidth: 100, videoHeight: 100 });
}

/**
 * Wait for the loop and the deferred drift sample to reach a state.
 *
 * Every condition worth waiting on here is reached by a *frame*, not by a render:
 * a drift sample lands outside the loop and only the next frame folds it into
 * sensor states, so waiting on the notice and then asserting on the states would
 * race by one rAF tick.
 */
async function waitFor(el: RRLiveView, done: () => boolean, budgetMs = 1000) {
  for (let waited = 0; waited < budgetMs && !done(); waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10));
    await el.updateComplete;
  }
  await el.updateComplete;
}

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

describe('rr-live-view', () => {
  let archive: R49Archive;

  beforeEach(() => {
    loadDetector.mockClear();
    loadDetector.mockImplementation(async () => ({
      detect: vi.fn(async () => detections),
      dispose: vi.fn(async () => {}),
    }));

    archive = new R49Archive();
    archive.setManifest({
      version: 4,
      layout: {
        name: 'Live Test',
        scale: 'N',
        calibration: { points: [] },
        sensors: [{ id: 'S1abcdefghi', x: 50, y: 50 }],
      },
      camera: { resolution: { width: 100, height: 100 } },
      images: [{ filename: 'test.jpg', labeled_complete: false, labels: [] }],
    });

    const track = { stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720 }) };
    (navigator as any).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }),
    };
  });

  it('is defined', () => {
    const el = document.createElement('rr-live-view');
    expect(el).to.be.instanceOf(RRLiveView);
  });

  it('renders viewer and stats bar', async () => {
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);

    expect(el.shadowRoot!.querySelector('rr-viewer')).to.exist;
    expect(el.shadowRoot!.querySelector('rr-stats-bar')).to.exist;
  });

  it('loads the detector the bundle ships, and no classifier', async () => {
    await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);

    expect(loadDetector).toHaveBeenCalledWith('/models/detector_int8.ort');
  });

  it('passes the layout sensors and their states down, never markers', async () => {
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;

    expect(viewer.sensors.map(s => s.id)).to.deep.equal(['S1abcdefghi']);
    // Not null: the live view is reading these sensors, which is the
    // distinction the viewer draws state on (#85).
    expect(viewer.sensorStates).to.not.be.null;
  });

  it('warns that every sensor reads unknown when the model will not load', async () => {
    loadDetector.mockRejectedValue(new Error('404 on detector_int8.ort'));

    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
    // The load goes through `openDetector` since #87, so the rejection reaches
    // the catch one microtask later than it used to and `updateComplete` alone
    // can resolve before `_modelError` is set. Flush, then let Lit render.
    await new Promise(resolve => setTimeout(resolve, 0));
    await el.updateComplete;

    const notice = el.shadowRoot!.textContent ?? '';
    expect(notice).to.contain('unknown');
    expect(notice).to.contain('export_onnx.py');
  });

  it('warns about calibration before a frame has ever run', async () => {
    // The fixture archive has no calibration points, so getDPT resolves
    // nothing. The notice must not wait on the loop: a session where the camera
    // is refused runs no frame at all, and a warning that never appears is
    // worse than none.
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);

    expect(el.shadowRoot!.textContent).to.contain('no calibration');
  });

  it("sets no zoom: the capability is there, the control is the editor's (#44)", async () => {
    // The live view listens to no pointer events, and its job is watching
    // occupancy across the whole layout — where a zoomed-in partial view hides
    // the thing being monitored. A deferral, not a principle.
    const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);

    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    expect(viewer.zoom).to.be.null;
    expect(viewer.zoomPreview).to.be.null;
  });

  describe('the camera-drift refusal gate (#94)', () => {
    /**
     * The tolerance is a fraction of a track width, so these tests need a DPT.
     *
     * 100 px over 10 model mm in N scale (gauge 1435/160) resolves DPT 89.6875,
     * so `MAX_DRIFT_TRACK_FRACTION` of 0.25 puts the tolerance at 22.42 px. The
     * archive the outer suite builds is deliberately uncalibrated — one test up
     * there asserts the "no calibration" notice — so calibration is added here
     * rather than shared.
     */
    const DPT = 89.6875;
    const TOLERANCE_PX = 0.25 * DPT;

    function calibrate(pixelSpan = 100) {
      archive.getManifest().layout.calibration = {
        points: [
          { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
          { px: { x: pixelSpan, y: 0 }, world: { x: 10, y: 0, z: 0 } },
        ],
      };
    }

    beforeEach(() => {
      check.mockClear();
      openDriftCheck.mockClear();
      check.mockImplementation(async () => ({ displacementPx: 0, refIndex: 0 }));
      openDriftCheck.mockImplementation(async () => ({ check: { check }, refName: 'test.jpg' }));
      calibrate();
    });

    it('scales the tolerance with the track width, not the pixel count', async () => {
      // The correction this replaced an absolute `max_drift_px` for: the same
      // displacement is fine on a layout the camera sees close up and drift on
      // one it sees from further away, because what fails is a sensor leaving the
      // car it reads — a geometric condition. 15 px is inside a quarter track at
      // DPT 89.7 and outside it at DPT 44.8.
      check.mockImplementation(async () => ({ displacementPx: 15, refIndex: 0 }));

      const near = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(near);
      await waitFor(near, () => check.mock.calls.length > 0);
      expect(15).to.be.lessThan(TOLERANCE_PX);
      expect(near.shadowRoot!.querySelector('.notice.refusing')).to.be.null;

      // Half the pixels per track: the same camera motion is now half a track.
      calibrate(50);
      const far = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(far);
      await waitFor(far, () => far.shadowRoot!.querySelector('.notice.refusing') !== null);
      expect(far.shadowRoot!.querySelector('.notice.refusing')).to.not.be.null;
    });

    it('reports the alignment continuously, not only once it is too large', async () => {
      // Enhancement over the first cut: a user aiming a camera needs to watch the
      // number move. The banner is an event; this is an instrument, so it lives
      // in the stats bar and it shows the tolerance beside the measurement.
      check.mockImplementation(async () => ({ displacementPx: 4, refIndex: 0 }));

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      const stats = el.shadowRoot!.querySelector('rr-stats-bar')! as any;
      await waitFor(el, () => stats.alignment !== null);

      expect(stats.alignment).to.equal(4);
      expect(stats.alignmentTolerance).to.be.closeTo(TOLERANCE_PX, 1e-6);
      // Well inside tolerance, so nothing is refused and no banner appears — the
      // readout is the only place this is visible.
      expect(el.shadowRoot!.querySelector('.notice.refusing')).to.be.null;
    });

    it('withholds the tolerance, and the readout, for an uncalibrated layout', async () => {
      // No DPT means no track width to take a fraction of. Those sensors already
      // read `unknown` / `no-calibration`; a fabricated pixel tolerance would be
      // a second wrong answer in a quieter voice.
      archive.getManifest().layout.calibration = { points: [] };
      check.mockImplementation(async () => ({ displacementPx: 500, refIndex: 0 }));

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => check.mock.calls.length > 0);

      const stats = el.shadowRoot!.querySelector('rr-stats-bar')! as any;
      expect(stats.alignmentTolerance).to.be.null;
      expect(el.shadowRoot!.querySelector('.notice.refusing')).to.be.null;
    });

    it('says nothing while the camera is where the archive left it', async () => {
      // No green bar for a steady camera. The view says that by working, and a
      // row that reports success every session is a row nobody reads when it
      // starts reporting a refusal.
      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => check.mock.calls.length > 0);

      const notices = [...el.shadowRoot!.querySelectorAll('.notice')].map(n => n.textContent).join('');
      expect(notices).to.not.contain('drift');
      expect(el.shadowRoot!.querySelector('.notice.refusing')).to.be.null;
    });

    it('refuses to classify once the camera has moved past the tolerance', async () => {
      check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.sensorStates!.get('S1abcdefghi')).to.deep.equal({
        state: 'unknown',
        reason: 'drift',
      });

      const notice = el.shadowRoot!.querySelector('.notice.refusing')!.textContent ?? '';
      expect(notice).to.match(/refusing to classify/i);
      // The number, not just the verdict: it is what tells a nudged tripod from
      // a camera re-aimed at a different layout.
      expect(notice).to.contain('40.0 px');
      // In track widths too, which is the unit the tolerance is set in and the
      // one that says whether a sensor can still sit on the car it reads.
      expect(notice).to.contain('0.45 track widths');
      expect(notice).to.contain(TOLERANCE_PX.toFixed(1));
      // And which image it was measured against — one reference now (#118), so
      // this is the archive's first image rather than a closest match.
      expect(notice).to.contain('test.jpg');
    });

    it('keeps drawing L0 while refusing L1', async () => {
      // The boxes were computed in the live frame and are true of it; what a
      // moved camera invalidates is their mapping onto sensors authored in the
      // archive's frame. Sensor diamonds off the track beside correct boxes is
      // the clearest statement of why the view is refusing.
      check.mockImplementation(async () => ({ displacementPx: 55, refIndex: 0 }));

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.detections).to.deep.equal(detections);
    });

    it('classifies again when the user overrides, and says that it is doing so', async () => {
      check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

      el.shadowRoot!.querySelector<HTMLButtonElement>('.notice.refusing button')!.click();
      // The override reaches the sensors on the next frame, not on the render
      // that hides the banner — L1 is recomputed once per frame by design.
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      const stillRefusing = () =>
        viewer.sensorStates!.get('S1abcdefghi')?.state === 'unknown' &&
        (viewer.sensorStates!.get('S1abcdefghi') as { reason?: string }).reason === 'drift';
      await waitFor(el, () => !stillRefusing());

      expect(stillRefusing()).to.be.false;
      expect(el.shadowRoot!.querySelector('.notice.refusing')).to.be.null;
      // Overridden is not the same as steady, and the view keeps saying so.
      expect(el.shadowRoot!.textContent).to.contain('Classifying despite');
    });

    it('goes on measuring while refusing, so putting the camera back clears it', async () => {
      // A gate that stopped measuring the moment it fired could not see the fix.
      check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

      const sampled = check.mock.calls.length;
      expect(sampled).to.be.greaterThan(0);
      // Real wall-clock, because the interval is real: the gate re-measures on
      // DRIFT_SAMPLE_INTERVAL_MS, so this waits past one of them. Slow, and the
      // only test here that is — the alternative is to export the interval so a
      // test can shrink it, which would make a timing constant part of the
      // component's surface to prove a property the constant is not about.
      await waitFor(el, () => check.mock.calls.length > sampled, 6000);
      expect(check.mock.calls.length).to.be.greaterThan(sampled);
    }, 10_000);

    it('says drift is unchecked, not absent, for a layout with no images', async () => {
      openDriftCheck.mockImplementation(async () => null as any);

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      await waitFor(el, () => (el.shadowRoot!.textContent ?? '').includes('not being checked'));

      const text = el.shadowRoot!.textContent ?? '';
      expect(text).to.contain('not being checked');
      expect(text).to.contain('no images');
      // "Cannot tell" must not be reported as "no drift", and it must not
      // refuse either — there is nothing to have drifted from.
      expect(el.shadowRoot!.querySelector('.notice.refusing')).to.be.null;
    });

    it('reports a check that could not be built, and classifies anyway', async () => {
      openDriftCheck.mockImplementation(async () => {
        throw new Error('decode failed');
      });

      const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
      standInReadySource(el);
      await waitFor(el, () => (el.shadowRoot!.textContent ?? '').includes('decode failed'));

      expect(el.shadowRoot!.textContent).to.contain('not being checked');
      expect(el.shadowRoot!.querySelector('.notice.refusing')).to.be.null;
    });

    describe('recording drift to a CSV (#217)', () => {
      let blobs: Blob[];
      let downloads: string[];
      let spies: { mockRestore(): void }[];

      beforeEach(() => {
        blobs = [];
        downloads = [];
        spies = [
          vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
            blobs.push(blob as Blob);
            return 'blob:drift';
          }),
          vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
          vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            downloads.push(this.download);
          }),
        ];
      });

      // Not `vi.restoreAllMocks()`: that would also strip this file's ResizeObserver stub.
      afterEach(() => spies.forEach(spy => spy.mockRestore()));

      // jsdom's Blob has no `text()`.
      const readBlob = (blob: Blob) =>
        new Promise<string>(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(blob);
        });

      const recordButton = (el: RRLiveView) =>
        el.shadowRoot!.querySelector<HTMLButtonElement>('.recorder button')!;

      it('downloads one row per sample when stopped, and keeps recording while refusing', async () => {
        check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));

        const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
        recordButton(el).click();
        await el.updateComplete;
        expect(recordButton(el).getAttribute('aria-pressed')).to.equal('true');

        standInReadySource(el);
        await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);
        await waitFor(el, () => (recordButton(el).textContent ?? '').includes('1 row'));

        recordButton(el).click();
        await el.updateComplete;

        expect(downloads).to.have.length(1);
        expect(downloads[0]).to.match(/^drift-\d{8}-\d{6}\.csv$/);
        const [header, row, end] = (await readBlob(blobs[0])).split('\n');
        expect(header).to.equal('time,px,tolerance_px,dpt,past,overridden,stream_width,stream_height');
        expect(row).to.match(
          new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z,40,${TOLERANCE_PX},${DPT},true,false,1280,720$`),
        );
        expect(end).to.equal('');
        expect(recordButton(el).getAttribute('aria-pressed')).to.equal('false');
      });

      it('drops a sample whose frame was grabbed before recording started', async () => {
        // A check of its own: views mounted by earlier tests still loop and call the shared one.
        let release!: () => void;
        const held = vi.fn(
          () => new Promise(resolve => (release = () => resolve({ displacementPx: 4, refIndex: 0 }))),
        );
        openDriftCheck.mockImplementation(async () => ({ check: { check: held }, refName: 'test.jpg' }) as any);

        const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
        standInReadySource(el);
        await waitFor(el, () => held.mock.calls.length > 0);

        recordButton(el).click();
        release();
        const stats = el.shadowRoot!.querySelector('rr-stats-bar')! as any;
        await waitFor(el, () => stats.alignment !== null);
        recordButton(el).click();
        await el.updateComplete;

        expect((await readBlob(blobs[0])).split('\n').filter(Boolean)).to.have.length(1);
      });

      it('downloads what it has when the view is left mid-recording', async () => {
        const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
        recordButton(el).click();
        await el.updateComplete;
        standInReadySource(el);
        await waitFor(el, () => (recordButton(el).textContent ?? '').includes('1 row'));

        el.remove();

        expect(downloads).to.have.length(1);
        expect((await readBlob(blobs[0])).split('\n').filter(Boolean)).to.have.length(2);
      });

      it('records nothing until asked', async () => {
        const el = await fixture<RRLiveView>(html`<rr-live-view .archive=${archive}></rr-live-view>`);
        standInReadySource(el);
        await waitFor(el, () => check.mock.calls.length > 0);
        await el.updateComplete;

        expect(recordButton(el).getAttribute('aria-pressed')).to.equal('false');
        expect(recordButton(el).textContent).to.contain('Record drift');
        expect(downloads).to.have.length(0);
      });
    });
  });
});
