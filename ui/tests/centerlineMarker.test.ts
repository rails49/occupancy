import { fixture, html, expect } from '@open-wc/testing';
import { vi, describe, it } from 'vitest';
import '../src/rr-viewer.js';
import { RrViewer } from '../src/rr-viewer.js';
import { sensorPatch } from '../src/centerlineMarker.js';
import { HIGHLIGHT_CLASS } from '../src/highlight.js';
import { NO_TRACK_G, PATCH_ACROSS_G, secondCenterlineReachPx } from '../src/geometry.js';
import type { Centerline } from '../src/geometry.js';
import type { Sensor } from '@rails49/r49';

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

/**
 * The centerline layer (#275): the traced polylines, a sensor's patch outline,
 * the two sensor marks, the run in flight, and the spots a trace stopped at.
 *
 * jsdom does not paint, so nothing here claims a line lands on the rails. What
 * it does pin is what the overlay *contains*: which elements exist, what they
 * are keyed by, and — the part a reader cannot see — that passing no
 * centerlines draws none of it, which is how the live view stays unchanged.
 */

const DPT = 20;

const line: Centerline = {
  id: 'L1',
  points: [
    { x: 100, y: 100 },
    { x: 140, y: 100 },
    { x: 180, y: 100 },
  ],
};

const sensor = (id: string, x: number, y: number): Sensor => ({ id, x, y });

async function viewer(props: Partial<RrViewer> = {}): Promise<RrViewer> {
  const el = await fixture<RrViewer>(html`<rr-viewer></rr-viewer>`);
  Object.assign(el, { resolution: { width: 600, height: 400 }, dpt: DPT, ...props });
  await el.updateComplete;
  return el;
}

const svg = (el: RrViewer) => el.shadowRoot!.querySelector('svg')!;

describe('the centerline layer', () => {
  it('draws nothing at all with no centerlines — which is the live view', async () => {
    // The live view passes none, so every part of this layer is absent there
    // with no second property to remember (#275).
    const el = await viewer({ sensors: [sensor('s1', 300, 200)] });
    expect(svg(el).querySelector('.centerline')).to.be.null;
    expect(svg(el).querySelector('.patch')).to.be.null;
    expect(svg(el).querySelector('.sensor-mark')).to.be.null;
  });

  it('draws one polyline per centerline, keyed by id', async () => {
    const el = await viewer({ centerlines: [line, { ...line, id: 'L2' }] });
    const groups = [...svg(el).querySelectorAll('g.centerline')];
    expect(groups.map(g => g.getAttribute('data-centerline-id'))).to.deep.equal(['L1', 'L2']);
    expect(groups[0].querySelector('polyline')!.getAttribute('points')).to.equal(
      '100,100 140,100 180,100'
    );
  });

  it('shows a line’s points only while it is selected', async () => {
    const el = await viewer({ centerlines: [line] });
    expect(svg(el).querySelectorAll('.centerline .handle')).to.have.lengthOf(0);

    el.selectedCenterline = 'L1';
    await el.updateComplete;
    const handles = [...svg(el).querySelectorAll('.centerline .handle')];
    expect(handles).to.have.lengthOf(3);
    expect(handles.map(h => h.getAttribute('data-point-index'))).to.deep.equal(['0', '1', '2']);
  });

  it('marks the selected line’s stroke, so it reads as the one being edited', async () => {
    const el = await viewer({ centerlines: [line], selectedCenterline: 'L1' });
    expect(svg(el).querySelector('polyline.line')!.classList.contains('selected')).to.be.true;
  });

  it('takes the shared glow when a reveal points at a line', async () => {
    const el = await viewer({
      centerlines: [line],
      highlight: { cars: [], sensors: [], calibration: [], centerlines: ['L1'] },
    });
    expect(svg(el).querySelector('g.centerline')!.classList.contains(HIGHLIGHT_CLASS)).to.be.true;
  });

  it('outlines a patch at a sensor on the track, turned to the line', async () => {
    const el = await viewer({ centerlines: [line], sensors: [sensor('s1', 140, 100)] });
    const patch = svg(el).querySelector('polygon.patch')!;
    expect(patch).to.exist;
    // The line runs along x, so the patch's long axis does too: 5 G by 3 G.
    const xs = patch
      .getAttribute('points')!
      .split(' ')
      .map(pair => Number(pair.split(',')[0]));
    expect(Math.max(...xs) - Math.min(...xs)).to.be.closeTo(5 * DPT, 1e-6);
  });

  it('crosses a sensor more than half a gauge from every line, and draws it no patch', async () => {
    const el = await viewer({
      centerlines: [line],
      sensors: [sensor('s1', 140, 100 + NO_TRACK_G * DPT + 1)],
    });
    expect(svg(el).querySelector('.sensor-mark')!.getAttribute('data-mark')).to.equal('no-track');
    expect(svg(el).querySelector('.patch')).to.be.null;
  });

  it('rings a sensor a second centerline comes within reach of', async () => {
    const second: Centerline = {
      id: 'L2',
      points: [
        { x: 100, y: 100 + secondCenterlineReachPx(DPT) - 1 },
        { x: 180, y: 100 + secondCenterlineReachPx(DPT) - 1 },
      ],
    };
    const el = await viewer({ centerlines: [line, second], sensors: [sensor('s1', 140, 100)] });
    expect(svg(el).querySelector('.sensor-mark')!.getAttribute('data-mark')).to.equal(
      'second-centerline'
    );
    expect(svg(el).querySelector('.patch'), 'still judged, still outlined').to.exist;
  });

  it('draws no mark on a sensor on one track with nothing else near', async () => {
    const el = await viewer({ centerlines: [line], sensors: [sensor('s1', 140, 100)] });
    expect(svg(el).querySelector('.sensor-mark')).to.be.null;
  });

  it('draws the run in flight dashed, with a handle on every point', async () => {
    const el = await viewer({
      centerlines: [],
      pendingRun: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
      ],
    });
    const pending = svg(el).querySelector('polyline.line.pending')!;
    expect(pending.getAttribute('points')).to.equal('10,10 30,10');
    expect(svg(el).querySelectorAll('.centerline .handle')).to.have.lengthOf(2);
  });

  it('marks every spot a trace stopped short at', async () => {
    const el = await viewer({
      traceStops: [
        { x: 50, y: 50 },
        { x: 90, y: 50 },
      ],
    });
    expect(svg(el).querySelectorAll('.trace-stop')).to.have.lengthOf(2);
  });
});

