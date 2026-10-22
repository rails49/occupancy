import { fixture, html, expect } from '@open-wc/testing';
import { vi, describe, it, beforeEach } from 'vitest';
import '../src/rr-viewer.js';
import { RrViewer } from '../src/rr-viewer.js';
import type {
  ViewerPointerDetail,
  ViewerContextMenuDetail,
  ViewerPointerEventName,
} from '../src/rr-viewer.js';
import { HIGHLIGHT_CLASS } from '../src/highlight.js';
import type { Detection } from '@occupancy/detector';
import type { SensorState } from '../src/occupancy.js';

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('ResizeObserver', MockResizeObserver);

// jsdom implements no PointerEvent. A MouseEvent carrying a pointerId is
// everything the viewer reads off one.
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

/**
 * Give the SVG the geometry jsdom lacks: a uniform scale plus an offset,
 * standing in for a letterboxed viewport. `screen = image * scale + offset`.
 *
 * The CTM goes on the **content group**, which is where the viewer reads it:
 * the group's user space is the authored frame, and the SVG's is the media's
 * own pixel grid.
 */
function stubSvgGeometry(
  svg: SVGSVGElement,
  { scale, offsetX = 0, offsetY = 0 }: { scale: number; offsetX?: number; offsetY?: number }
) {
  const inverse = { a: 1 / scale, d: 1 / scale, e: -offsetX / scale, f: -offsetY / scale };
  const ctm = { a: scale, d: scale, e: offsetX, f: offsetY, inverse: () => inverse };
  const frame = svg.querySelector('g.frame') as SVGGElement;
  frame.getScreenCTM = () => ctm as unknown as DOMMatrix;
  svg.createSVGPoint = () => {
    const pt = {
      x: 0,
      y: 0,
      matrixTransform: (m: { a: number; d: number; e: number; f: number }) => ({
        x: pt.x * m.a + m.e,
        y: pt.y * m.d + m.f,
      }),
    };
    return pt as unknown as DOMPoint;
  };
  // jsdom implements no pointer capture either. Track it for real, so the
  // viewer's hasPointerCapture guard is exercised rather than stubbed past.
  const captured = new Set<number>();
  svg.setPointerCapture = vi.fn((id: number) => void captured.add(id));
  svg.hasPointerCapture = vi.fn((id: number) => captured.has(id));
  svg.releasePointerCapture = vi.fn((id: number) => void captured.delete(id));
}

/** Arguments each call received. `expect` here is chai's, not vitest's. */
function calls(fn: unknown): unknown[][] {
  return (fn as ReturnType<typeof vi.fn>).mock.calls;
}

