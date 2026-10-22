import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive } from '@rails49/r49';
import { CONFIDENCE_THRESHOLD } from '@occupancy/detector';
import type { Detection } from '@occupancy/detector';
import '../src/rr-diagnostics-view.js';
import type { RRDiagnosticsView } from '../src/rr-diagnostics-view.js';
import type { RRDiagnosticsReport } from '../src/rr-diagnostics-report.js';
import type { RRDiagnosticsQueue } from '../src/rr-diagnostics-queue.js';

// The view that owns the sweep: the detector session's lifetime, the blob URLs
// the report and the queue draw from, and the abandon-on-disconnect that keeps
// twenty seconds of inference off a detached element. It shipped with no test
// file at all, which is why the leak fixed in #108 could live here (#109).
//
// What these tests can prove is the state machine and the resource ownership.
// They cannot prove a box lands where the model put it — jsdom decodes no JPEG
// and paints nothing, so the pixels are stubbed and `detect` is mocked. The
// arithmetic between the two is `diagnostics.ts`'s, and `diagnostics.test.ts`
// covers it.

/**
 * The session is mocked whole, rather than mocking `loadDetector` underneath
 * it: importing the real module pulls in ORT, and `detectorSession.test.ts` is
 * where that module's own behaviour belongs.
 *
 * `DETECTOR_SOURCE` is deliberately **not** the real model URL. The fatal
 * message has to name where the load was actually pointed, and a stand-in value
 * is the only way to tell that apart from a view that wrote the URL itself.
 */
const { SOURCE, openDetector } = vi.hoisted(() => ({
  SOURCE: '/test/nowhere.ort',
  openDetector: vi.fn(),
}));

vi.mock('../src/detectorSession.js', () => ({
  openDetector: () => openDetector(),
  DETECTOR_SOURCE: SOURCE,
}));

/**
 * A promise and its resolver, for holding a sweep still at a chosen `await`.
 *
 * Every interesting property of this view is a mid-flight one — progress, a
 * partial report, an abandoned run's blob URLs — and none of them is observable
 * if the sweep runs to completion within one microtask drain.
 */
function gate() {
  let open!: () => void;
  const passed = new Promise<void>(resolve => {
    open = resolve;
  });
  return { passed, open };
}

/**
 * Blob URLs, counted.
 *
 * `tests/setup.ts` installs `URL.createObjectURL` as a bare `vi.fn()` returning
 * `undefined`, which is enough for a module that only passes the handle along
 * and useless here: every URL has to be distinguishable to say whether it was
 * handed back. jsdom implements neither function itself.
 */
