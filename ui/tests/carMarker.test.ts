import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import type { CarLabel } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import {
  renderCar,
  renderCoupler,
  renderDetection,
  renderPendingCar,
  carMarkerStyles,
} from '../src/carMarker.js';
import { carWidthPx } from '../src/geometry.js';
import { HIGHLIGHT_CLASS } from '../src/highlight.js';

/** Render a lit SVGTemplateResult into a detached <svg> and return it. */
function renderSvg(template: ReturnType<typeof svg>): SVGElement {
  const container = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  render(template, container);
  return container;
}

/** A hand-drawn car — the only kind this editor authors. */
type HumanCar = Extract<CarLabel, { provenance: 'human' }>;

const car = (over: Partial<HumanCar> = {}): HumanCar => ({
  id: 'C1abcdefghi',
  class: 'stock',
  provenance: 'human',
  p0: { x: 100, y: 200 },
  p1: { x: 300, y: 200 },
  ...over,
});

/** A calibrated symbol: DPT 90, handles and labels at a fixed screen size. */
const size = (dpt: number | null, handlePx = 12, labelPx = 14) => ({ dpt, handlePx, labelPx });

/** The polygon's points, as `[x, y]` pairs. */
function polygonPoints(el: SVGElement): number[][] {
  return el
    .querySelector('polygon')!
    .getAttribute('points')!
    .split(' ')
    .map(pair => pair.split(',').map(Number));
}