describe('rr-viewer', () => {
  const resolution = { width: 1000, height: 1000 };

  it('renders <img> when src is set', async () => {
    const el = await fixture<RrViewer>(html`
      <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
    `);
    expect(el.shadowRoot!.querySelector('img')).to.exist;
    expect(el.shadowRoot!.querySelector('video')).to.not.exist;
  });

  it('renders <video> when stream is set', async () => {
    const stream = {} as MediaStream;
    const el = await fixture<RrViewer>(html`
      <rr-viewer .stream=${stream} .resolution=${resolution}></rr-viewer>
    `);
    expect(el.shadowRoot!.querySelector('video')).to.exist;
    expect(el.shadowRoot!.querySelector('img')).to.not.exist;
  });

  it('sets SVG viewBox correctly', async () => {
    const el = await fixture<RrViewer>(html`
      <rr-viewer .resolution=${{ width: 800, height: 600 }}></rr-viewer>
    `);
    const svg = el.shadowRoot!.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).to.equal('0 0 800 600');
  });

  // jsdom neither loads images nor lays anything out, so what these assert is
  // the **derivation** — the viewBox and the content transform the viewer
  // computes from the sizes it is given — and not the paint, which no test here
  // can see. The paint follows from the derivation because the media and the
  // overlay cover the same box and fit their content into it by the same rule.
  describe('the media and the overlay resolve to one box (#41)', () => {
    /** Give the media a natural size, as a real load would, and fire `load`. */
    function loadImage(el: RrViewer, size: { width: number; height: number }) {
      const img = el.shadowRoot!.querySelector('img')!;
      Object.defineProperty(img, 'naturalWidth', { value: size.width, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: size.height, configurable: true });
      img.dispatchEvent(new Event('load'));
    }

    const frameTransform = (el: RrViewer) =>
      el.shadowRoot!.querySelector('g.frame')!.getAttribute('transform');
    const viewBox = (el: RrViewer) => el.shadowRoot!.querySelector('svg')!.getAttribute('viewBox');

    it('draws in the authored frame until the media reports a size', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${{ width: 1920, height: 1080 }}></rr-viewer>
      `);
      expect(viewBox(el)).to.equal('0 0 1920 1080');
      expect(frameTransform(el)).to.equal('scale(1, 1)');
    });

    it('follows the image pixel grid once the image loads', async () => {
      // A 4K photo of a 1080p frame is the same view at twice the pixels. The
      // viewBox follows the photograph — that is what makes the overlay's
      // letterbox the photograph's letterbox — and the authored frame is
      // scaled onto it, so a point at (960, 540) still lands mid-photo.
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${{ width: 1920, height: 1080 }}></rr-viewer>
      `);
      loadImage(el, { width: 3840, height: 2160 });
      await el.updateComplete;

      expect(viewBox(el)).to.equal('0 0 3840 2160');
      expect(frameTransform(el)).to.equal('scale(2, 2)');
    });

    it('stretches the authored frame over a photograph of another shape', async () => {
      // 16:9 declared, 4:3 delivered — the ticket's repro. Before this, points
      // well inside the photograph rendered out on the letterbox bars.
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${{ width: 640, height: 360 }}></rr-viewer>
      `);
      loadImage(el, { width: 640, height: 480 });
      await el.updateComplete;

      expect(viewBox(el)).to.equal('0 0 640 480');
      const [, sx, sy] = frameTransform(el)!.match(/scale\(([\d.]+), ([\d.]+)\)/)!;
      expect(Number(sx)).to.equal(1);
      expect(Number(sy)).to.be.closeTo(480 / 360, 1e-9);
    });

    it('reports a mismatch rather than absorbing it', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${{ width: 640, height: 360 }}></rr-viewer>
      `);
      const seen: { media: unknown; frame: unknown; aspectMismatch: boolean }[] = [];
      el.addEventListener('rr-media-frame', e => seen.push(e.detail));

      loadImage(el, { width: 640, height: 480 });

      expect(seen.length).to.equal(1);
      expect(seen[0].media).to.deep.equal({ width: 640, height: 480 });
      expect(seen[0].frame).to.deep.equal({ width: 640, height: 360 });
      expect(seen[0].aspectMismatch).to.be.true;
    });

    it('reports a re-encoded image of the right shape as no mismatch', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${{ width: 1920, height: 1080 }}></rr-viewer>
      `);
      const seen: { aspectMismatch: boolean }[] = [];
      el.addEventListener('rr-media-frame', e => seen.push(e.detail));

      loadImage(el, { width: 1280, height: 720 });

      expect(seen.map(d => d.aspectMismatch)).to.deep.equal([false]);
    });

    it('forgets the media size when the image changes', async () => {
      // Images are per image and `camera.resolution` is per archive, so the
      // next image is a new grid. Drawing it against the previous one's would
      // misplace every object on it until it decoded.
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="a.jpg" .resolution=${{ width: 1920, height: 1080 }}></rr-viewer>
      `);
      loadImage(el, { width: 3840, height: 2160 });
      await el.updateComplete;

      el.src = 'b.jpg';
      await el.updateComplete;

      expect(viewBox(el)).to.equal('0 0 1920 1080');
      expect(frameTransform(el)).to.equal('scale(1, 1)');
    });

    it('ignores a load that reports no size', async () => {
      // A decode failure leaves `naturalWidth` at 0, and a zero divisor would
      // put every object at NaN.
      const el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${{ width: 1920, height: 1080 }}></rr-viewer>
      `);
      loadImage(el, { width: 0, height: 0 });
      await el.updateComplete;

      expect(viewBox(el)).to.equal('0 0 1920 1080');
    });

    it('sizes screen-constant annotations from the same transform', async () => {
      // The derivation, which is all jsdom can see: a label is drawn at
      // `SYMBOL_SIZE_SCREEN_PX * imagePxPerScreenPx` image pixels, and
      // `imagePxPerScreenPx` is `1 / ctm.a` off the content group. So
      // `fontSize * ctm.a` — its size on screen — is the same number at any
      // scale. Taken from the CTM and not from the SVG's bounding rect, which
      // is wrong by the letterbox.
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .calibrationPoints=${[{ px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } }]}
          .resolution=${{ width: 640, height: 360 }}
        ></rr-viewer>
      `);
      const svg = el.shadowRoot!.querySelector('svg')!;
      const measure = () => (el as unknown as { measureScale(): void }).measureScale();
      const fontSize = () =>
        Number(el.shadowRoot!.querySelector('.calibration-point text')!.getAttribute('font-size'));

      stubSvgGeometry(svg, { scale: 0.5 });
      measure();
      await el.updateComplete;
      const small = fontSize() * 0.5;

      stubSvgGeometry(svg, { scale: 4 });
      measure();
      await el.updateComplete;
      const large = fontSize() * 4;

      expect(small).to.be.closeTo(large, 1e-9);
      expect(small).to.be.greaterThan(0);
    });

    it('follows the video frame size in stream mode too', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .stream=${{} as MediaStream} .resolution=${{ width: 1920, height: 1080 }}></rr-viewer>
      `);
      const video = el.shadowRoot!.querySelector('video')!;
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
      await el.updateComplete;

      expect(viewBox(el)).to.equal('0 0 1280 720');
      expect(frameTransform(el)).to.equal('scale(0.6666666666666666, 0.6666666666666666)');
    });
  });

  describe('detections (L0)', () => {
    const detection = (over: Partial<Detection> = {}): Detection => ({
      centre: { x: 480, y: 270 },
      length: 200,
      width: 42,
      angle: 0,
      class: 'stock',
      confidence: 0.9,
      ...over,
    });

    it('draws one box per detection', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .detections=${[detection(), detection({ centre: { x: 200, y: 100 } })]}
          .resolution=${resolution}
        ></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelectorAll('.detection polygon').length).to.equal(2);
    });

    it('draws none by default — the editor passes no detections', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.detection')).to.not.exist;
    });

    it('draws them over the authored cars, and under the sensors', async () => {
      // Order in the overlay is the claim: the archive diagnostics read a
      // prediction *against* a label, so the box goes on top of the rectangle
      // — but a sensor is a point and must never end up under an area.
      const car = {
        id: 'C1abcdefghi',
        class: 'stock',
        provenance: 'human' as const,
        p0: { x: 100, y: 100 },
        p1: { x: 300, y: 100 },
      };
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .cars=${[car]}
          .detections=${[detection()]}
          .sensors=${[{ id: 'S1abcdefghi', x: 480, y: 270 }]}
          .dpt=${30}
          .resolution=${resolution}
        ></rr-viewer>
      `);

      const groups = [...el.shadowRoot!.querySelectorAll('g.frame > g')];
      const at = (cls: string) => groups.findIndex(g => g.classList.contains(cls));
      expect(at('car')).to.be.lessThan(at('detection'));
      expect(at('detection')).to.be.lessThan(at('sensor'));
    });
  });

  describe('sensor states (L1)', () => {
    const sensors = [{ id: 'S1abcdefghi', x: 100, y: 100 }];

    it('passes each sensor its own state', async () => {
      const states = new Map<string, SensorState>([['S1abcdefghi', { state: 'clear' }]]);
      const el = await fixture<RrViewer>(html`
        <rr-viewer .sensors=${sensors} .sensorStates=${states} .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.sensor')!.getAttribute('data-state')).to.equal('clear');
    });

    it('draws a stateless sensor when nothing is reading it', async () => {
      // `null` is the editor. It is not the same as a live view that answered
      // no sensor, which `occupancy()` cannot produce — it is total.
      const el = await fixture<RrViewer>(html`
        <rr-viewer .sensors=${sensors} .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.sensor')!.getAttribute('data-state')).to.equal('');
    });
  });

  describe('calibration points', () => {
    const points = [
      { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      { px: { x: 400, y: 300 }, world: { x: 0, y: 250, z: 0 } },
    ];

    it('draws one labelled crosshair per point', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .calibrationPoints=${points} .resolution=${resolution}></rr-viewer>
      `);
      const drawn = el.shadowRoot!.querySelectorAll('.calibration-point');
      expect(drawn.length).to.equal(2);
      expect(drawn[1].querySelector('text')!.textContent).to.contain('0, 250, 0');
    });

    it('draws none by default, so the live view is unaffected', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.calibration-point')).to.not.exist;
    });
  });

  describe('sensors', () => {
    const sensors = [
      { id: 'S1abcdefghi', x: 100, y: 100 },
      { id: 'S2abcdefghi', x: 400, y: 300, name: 'Yard throat' },
    ];
    const calibrationPoints = [
      { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      { px: { x: 400, y: 300 }, world: { x: 0, y: 250, z: 0 } },
    ];

    it('draws one labelled symbol per sensor', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .sensors=${sensors} .resolution=${resolution}></rr-viewer>
      `);
      const drawn = el.shadowRoot!.querySelectorAll('.sensor');
      expect(drawn.length).to.equal(2);
      // Its name when it has one, its id when it does not.
      expect(drawn[0].querySelector('text')!.textContent).to.contain('S1abcdefghi');
      expect(drawn[1].querySelector('text')!.textContent).to.contain('Yard throat');
    });

    it('draws them distinctly from calibration crosshairs, and alongside them', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .sensors=${sensors}
          .calibrationPoints=${calibrationPoints}
          .resolution=${resolution}
        ></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelectorAll('.sensor').length).to.equal(2);
      expect(el.shadowRoot!.querySelectorAll('.calibration-point').length).to.equal(2);
      // Shape, not just colour: nothing in a crosshair is a polygon.
      expect(el.shadowRoot!.querySelectorAll('.sensor polygon').length).to.equal(2);
      expect(el.shadowRoot!.querySelector('.calibration-point polygon')).to.not.exist;
    });

    it('draws none by default, so the live view is unaffected', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.sensor')).to.not.exist;
    });

    /** The diamond's width in image pixels, off the rendered polygon. */
    function diamondSpan(el: RrViewer): number {
      const xs = el
        .shadowRoot!.querySelector('.sensor polygon')!
        .getAttribute('points')!
        .split(' ')
        .map(pair => Number(pair.split(',')[0]));
      return Math.max(...xs) - Math.min(...xs);
    }

    it('draws a sensor one track width across, which is DPT', async () => {
      // A world size, not a screen one: the sensor shrinks with the photograph
      // exactly as the cars around it do, so the two are comparable.
      const el = await fixture<RrViewer>(html`
        <rr-viewer .sensors=${sensors} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);
      expect(diamondSpan(el)).to.equal(90);

      el.dpt = 20;
      await el.updateComplete;
      expect(diamondSpan(el)).to.equal(20);
    });

    it('falls back to the screen size when no DPT resolves', async () => {
      // An archive can carry sensors and no calibration — deleting a
      // calibration point is allowed at any time — and they must stay visible
      // and grabbable rather than vanish at a size nothing can compute.
      const el = await fixture<RrViewer>(html`
        <rr-viewer .sensors=${sensors} .dpt=${null} .resolution=${resolution}></rr-viewer>
      `);
      expect(diamondSpan(el)).to.be.greaterThan(0);
      expect(el.shadowRoot!.querySelectorAll('.sensor').length).to.equal(2);
    });

    it('leaves the label alone when the DPT changes', async () => {
      // The name is annotation about the sensor, not a measurement of it: a
      // label scaled to the track is illegible at the DPT 18-19 the fixture
      // corpus sits at.
      const el = await fixture<RrViewer>(html`
        <rr-viewer .sensors=${sensors} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);
      const fontSize = el.shadowRoot!.querySelector('.sensor text')!.getAttribute('font-size');

      el.dpt = 18;
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.sensor text')!.getAttribute('font-size')).to.equal(
        fontSize
      );
    });
  });

  describe('cars', () => {
    const cars = [
      { id: 'C1abcdefghi', class: 'stock', provenance: 'human' as const,
        p0: { x: 100, y: 100 }, p1: { x: 300, y: 100 } },
      { id: 'C2abcdefghi', class: 'stock', provenance: 'human' as const,
        p0: { x: 300, y: 100 }, p1: { x: 500, y: 100 } },
    ];

    /** The width rectangle's extent across the span, in image pixels. */
    function rectangleSpan(el: RrViewer, index = 0): number {
      const ys = [...el.shadowRoot!.querySelectorAll('.car polygon')][index]
        .getAttribute('points')!
        .split(' ')
        .map(pair => Number(pair.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    }

    it('draws one chord and one width rectangle per car', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelectorAll('.car').length).to.equal(2);
      expect(el.shadowRoot!.querySelectorAll('.car polygon').length).to.equal(2);
      expect(el.shadowRoot!.querySelectorAll('.car line').length).to.equal(2);
    });

    it('draws none by default, so the live view is unaffected', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.car')).to.not.exist;
    });

    it('sizes the rectangle from DPT — 2.09 track widths, live', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);
      const wide = rectangleSpan(el);

      el.dpt = 20;
      await el.updateComplete;

      expect(wide / rectangleSpan(el)).to.be.closeTo(90 / 20, 1e-6);
    });

    it('keeps the cars and drops the rectangles with no DPT', async () => {
      // Deleting a calibration point is allowed at any time, and the labels
      // already authored have to stay visible and grabbable.
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${cars} .dpt=${null} .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelectorAll('.car').length).to.equal(2);
      expect(el.shadowRoot!.querySelector('.car polygon')).to.not.exist;
      // Two free ends and one shared handle: these two cars are coupled at
      // (300, 100), so the coupling draws the third rather than the cars
      // drawing two on the same pixel.
      expect(el.shadowRoot!.querySelectorAll('.car circle').length).to.equal(2);
      expect(el.shadowRoot!.querySelectorAll('.coupler circle').length).to.equal(1);
    });

    it('leaves the endpoint handles a screen size when the DPT changes', async () => {
      // A handle is where the pointer grabs — it belongs to the mouse, not to
      // the photograph — where the rectangle around it is a world size.
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);
      const r = el.shadowRoot!.querySelector('.car circle')!.getAttribute('r');

      el.dpt = 18;
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.car circle')!.getAttribute('r')).to.equal(r);
    });

    it('warns on a class the authored vocabulary does not name', async () => {
      // Conformance is not checked when the archive is parsed (`SPEC.md`
      // § Format), so the editor is where a mis-typed class becomes visible —
      // and the car is still drawn, because the archive still opens.
      const strange = [{ ...cars[0], class: 'stock.loko' }];
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${strange} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);

      expect(el.shadowRoot!.querySelectorAll('.car.unknown-class').length).to.equal(1);
      expect(el.shadowRoot!.querySelector('.car text')!.textContent).to.contain('stock.loko');
      expect(el.shadowRoot!.querySelector('.car line')).to.exist;
    });

    it('says nothing about a class the vocabulary does name', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);

      expect(el.shadowRoot!.querySelector('.car.unknown-class')).to.not.exist;
      expect(el.shadowRoot!.querySelector('.car text')).to.not.exist;
    });

    it('draws cars under the crosshairs and diamonds', async () => {
      // The rectangles are the only area fills the overlay carries, so a
      // calibration point or a sensor on a car must not be tinted over.
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .cars=${cars}
          .sensors=${[{ id: 'S1abcdefghi', x: 200, y: 100 }]}
          .calibrationPoints=${[{ px: { x: 200, y: 100 }, world: { x: 0, y: 0, z: 0 } }]}
          .dpt=${90}
          .resolution=${resolution}
        ></rr-viewer>
      `);
      // By membership rather than by the whole class attribute: a group carries
      // more than its kind — a warning, a reveal highlight — and draw order is
      // what this is about.
      const groups = [...el.shadowRoot!.querySelectorAll('g')].map(g => [...g.classList]);
      const first = (kind: string) => groups.findIndex(classes => classes.includes(kind));

      expect(first('car')).to.be.lessThan(first('calibration-point'));
      expect(first('car')).to.be.lessThan(first('sensor'));
    });

    describe('couplings', () => {
      it('draws one shared handle where two cars meet', async () => {
        const el = await fixture<RrViewer>(html`
          <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
        `);

        const couplers = [...el.shadowRoot!.querySelectorAll('.coupler circle')];
        expect(couplers.length).to.equal(1);
        expect(couplers[0].getAttribute('cx')).to.equal('300');
        expect(couplers[0].getAttribute('cy')).to.equal('100');
        // And the cars keep only their free ends, so the shared pixel carries
        // exactly one handle rather than three stacked on each other.
        expect(el.shadowRoot!.querySelectorAll('.car circle').length).to.equal(2);
      });

      it('draws one handle for a three-way coincidence too', async () => {
        const yard = [
          ...cars,
          { id: 'C3abcdefghi', class: 'stock', provenance: 'human' as const,
            p0: { x: 300, y: 100 }, p1: { x: 300, y: 400 } },
        ];
        const el = await fixture<RrViewer>(html`
          <rr-viewer .cars=${yard} .dpt=${90} .resolution=${resolution}></rr-viewer>
        `);

        expect(el.shadowRoot!.querySelectorAll('.coupler circle').length).to.equal(1);
        expect(el.shadowRoot!.querySelectorAll('.car circle').length).to.equal(3);
      });

      it('draws none for cars that merely come close', async () => {
        // Coincidence is exact — the same rule the hit-test grabs by.
        const apart = [
          cars[0],
          { ...cars[1], p0: { x: 301, y: 100 } },
        ];
        const el = await fixture<RrViewer>(html`
          <rr-viewer .cars=${apart} .dpt=${90} .resolution=${resolution}></rr-viewer>
        `);

        expect(el.shadowRoot!.querySelector('.coupler')).to.not.exist;
        expect(el.shadowRoot!.querySelectorAll('.car circle').length).to.equal(4);
      });

      it('follows the cars when a coupling is dragged apart', async () => {
        const el = await fixture<RrViewer>(html`
          <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
        `);

        el.cars = [cars[0], { ...cars[1], p0: { x: 380, y: 200 } }];
        await el.updateComplete;

        expect(el.shadowRoot!.querySelector('.coupler')).to.not.exist;
      });
    });

    describe('the rubber band', () => {
      it('draws nothing while no chain is live', async () => {
        const el = await fixture<RrViewer>(html`
          <rr-viewer .cars=${cars} .dpt=${90} .resolution=${resolution}></rr-viewer>
        `);
        expect(el.shadowRoot!.querySelector('.car-pending')).to.not.exist;
      });

      it('draws the band from the anchor to the pointer', async () => {
        const el = await fixture<RrViewer>(html`
          <rr-viewer
            .pendingCar=${{ anchor: { x: 100, y: 100 }, to: { x: 400, y: 250 } }}
            .dpt=${90}
            .resolution=${resolution}
          ></rr-viewer>
        `);

        const line = el.shadowRoot!.querySelector('.car-pending line')!;
        expect(line.getAttribute('x1')).to.equal('100');
        expect(line.getAttribute('x2')).to.equal('400');
        expect(line.getAttribute('y2')).to.equal('250');
      });

      it('is drawn over the cars, so a chain stays legible on a train', async () => {
        const el = await fixture<RrViewer>(html`
          <rr-viewer
            .cars=${cars}
            .pendingCar=${{ anchor: { x: 500, y: 100 }, to: { x: 700, y: 100 } }}
            .dpt=${90}
            .resolution=${resolution}
          ></rr-viewer>
        `);
        const groups = [...el.shadowRoot!.querySelectorAll('g')].map(g => g.getAttribute('class'));

        expect(groups.indexOf('car')).to.be.lessThan(groups.indexOf('car-pending'));
      });

      it('goes away when the chain ends', async () => {
        const el = await fixture<RrViewer>(html`
          <rr-viewer
            .pendingCar=${{ anchor: { x: 100, y: 100 }, to: { x: 400, y: 250 } }}
            .dpt=${90}
            .resolution=${resolution}
          ></rr-viewer>
        `);

        el.pendingCar = null;
        await el.updateComplete;

        expect(el.shadowRoot!.querySelector('.car-pending')).to.not.exist;
      });
    });
  });

  // What an undo lit up (#37). The viewer is told which objects to glow and
  // draws that; deciding what changed is the history's job and resolving it
  // against the manifest is the editor's.
  describe('the reveal highlight', () => {
    const cars = [
      { id: 'C1abcdefghi', class: 'stock', provenance: 'human' as const,
        p0: { x: 100, y: 100 }, p1: { x: 300, y: 100 } },
      { id: 'C2abcdefghi', class: 'stock', provenance: 'human' as const,
        p0: { x: 600, y: 400 }, p1: { x: 800, y: 400 } },
    ];
    const sensors = [{ id: 'S1abcdefghi', x: 100, y: 100 }];
    const points = [
      { px: { x: 40, y: 40 }, world: { x: 0, y: 0, z: 0 } },
      { px: { x: 90, y: 90 }, world: { x: 0, y: 250, z: 0 } },
    ];

    /** Whether the `index`th element of `selector` carries the glow. */
    const lit = (el: RrViewer, selector: string) =>
      [...el.shadowRoot!.querySelectorAll(selector)].map(node =>
        node.classList.contains(HIGHLIGHT_CLASS)
      );

    it('lights only the objects it is given, by id', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .cars=${cars}
          .sensors=${sensors}
          .calibrationPoints=${points}
          .dpt=${90}
          .resolution=${resolution}
          .highlight=${{ cars: ['C2abcdefghi'], sensors: [], calibration: [1] }}
        ></rr-viewer>
      `);

      expect(lit(el, '.car')).to.deep.equal([false, true]);
      expect(lit(el, '.sensor')).to.deep.equal([false]);
      expect(lit(el, '.calibration-point')).to.deep.equal([false, true]);
    });

    it('lights nothing by default, so the live view is unaffected', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .cars=${cars} .sensors=${sensors} .dpt=${90} .resolution=${resolution}></rr-viewer>
      `);
      expect(lit(el, '.car')).to.deep.equal([false, false]);
      expect(lit(el, '.sensor')).to.deep.equal([false]);
    });

    it('goes out when the highlight is cleared', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer
          .sensors=${sensors}
          .resolution=${resolution}
          .highlight=${{ cars: [], sensors: ['S1abcdefghi'], calibration: [] }}
        ></rr-viewer>
      `);
      expect(lit(el, '.sensor')).to.deep.equal([true]);

      el.highlight = null;
      await el.updateComplete;

      expect(lit(el, '.sensor')).to.deep.equal([false]);
    });
  });

  // The viewer reports pointer gestures but still authors nothing: v3's marker
  // add/move/delete and its draggable {p0, p1} pair went with the v4 reduction
  // (#19) and do not come back. Placing anything is the editor's job — the
  // crosshairs above are drawn from a property, never written by the viewer.
  describe('authors nothing', () => {
    it('emits no rr-marker-add when the svg is clicked', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .resolution=${resolution}></rr-viewer>
      `);
      const svg = el.shadowRoot!.querySelector('svg')!;

      let emitted = false;
      el.addEventListener('rr-marker-add', () => { emitted = true; });
      svg.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 200, bubbles: true }));

      expect(emitted).to.be.false;
    });

    it('renders no calibration line or drag handles', async () => {
      const el = await fixture<RrViewer>(html`
        <rr-viewer .resolution=${resolution}></rr-viewer>
      `);
      expect(el.shadowRoot!.querySelector('.calibration-line')).to.not.exist;
      expect(el.shadowRoot!.querySelector('use[href="#drag-handle"]')).to.not.exist;
    });
  });

  describe('pointer events', () => {
    let el: RrViewer;
    let svg: SVGSVGElement;
    let details: ViewerPointerDetail[];

    beforeEach(async () => {
      el = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
      `);
      svg = el.shadowRoot!.querySelector('svg')!;
      // Half-size on screen, shifted 40px right by the letterbox.
      stubSvgGeometry(svg, { scale: 0.5, offsetX: 40, offsetY: 10 });
      details = [];
    });

    // No cast on `e.detail`: the events are declared in HTMLElementEventMap,
    // which is the whole point of declaring them there.
    const collect = (type: ViewerPointerEventName) => {
      el.addEventListener(type, e => details.push(e.detail));
    };

    const press = (type: string, clientX: number, clientY: number, pointerId = 7) =>
      svg.dispatchEvent(new FakePointerEvent(type, { clientX, clientY, pointerId, bubbles: true }));

    it('reports pointer-down in image pixels, not screen pixels', () => {
      collect('rr-pointer-down');
      press('pointerdown', 140, 110);

      expect(details.length).to.equal(1);
      expect(details[0].point).to.deep.equal({ x: 200, y: 200 });
    });

    it('reports the image-pixels-per-screen-pixel factor with every event', () => {
      collect('rr-pointer-down');
      press('pointerdown', 140, 110);

      // The image renders at half size, so one screen pixel spans two of it.
      expect(details[0].imagePxPerScreenPx).to.equal(2);
    });

    it('carries the originating event, for pointerId and modifiers', () => {
      collect('rr-pointer-down');
      press('pointerdown', 140, 110, 42);

      expect(details[0].originalEvent.pointerId).to.equal(42);
    });

    it('reports move and up as well as down', () => {
      collect('rr-pointer-down');
      collect('rr-pointer-move');
      collect('rr-pointer-up');

      press('pointerdown', 140, 110);
      press('pointermove', 240, 110);
      press('pointerup', 340, 110);

      expect(details.map(d => d.point.x)).to.deep.equal([200, 400, 600]);
    });

    it('reports a cancelled gesture separately from a finished one', () => {
      let ups = 0;
      let cancels = 0;
      el.addEventListener('rr-pointer-up', () => { ups += 1; });
      el.addEventListener('rr-pointer-cancel', () => { cancels += 1; });

      press('pointerdown', 140, 110);
      press('pointercancel', 240, 110);

      expect(ups).to.equal(0);
      expect(cancels).to.equal(1);
    });

    it('captures the pointer on down and releases it on up', () => {
      press('pointerdown', 140, 110, 9);
      expect(calls(svg.setPointerCapture)).to.deep.equal([[9]]);

      press('pointerup', 240, 110, 9);
      expect(calls(svg.releasePointerCapture)).to.deep.equal([[9]]);
    });

    it('does not release a capture it never took', () => {
      // Releasing an unheld capture throws in a real browser, and a throw here
      // would land ahead of nothing useful — the up event is already out.
      press('pointerup', 240, 110, 9);
      expect(calls(svg.releasePointerCapture)).to.deep.equal([]);
    });

    it('releases the pointer when the gesture is cancelled', () => {
      press('pointerdown', 140, 110, 9);
      press('pointercancel', 140, 110, 9);
      expect(calls(svg.releasePointerCapture)).to.deep.equal([[9]]);
    });

    it('reports a right-click without suppressing the native menu', () => {
      // Whether the browser menu is suppressed depends on editor state — a
      // right-click ends a chain in one state and opens a menu in another — so
      // the decision belongs to the consumer, not the viewer.
      const seen: ViewerContextMenuDetail[] = [];
      el.addEventListener('rr-pointer-contextmenu', e => {
        seen.push(e.detail);
      });
      const event = new MouseEvent('contextmenu', { clientX: 140, clientY: 110, bubbles: true, cancelable: true });
      svg.dispatchEvent(event);

      expect(seen.length).to.equal(1);
      expect(seen[0].point).to.deep.equal({ x: 200, y: 200 });
      expect(event.defaultPrevented).to.be.false;
    });

    it('bubbles out of the shadow root', async () => {
      const host = await fixture<HTMLDivElement>(html`
        <div><rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer></div>
      `);
      const viewer = host.querySelector('rr-viewer')!;
      const inner = viewer.shadowRoot!.querySelector('svg')!;
      stubSvgGeometry(inner, { scale: 1 });

      let seen = 0;
      host.addEventListener('rr-pointer-down', () => { seen += 1; });
      inner.dispatchEvent(new FakePointerEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }));

      expect(seen).to.equal(1);
    });

    it('emits nothing when the SVG has no transform to convert with', async () => {
      // jsdom implements no SVG geometry, and neither does a detached element.
      // Emitting a coordinate derived from a missing CTM would be worse than
      // emitting none.
      const bare = await fixture<RrViewer>(html`
        <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
      `);
      const bareSvg = bare.shadowRoot!.querySelector('svg')!;

      let seen = 0;
      bare.addEventListener('rr-pointer-down', () => { seen += 1; });
      bareSvg.dispatchEvent(new FakePointerEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }));

      expect(seen).to.equal(0);
    });

    it('reports in stream mode too, from the same transform', async () => {
      const live = await fixture<RrViewer>(html`
        <rr-viewer .stream=${{} as MediaStream} .resolution=${resolution}></rr-viewer>
      `);
      const liveSvg = live.shadowRoot!.querySelector('svg')!;
      stubSvgGeometry(liveSvg, { scale: 0.5, offsetX: 40, offsetY: 10 });

      const seen: ViewerPointerDetail[] = [];
      live.addEventListener('rr-pointer-down', e => {
        seen.push(e.detail);
      });
      liveSvg.dispatchEvent(new FakePointerEvent('pointerdown', { clientX: 140, clientY: 110, bubbles: true }));

      expect(seen.length).to.equal(1);
      expect(seen[0].point).to.deep.equal({ x: 200, y: 200 });
    });
  });
});