describe('sensorPatch', () => {
  it('answers nothing while no centerline is traced', () => {
    // With an empty list every sensor is more than half a gauge from every
    // centerline; a hundred crosses on a fresh archive would say nothing.
    expect(sensorPatch(sensor('s', 10, 10), [], DPT)).to.deep.equal({ patch: null, mark: null });
  });

  it('answers nothing with no DPT, since the patch is sized in gauges', () => {
    expect(sensorPatch(sensor('s', 140, 100), [line], null)).to.deep.equal({
      patch: null,
      mark: null,
    });
  });

  it('lets no-track win over a second centerline', () => {
    // A sensor that is on no track has no second one to warn about, and two
    // marks on one symbol would read as two problems.
    // 0.6 G off L1 — past the no-track reach — and 1.0 G off L2, well inside
    // the warning's. Both claims hold; only one mark may show.
    const second: Centerline = {
      id: 'L2',
      points: [
        { x: 100, y: 100 + 1.6 * DPT },
        { x: 180, y: 100 + 1.6 * DPT },
      ],
    };
    const at = 100 + 0.6 * DPT;
    expect(0.6 * DPT).to.be.greaterThan(NO_TRACK_G * DPT);
    expect(DPT).to.be.lessThan(secondCenterlineReachPx(DPT));
    const { patch, mark } = sensorPatch(sensor('s', 140, at), [line, second], DPT);
    expect(mark).to.equal('no-track');
    expect(patch).to.be.null;
  });

  it('sizes the patch from the one named constant', () => {
    const { patch } = sensorPatch(sensor('s', 140, 100), [line], DPT);
    const ys = patch!.map(corner => corner.y);
    expect(Math.max(...ys) - Math.min(...ys)).to.be.closeTo(PATCH_ACROSS_G * DPT, 1e-6);
  });
});