function trackBlobUrls() {
  let issued = 0;
  const live = new Set<string>();
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${++issued}`;
    live.add(url);
    return url;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    live.delete(url);
  });
  return {
    get issued() {
      return issued;
    },
    /** Handles created and never revoked — a leak, one per abandoned sweep. */
    get leaked() {
      return [...live];
    },
  };
}

function detection(confidence: number): Detection {
  return { centre: { x: 50, y: 25 }, length: 100, width: 20, angle: 0, class: 'stock', confidence };
}

/**
 * An archive of `count` images, calibrated so a DPT resolves.
 *
 * One equal-`z` pair 100 px and 100 mm apart fits at 1 px/mm, so the DPT is the
 * scale's gauge. The number does not matter here; that it is not `null` does —
 * it is the difference between the view sweeping and refusing to.
 */
async function archiveOf(count: number, calibrated = true, prefix = 'img') {
  const archive = new R49Archive();
  archive.setManifest({
    version: 4,
    layout: {
      name: 'Diagnostics Test',
      scale: 'N',
      calibration: {
        points: calibrated
          ? [
              { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
              { px: { x: 100, y: 0 }, world: { x: 100, y: 0, z: 0 } },
            ]
          : [],
      },
      sensors: [],
    },
    camera: { resolution: { width: 200, height: 100 } },
    images: [],
  });
  for (let i = 0; i < count; i++) {
    await archive.addImage(`${prefix}${i}.jpg`, new Uint8Array([0xff, 0xd8, 0xff]));
  }
  return archive;
}

/** Poll until the view reaches a state, rather than guessing a microtask count. */
async function waitFor(el: RRDiagnosticsView, done: () => boolean, budgetMs = 1000) {
  for (let waited = 0; waited < budgetMs && !done(); waited += 5) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await el.updateComplete;
  }
  await el.updateComplete;
}

const report = (el: RRDiagnosticsView) =>
  el.shadowRoot!.querySelector('rr-diagnostics-report') as RRDiagnosticsReport | null;
const queue = (el: RRDiagnosticsView) =>
  el.shadowRoot!.querySelector('rr-diagnostics-queue') as RRDiagnosticsQueue | null;
const text = (el: RRDiagnosticsView) => el.shadowRoot!.textContent!.replace(/\s+/g, ' ').trim();

describe('rr-diagnostics-view', () => {
  let detect: ReturnType<typeof vi.fn>;
  let dispose: ReturnType<typeof vi.fn>;
  let blobs: ReturnType<typeof trackBlobUrls>;
  let realCreate: typeof URL.createObjectURL;
  let realRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    // jsdom has no `HTMLImageElement.decode`. The sweep awaits it before every
    // `detect` — inside the try — so without this every run resolves to the
    // "Inference failed" state and no happy path is reachable.
    HTMLImageElement.prototype.decode = async function decode(this: HTMLImageElement) {
      Object.defineProperty(this, 'naturalWidth', { value: 200, configurable: true });
      Object.defineProperty(this, 'naturalHeight', { value: 100, configurable: true });
    };

    realCreate = URL.createObjectURL;
    realRevoke = URL.revokeObjectURL;
    blobs = trackBlobUrls();

    detect = vi.fn(async () => [detection(0.9)]);
    dispose = vi.fn(async () => {});
    openDetector.mockReset();
    openDetector.mockImplementation(async () => ({ detect, dispose }));
  });

  afterEach(() => {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  it('asks for a layout before it asks for anything else', async () => {
    const el = await fixture<RRDiagnosticsView>(html`<rr-diagnostics-view></rr-diagnostics-view>`);

    expect(text(el)).to.contain('Open a layout');
    expect(openDetector).not.toHaveBeenCalled();
  });

  it('refuses an uncalibrated archive without loading a detector', async () => {
    // No DPT means no car width, so there is no rectangle to compare a
    // prediction against — the view has nothing to say and should not spend
    // twenty seconds of WASM discovering that.
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(1, false)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => text(el).includes('calibration'));

    expect(el.shadowRoot!.querySelector('.notice')).to.exist;
    expect(text(el)).to.contain('calibration');
    expect(report(el)).to.be.null;
    expect(openDetector).not.toHaveBeenCalled();
  });

  it('treats a failed detector load as fatal, and says where it looked', async () => {
    // Unlike the live view, where `occupancy()` is total and a missing model
    // still yields an honest `unknown` per sensor. Here the model's output is
    // the entire content of the view, so there is no partial answer to give.
    openDetector.mockRejectedValue(new Error('404 fetching the model'));
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(2)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => el.shadowRoot!.querySelector('.notice.error') !== null);

    const notice = text(el);
    expect(notice).to.contain(SOURCE);
    expect(notice).to.contain('404 fetching the model');
    expect(report(el)).to.be.null;
    expect(queue(el)).to.be.null;
  });

  it('reports a failure mid-sweep rather than a half-finished run', async () => {
    detect.mockRejectedValueOnce(new Error('tensor shape'));
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(2)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => el.shadowRoot!.querySelector('.notice.error') !== null);

    expect(text(el)).to.contain('tensor shape');
  });

  it('counts progress against the archive, and shows results as they arrive', async () => {
    const archive = await archiveOf(3);
    const held = gate();
    const original = archive.getImage.bind(archive);
    let served = 0;
    // Hold the third image, so the view is observably mid-sweep with two done.
    archive.getImage = async (filename: string) => {
      if (++served === 3) await held.passed;
      return original(filename);
    };

    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${archive}></rr-diagnostics-view>`
    );
    await waitFor(el, () => text(el).includes('2 of 3'));

    expect(text(el)).to.contain('2 of 3');
    // Partial results, not a spinner: two images are scored and on screen while
    // the third is still in flight.
    const partial = report(el)!;
    expect(partial).to.exist;
    expect(partial.sweeping).to.be.true;
    expect(partial.diagnostics!.images).to.have.lengthOf(2);

    held.open();
    await waitFor(el, () => !text(el).includes('of 3'));

    expect(report(el)!.sweeping).to.be.false;
    expect(report(el)!.diagnostics!.images).to.have.lengthOf(3);
    expect(detect).toHaveBeenCalledTimes(3);
  });

  it("reports at the detector's own threshold until the user moves it", async () => {
    // The live view takes `detect`'s default, which is this constant; the
    // report has to start from the same number to describe what ships (#232).
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(1)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => report(el)?.diagnostics?.images.length === 1);

    expect(report(el)!.threshold).to.equal(CONFIDENCE_THRESHOLD);
  });

  it('re-scores at a new threshold without running inference again', async () => {
    // The reason `detect` is run at a floor far below the shipped threshold and
    // filtered afterwards: re-scoring is arithmetic over a few dozen
    // rectangles, where re-running inference is twenty seconds of WASM.
    detect.mockResolvedValue([detection(0.4)]);
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(1)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => report(el)?.diagnostics?.images.length === 1);

    expect(report(el)!.diagnostics!.detections).to.equal(1);
    const inferences = detect.mock.calls.length;

    report(el)!.dispatchEvent(
      new CustomEvent('rr-diagnostics-threshold', {
        detail: { value: 0.8 },
        bubbles: true,
        composed: true,
      })
    );
    await waitFor(el, () => report(el)!.threshold === 0.8);

    // The box is below the new floor, so it is gone from the scoring — and the
    // model was not asked a second time.
    expect(report(el)!.diagnostics!.detections).to.equal(0);
    expect(detect).toHaveBeenCalledTimes(inferences);
  });

  it('runs inference once per image, at a floor below the reporting threshold', async () => {
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(2)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => detect.mock.calls.length === 2);

    for (const [, , options] of detect.mock.calls) {
      expect(options.minConfidence).to.be.lessThan(report(el)!.threshold);
    }
    // The archive's own resolution, not the fallback.
    expect(detect.mock.calls[0][1]).to.deep.equal({ width: 200, height: 100 });
  });

  it('opens a per-image queue on review, and returns to the report on close', async () => {
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(2)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => report(el)?.diagnostics?.images.length === 2);

    report(el)!.dispatchEvent(
      new CustomEvent('rr-diagnostics-review', {
        detail: { filename: 'img1.jpg' },
        bubbles: true,
        composed: true,
      })
    );
    await waitFor(el, () => queue(el) !== null);

    expect(report(el)).to.be.null;
    expect(queue(el)!.image!.filename).to.equal('img1.jpg');
    // The queue draws the image, so it needs the handle the sweep created.
    expect(queue(el)!.imageUrl).to.be.a('string');
    expect(queue(el)!.dpt).to.be.a('number');

    queue(el)!.dispatchEvent(
      new CustomEvent('rr-diagnostics-close', { bubbles: true, composed: true })
    );
    await waitFor(el, () => report(el) !== null);

    expect(queue(el)).to.be.null;
  });

  it('hands back every blob URL when a sweep is abandoned by disconnection', async () => {
    // The #108 regression, exactly: the abort lands while an image's bytes are
    // being read, so `_teardown` revokes and clears the published map *before*
    // this iteration creates its own handle and republishes. Nothing but the
    // sweep's own release can free that one, and a bare `return` pinned it for
    // the lifetime of the document — once per abandoned sweep.
    const archive = await archiveOf(3);
    const held = gate();
    const original = archive.getImage.bind(archive);
    let served = 0;
    archive.getImage = async (filename: string) => {
      if (++served === 2) await held.passed;
      return original(filename);
    };

    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${archive}></rr-diagnostics-view>`
    );
    await waitFor(el, () => blobs.issued === 1);

    el.remove();
    held.open();
    await waitFor(el, () => blobs.issued === 2);

    expect(blobs.issued).to.equal(2);
    expect(blobs.leaked).to.deep.equal([]);
    expect(dispose).toHaveBeenCalled();
  });

  it('hands back every blob URL when the archive is replaced mid-sweep', async () => {
    const first = await archiveOf(3);
    const held = gate();
    const original = first.getImage.bind(first);
    let served = 0;
    first.getImage = async (filename: string) => {
      if (++served === 2) await held.passed;
      return original(filename);
    };

    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${first}></rr-diagnostics-view>`
    );
    await waitFor(el, () => blobs.issued === 1);

    el.archive = await archiveOf(1, true, 'next');
    await waitFor(el, () => report(el)?.diagnostics?.images[0]?.filename === 'next0.jpg');

    // Only now let the abandoned sweep resume, so the two are not racing and
    // the count below is fixed: two handles from the first archive, one from
    // the second.
    held.open();
    await waitFor(el, () => blobs.issued === 3);

    expect(blobs.issued).to.equal(3);
    expect(blobs.leaked).to.have.lengthOf(1);
    // And the one still live is the live sweep's, not an orphan.
    expect([...report(el)!.imageUrls.values()]).to.deep.equal(blobs.leaked);
    expect(dispose).toHaveBeenCalled();
  });

  it('opens one detector session per archive, and disposes the one it replaces', async () => {
    // Each caller owns the session it opens: nothing is shared and nothing is
    // reference-counted, so a sweep that dropped its session would leave a WASM
    // heap held for a view nobody is using.
    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${await archiveOf(1)}></rr-diagnostics-view>`
    );
    await waitFor(el, () => report(el)?.diagnostics?.images.length === 1);
    expect(openDetector).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();

    el.archive = await archiveOf(1);
    await waitFor(el, () => openDetector.mock.calls.length === 2);

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('skips a manifest entry whose bytes are missing rather than failing the run', async () => {
    const archive = await archiveOf(2);
    const original = archive.getImage.bind(archive);
    archive.getImage = async (filename: string) =>
      filename === 'img0.jpg' ? null : original(filename);

    const el = await fixture<RRDiagnosticsView>(
      html`<rr-diagnostics-view .archive=${archive}></rr-diagnostics-view>`
    );
    await waitFor(el, () => report(el)?.diagnostics?.images.length === 1);

    expect(el.shadowRoot!.querySelector('.notice.error')).to.be.null;
    expect(report(el)!.diagnostics!.images[0].filename).to.equal('img1.jpg');
  });
});