describe('rr-viewer zoom (#44)', () => {
  const resolution = { width: 1000, height: 1000 };

  /** Give the viewport a laid-out size, which jsdom never does on its own. */
  function stubViewport(el: RrViewer, size: { width: number; height: number }) {
    const viewport = el.shadowRoot!.querySelector('.viewport') as HTMLElement;
    viewport.getBoundingClientRect = () =>
      ({ width: size.width, height: size.height, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;
  }

  /** The measurement the ResizeObserver would drive in a browser. */
  const measure = (el: RrViewer) => (el as unknown as { measureScale(): void }).measureScale();

  const layer = (el: RrViewer) => el.shadowRoot!.querySelector('.zoom-layer') as HTMLElement;
  const zoomVar = (el: RrViewer, name: string) => layer(el).style.getPropertyValue(name).trim();

  it('carries the media and the overlay in one transformed layer', async () => {
    // The load-bearing part of the mechanism (#41 under #44): a transform above
    // *both* keeps them one box by construction. Two transforms kept in sync
    // would be the two-independently-fitted-boxes bug again.
    const el = await fixture<RrViewer>(html`
      <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
    `);
    expect(layer(el).querySelector('img')).to.exist;
    expect(layer(el).querySelector('svg')).to.exist;
  });

  it('is the identity when nothing is zoomed', async () => {
    const el = await fixture<RrViewer>(html`
      <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
    `);
    stubViewport(el, { width: 800, height: 800 });
    measure(el);
    await el.updateComplete;

    expect(zoomVar(el, '--zoom-scale')).to.equal('1');
    expect(zoomVar(el, '--zoom-x')).to.equal('0px');
    expect(zoomVar(el, '--zoom-y')).to.equal('0px');
  });

  it('applies the transform for a zoom rect', async () => {
    // What jsdom can honestly show: the property the element computes and
    // writes. **Not** that the photograph moved — nothing here lays out or
    // paints, and the arithmetic itself is covered in geometry.test.ts.
    const el = await fixture<RrViewer>(html`
      <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
    `);
    stubViewport(el, { width: 800, height: 800 });
    measure(el);
    el.zoom = { x: 0, y: 0, width: 500, height: 500 };
    await el.updateComplete;

    expect(zoomVar(el, '--zoom-scale')).to.equal('2');
    expect(zoomVar(el, '--zoom-x')).to.equal('0px');
    expect(zoomVar(el, '--zoom-y')).to.equal('0px');
  });

  it('reports the viewport size, and only when it changes', async () => {
    const el = await fixture<RrViewer>(html`
      <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
    `);
    const seen: { width: number; height: number }[] = [];
    el.addEventListener('rr-viewport', e => void seen.push(e.detail));

    stubViewport(el, { width: 800, height: 600 });
    measure(el);
    measure(el);
    expect(seen).to.deep.equal([{ width: 800, height: 600 }]);

    stubViewport(el, { width: 400, height: 300 });
    measure(el);
    expect(seen.length).to.equal(2);
  });

  it('re-measures the scale when the zoom changes', async () => {
    // No ResizeObserver fires for a zoom — the element does not resize — and
    // every screen-constant symbol is sized off the transform it moves.
    const el = await fixture<RrViewer>(html`
      <rr-viewer src="test.jpg" .resolution=${resolution}></rr-viewer>
    `);
    const spy = vi.fn();
    (el as unknown as { measureScale(): void }).measureScale = spy;

    el.zoom = { x: 0, y: 0, width: 100, height: 100 };
    await el.updateComplete;
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));

    expect(spy.mock.calls.length).to.be.greaterThan(0);
  });

  it('draws the band in flight, with a screen-constant stroke', async () => {
    const el = await fixture<RrViewer>(html`
      <rr-viewer .resolution=${resolution}></rr-viewer>
    `);
    el.zoomPreview = { x: 10, y: 20, width: 300, height: 400 };
    await el.updateComplete;

    const band = () => el.shadowRoot!.querySelector('.zoom-band')!;
    expect(band().getAttribute('x')).to.equal('10');
    expect(band().getAttribute('width')).to.equal('300');
    expect(band().getAttribute('height')).to.equal('400');

    // Same rule as every other annotation: the stroke is in image pixels, and
    // its size *on screen* is the same number at any scale.
    const svg = el.shadowRoot!.querySelector('svg')!;
    const strokeOnScreen = (scale: number) => {
      stubSvgGeometry(svg, { scale });
      measure(el);
      return el.updateComplete.then(
        () => Number(band().getAttribute('stroke-width')) * scale
      );
    };
    const small = await strokeOnScreen(0.5);
    const large = await strokeOnScreen(4);
    expect(small).to.be.closeTo(large, 1e-9);
    expect(small).to.be.greaterThan(0);
  });

  it('draws no band when no rect is in flight', async () => {
    const el = await fixture<RrViewer>(html`
      <rr-viewer .resolution=${resolution}></rr-viewer>
    `);
    expect(el.shadowRoot!.querySelector('.zoom-band')).to.not.exist;
  });
});