describe('renderCar()', () => {
  it('draws the chord between the two clicked ends', () => {
    const el = renderSvg(renderCar(car(), size(90)));
    const line = el.querySelector('line')!;

    expect(line.getAttribute('x1')).toBe('100');
    expect(line.getAttribute('y1')).toBe('200');
    expect(line.getAttribute('x2')).toBe('300');
    expect(line.getAttribute('y2')).toBe('200');
  });

  it('draws the width rectangle, one car width across', () => {
    // The rectangle is the whole point of the calibration gate: it is what
    // tells the user whether the label covers the car.
    const el = renderSvg(renderCar(car(), size(90)));
    const ys = polygonPoints(el).map(([, y]) => y);

    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(carWidthPx(90), 6);
  });

  it('sizes the rectangle from DPT, so it shrinks with the photograph', () => {
    // Width is derived, never stored — 2.09 track widths in every scale.
    const wide = renderSvg(renderCar(car(), size(90)));
    const narrow = renderSvg(renderCar(car(), size(20)));

    const spread = (el: SVGElement) => {
      const ys = polygonPoints(el).map(([, y]) => y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread(wide) / spread(narrow)).toBeCloseTo(90 / 20, 6);
  });

  it('orients the rectangle along the span', () => {
    // A diagonal car: the offset is perpendicular to the chord, so neither the
    // x nor the y extent alone is the car width.
    const el = renderSvg(renderCar(car({ p1: { x: 200, y: 300 } }), size(90)));
    const [a, b] = polygonPoints(el);

    // The p0-side and p1-side corners are one span apart, unchanged by the
    // offset, which is what makes the shape a rectangle rather than a wedge.
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(Math.hypot(100, 100), 6);
  });

  it('draws a handle at each end, at the screen-constant size', () => {
    const el = renderSvg(renderCar(car(), size(90, 12)));
    const handles = [...el.querySelectorAll('circle')];

    expect(handles).toHaveLength(2);
    expect(handles.map(h => [h.getAttribute('cx'), h.getAttribute('cy')])).toEqual([
      ['100', '200'],
      ['300', '200'],
    ]);
    // A handle is annotation, not a measurement: it is where the user grabs.
    expect(Number(handles[0].getAttribute('r'))).toBeCloseTo(6, 6);
  });

  it('drops the rectangle, not the car, when no DPT resolves', () => {
    // A calibration point can be deleted at any time, and the cars already
    // labelled must stay visible and grabbable — there is simply no width to
    // draw, since width is derived from DPT rather than stored.
    const el = renderSvg(renderCar(car(), size(null)));

    expect(el.querySelector('polygon')).toBeNull();
    expect(el.querySelector('line')).not.toBeNull();
    expect(el.querySelectorAll('circle')).toHaveLength(2);
  });

  it('keys the group on the label id, never on position', () => {
    const el = renderSvg(renderCar(car(), size(90)));
    expect(el.querySelector('g')!.getAttribute('data-label-id')).toBe('C1abcdefghi');
  });

  it('carries the highlight class when a reveal points at it', () => {
    // What an undo lights up so the user can see which object it touched
    // (#37). It rides on the same group as the class warning, so one object is
    // one element however many things are being said about it.
    const lit = renderSvg(renderCar(car(), size(90), undefined, null, true));
    const plain = renderSvg(renderCar(car(), size(90)));

    expect(lit.querySelector('g')!.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(plain.querySelector('g')!.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('survives a zero-length span', () => {
    // The two clicks can land on the same pixel; the axis is then genuinely
    // undefined and `carCorners` collapses the rectangle onto the point.
    const el = renderSvg(renderCar(car({ p1: { x: 100, y: 200 } }), size(90)));

    expect(polygonPoints(el)).toEqual([
      [100, 200],
      [100, 200],
      [100, 200],
      [100, 200],
    ]);
  });

  it('ships styles for what it renders', () => {
    const css = carMarkerStyles.cssText;
    expect(css).toContain('.car');
    expect(css).toContain('polygon');
  });
});

describe('renderCar() with a class the vocabulary does not name', () => {
  const frame = { width: 1920, height: 1080 };
  const warned = (over = {}) =>
    renderSvg(renderCar(car({ class: 'stock.loko', ...over }), size(90), undefined, {
      text: 'stock.loko',
      frame,
    }));

  it('says which class is wrong, rather than only that one is', () => {
    // A typo is the likely cause, and a warning that does not name the class
    // leaves the labeler hunting for it (`SPEC.md` § Format).
    expect(warned().querySelector('text')!.textContent).toContain('stock.loko');
  });

  it('marks the car itself, so the warning is findable on the image', () => {
    expect(warned().querySelector('g')!.classList.contains('unknown-class')).toBe(true);
  });

  it('still draws the car, because the archive still opens', () => {
    // `class` is not validated at parse time on purpose: a format that refused
    // to open files because someone pruned the vocabulary would punish vocabulary
    // edits. So a non-conforming label is a warning, never a hidden car.
    const el = warned();
    expect(el.querySelector('line')).not.toBeNull();
    expect(el.querySelector('polygon')).not.toBeNull();
    expect(el.querySelectorAll('circle')).toHaveLength(2);
  });

  it('flips the label inwards at the frame edge, like every other label', () => {
    const nearEdge = renderSvg(
      renderCar(car({ p0: { x: 1900, y: 1060 }, p1: { x: 1910, y: 1070 } }), size(90), undefined, {
        text: 'stock.loko',
        frame,
      })
    );
    expect(nearEdge.querySelector('text')!.getAttribute('text-anchor')).toBe('end');
  });

  it('draws no label and no mark for a class the vocabulary does name', () => {
    const el = renderSvg(renderCar(car(), size(90)));
    expect(el.querySelector('text')).toBeNull();
    expect(el.querySelector('g')!.classList.contains('unknown-class')).toBe(false);
  });

  it('refuses an ink override, because the warning is not an opinion (#87)', () => {
    // A class the vocabulary does not name is a fact about the archive. The
    // diagnostics view recolours ground truth, and if that override won here a
    // non-conforming car would lose the one signal telling the labeler to fix
    // it — replaced by a verdict about a model that was never asked.
    const el = renderSvg(
      renderCar(car(), size(90), undefined, { text: 'stock.loko', frame }, false, '#4caf50')
    );
    expect(el.querySelector('g')!.getAttribute('style')).toBe('');
    expect(el.querySelector('g')!.classList.contains('unknown-class')).toBe(true);
  });

  it('takes an ink when the class is fine, so ground truth can be drawn neutral (#87)', () => {
    const el = renderSvg(renderCar(car(), size(90), undefined, null, false, '#e8eaed'));
    expect(el.querySelector('g')!.getAttribute('style')).toBe('--car-ink:#e8eaed');
  });

  it('warns a coupled car too, where the handles are gone', () => {
    const el = renderSvg(
      renderCar(car(), size(90), { p0: true, p1: true }, { text: 'stock.loko', frame })
    );
    expect(el.querySelector('text')).not.toBeNull();
    expect(el.querySelectorAll('circle')).toHaveLength(0);
  });
});

describe('renderCar() at a coupling', () => {
  it('leaves out the handle of a coupled end, which the coupler draws instead', () => {
    // A coupling renders as **one** shared handle (`SPEC.md` § Authoring cars).
    // Two circles stacked on the same pixel would only look like one.
    const el = renderSvg(renderCar(car(), size(90, 12), { p0: false, p1: true }));
    const handles = [...el.querySelectorAll('circle')];

    expect(handles).toHaveLength(1);
    expect(handles[0].getAttribute('cx')).toBe('100');
  });

  it('draws no handle at all for a car coupled at both ends', () => {
    const el = renderSvg(renderCar(car(), size(90, 12), { p0: true, p1: true }));
    expect(el.querySelectorAll('circle')).toHaveLength(0);
    // The car itself is untouched: a middle car of a train is still a car.
    expect(el.querySelector('line')).not.toBeNull();
    expect(el.querySelector('polygon')).not.toBeNull();
  });

  it('draws both handles when nothing is coupled', () => {
    expect(renderSvg(renderCar(car(), size(90, 12))).querySelectorAll('circle')).toHaveLength(2);
  });
});

describe('renderCoupler()', () => {
  it('draws one handle on the shared pixel', () => {
    const el = renderSvg(renderCoupler({ x: 300, y: 200 }, size(90, 12)));
    const handles = [...el.querySelectorAll('circle')];

    expect(handles).toHaveLength(1);
    expect(handles[0].getAttribute('cx')).toBe('300');
    expect(handles[0].getAttribute('cy')).toBe('200');
  });

  it('is larger than a free end, because it is a joint and not an end', () => {
    const coupler = renderSvg(renderCoupler({ x: 300, y: 200 }, size(90, 12)));
    const free = renderSvg(renderCar(car(), size(90, 12)));

    const r = (el: SVGElement) => Number(el.querySelector('circle')!.getAttribute('r'));
    expect(r(coupler)).toBeGreaterThan(r(free));
  });

  it('stays a screen size, so it does not grow with the photograph', () => {
    const near = renderSvg(renderCoupler({ x: 0, y: 0 }, size(90, 24)));
    const far = renderSvg(renderCoupler({ x: 0, y: 0 }, size(20, 24)));
    const r = (el: SVGElement) => Number(el.querySelector('circle')!.getAttribute('r'));

    expect(r(near)).toBe(r(far));
  });
});

describe('renderPendingCar()', () => {
  it('draws the band from the anchor to the cursor', () => {
    const el = renderSvg(
      renderPendingCar({ anchor: { x: 100, y: 200 }, to: { x: 400, y: 260 } }, size(90))
    );
    const line = el.querySelector('line')!;

    expect([line.getAttribute('x1'), line.getAttribute('y1')]).toEqual(['100', '200']);
    expect([line.getAttribute('x2'), line.getAttribute('y2')]).toEqual(['400', '260']);
  });

  it('previews the width rectangle the car will get', () => {
    // The rectangle is the only feedback that a label covers the car, so the
    // band shows it before the click rather than after.
    const el = renderSvg(
      renderPendingCar({ anchor: { x: 100, y: 200 }, to: { x: 400, y: 200 } }, size(90))
    );
    const ys = polygonPoints(el).map(([, y]) => y);

    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(carWidthPx(90), 6);
  });

  it('shows the anchor alone before the pointer has moved', () => {
    const el = renderSvg(
      renderPendingCar({ anchor: { x: 100, y: 200 }, to: { x: 100, y: 200 } }, size(90, 12))
    );

    // One handle: the anchor. The chord and the rectangle collapse onto it,
    // since a span with no length has no axis to draw along.
    expect(el.querySelectorAll('circle')).toHaveLength(1);
    expect(polygonPoints(el)).toEqual([
      [100, 200],
      [100, 200],
      [100, 200],
      [100, 200],
    ]);
  });

  it('drops the rectangle with no DPT, like a car does', () => {
    const el = renderSvg(
      renderPendingCar({ anchor: { x: 100, y: 200 }, to: { x: 400, y: 200 } }, size(null))
    );
    expect(el.querySelector('polygon')).toBeNull();
    expect(el.querySelector('line')).not.toBeNull();
  });

  it('is drawn dashed, so a band in flight is not read as a placed car', () => {
    const el = renderSvg(
      renderPendingCar({ anchor: { x: 100, y: 200 }, to: { x: 400, y: 200 } }, size(90))
    );
    expect(el.querySelector('g')!.getAttribute('class')).toContain('pending');
    expect(carMarkerStyles.cssText).toContain('stroke-dasharray');
  });
});

describe('renderDetection()', () => {
  const detection = (over: Partial<Detection> = {}): Detection => ({
    centre: { x: 200, y: 200 },
    length: 200,
    width: 42,
    angle: 0,
    class: 'stock',
    confidence: 0.9,
    ...over,
  });

  /** Big enough that a detection at (200, 200) is nowhere near an edge. */
  const frame = { width: 1920, height: 1080 };

  it("draws the model's own width, never the DPT-derived one", () => {
    // The whole reason this takes a `Detection` and not a span. L0 is the pose
    // exactly as emitted (SPEC § Occupancy Output): at DPT 90 a car is ~186 px
    // wide, and drawing that around a box the model called 42 would hide the
    // error the raw box shows. L1 substitutes the constant — in `occupancy()`,
    // where a sensor is being tested, not here where a box is being drawn.
    const el = renderSvg(renderDetection(detection(), size(90), frame));
    const ys = polygonPoints(el).map(([, y]) => y);

    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(42, 9);
    expect(carWidthPx(90)).toBeGreaterThan(100);
  });

  it('spans its length along the angle it was given', () => {
    const el = renderSvg(renderDetection(detection({ angle: Math.PI / 2 }), size(90), frame));
    const xs = polygonPoints(el).map(([x]) => x);
    const ys = polygonPoints(el).map(([, y]) => y);

    // Turned a quarter turn: the long axis is now vertical.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(200, 6);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(42, 6);
  });

  it('lands on the same rectangle an authored car of the same pose does', () => {
    // Ground truth and prediction are drawn in one picture by the archive
    // diagnostics (#87), and a perfect detection must sit exactly on its label
    // — two corner formulas that disagreed by a normal's sign or a half-width
    // would show as a permanent offset nothing could explain.
    //
    // The two are traversed in opposite orders, which is invisible on a convex
    // quad and is not asserted here; what has to match is the *set* of corners.
    const box = renderSvg(renderDetection(detection({ width: carWidthPx(90) }), size(90), frame));
    const label = renderSvg(renderCar(car({ p0: { x: 100, y: 200 }, p1: { x: 300, y: 200 } }), size(90)));

    const sorted = (el: SVGElement) =>
      polygonPoints(el)
        .map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`)
        .sort();

    expect(sorted(box)).toEqual(sorted(label));
  });

  it('labels the box with its class and confidence', () => {
    const el = renderSvg(renderDetection(detection({ confidence: 0.873 }), size(90), frame));
    expect(el.querySelector('text')!.textContent).toContain('stock');
    expect(el.querySelector('text')!.textContent).toContain('87%');
  });

  it('draws no fill by default, unlike the authored label it may sit on top of', () => {
    // The rectangle of a *label* is read against the car underneath it, which
    // is what the wash is for. A detection is not being checked by eye in the
    // live view, and a wash over every car in the frame would bury the
    // photograph. The rule is a custom property whose *fallback* is `none`, so
    // only a caller that passes an ink opts in (#87) — the default is what this
    // pins, and an override that reached the live view would fail here.
    expect(carMarkerStyles.cssText).toMatch(
      /\.detection polygon\s*\{[^}]*fill:\s*var\(--detection-fill,\s*none\)/
    );
    const plain = renderSvg(renderDetection(detection(), size(90), frame));
    expect(plain.querySelector('.detection')!.getAttribute('style')).toBe('');
  });

  it('an ink recolours the box and its wash together (#87)', () => {
    // Both custom properties or neither: moving only one leaves a coloured
    // fill inside a pink outline, or an outline with no wash to read it by.
    const el = renderSvg(renderDetection(detection(), size(90), frame, '#ffb300'));
    const style = el.querySelector('.detection')!.getAttribute('style')!;
    expect(style).toContain('--car-ink:#ffb300');
    expect(style).toContain('--detection-fill:color-mix');
  });

  it('has no id: a 300-slot buffer is re-decoded every frame', () => {
    const el = renderSvg(renderDetection(detection(), size(90), frame));
    expect(el.querySelector('.detection')!.getAttribute('data-label-id')).toBeNull();
  });
});
