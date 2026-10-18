import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import type { Sensor } from '@rails49/r49';
import type { SensorState, UnknownReason } from '@occupancy/detector';
import { renderSensor, sensorLabelText, sensorMarkerStyles } from '../src/sensorMarker.js';
import { renderCalibrationPoint } from '../src/calibrationMarker.js';
import { HIGHLIGHT_CLASS } from '../src/highlight.js';

/** Render a lit SVGTemplateResult into a detached <svg> and return it. */
function renderSvg(template: ReturnType<typeof svg>): SVGElement {
  const container = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  render(template, container);
  return container;
}

const sensor = (over: Partial<Sensor> = {}): Sensor => ({
  id: 'S1abcdefghi',
  x: 100,
  y: 200,
  ...over,
});

/** Big enough that the fixture sensor at (100, 200) is nowhere near an edge. */
const frame = { width: 1920, height: 1080 };

/**
 * A diamond `diameter` image pixels across, labelled at a fixed screen size.
 *
 * The two are independent by design — the diamond is a track width and shrinks
 * with the photograph, the label is annotation and does not — so the default
 * here holds the label still while a test varies the diameter.
 */
const size = (diameterPx: number, labelPx = 16) => ({ diameterPx, labelPx });

describe('sensorLabelText()', () => {
  it('shows the name when there is one', () => {
    expect(sensorLabelText(sensor({ name: 'Yard throat' }))).toBe('Yard throat');
  });

  it('falls back to the id, which is what consumers key on', () => {
    // Never an auto-generated "Sensor 3": it would be indistinguishable from a
    // name a human chose, and stops matching as sensors are added and removed.
    expect(sensorLabelText(sensor())).toBe('S1abcdefghi');
  });

  it('treats a blank name as no name', () => {
    expect(sensorLabelText(sensor({ name: '   ' }))).toBe('S1abcdefghi');
  });
});

describe('renderSensor()', () => {
  it('draws a diamond centered on the image pixel', () => {
    const el = renderSvg(renderSensor(sensor(), size(40), frame));
    const points = el
      .querySelector('polygon')!
      .getAttribute('points')!
      .split(' ')
      .map(pair => pair.split(',').map(Number));

    expect(points).toEqual([
      [100, 180],
      [120, 200],
      [100, 220],
      [80, 200],
    ]);
  });

  it('marks the exact pixel with a filled core', () => {
    const el = renderSvg(renderSensor(sensor(), size(40), frame));
    const circle = el.querySelector('circle')!;
    expect(Number(circle.getAttribute('cx'))).toBe(100);
    expect(Number(circle.getAttribute('cy'))).toBe(200);
  });

  it('is a different shape from the calibration crosshair', () => {
    // `SPEC.md` § Reference points: a calibration point must be unmistakable
    // from a sensor. Shape, not just colour — the two never share an element.
    const sensorEl = renderSvg(renderSensor(sensor(), size(40), frame));
    const calibrationEl = renderSvg(
      renderCalibrationPoint({ px: { x: 100, y: 200 }, world: { x: 0, y: 0, z: 0 } }, 0, 40, frame)
    );

    expect(sensorEl.querySelector('polygon')).to.exist;
    expect(sensorEl.querySelector('line')).to.be.null;
    expect(calibrationEl.querySelector('polygon')).to.be.null;
    expect(calibrationEl.querySelectorAll('line')).toHaveLength(2);
  });

  it('spans exactly the diameter it is given, which is one track width', () => {
    const spanOf = (el: SVGElement) => {
      const xs = el
        .querySelector('polygon')!
        .getAttribute('points')!
        .split(' ')
        .map(pair => Number(pair.split(',')[0]));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spanOf(renderSvg(renderSensor(sensor(), size(40), frame)))).toBe(40);
    expect(spanOf(renderSvg(renderSensor(sensor(), size(18), frame)))).toBe(18);
  });

  it('sizes the label independently of the diamond', () => {
    // The diamond is a world size and the label is a screen size: a sensor on a
    // distant track shrinks, its name does not.
    const wide = renderSvg(renderSensor(sensor(), size(120, 16), frame));
    const narrow = renderSvg(renderSensor(sensor(), size(18, 16), frame));

    expect(Number(wide.querySelector('text')!.getAttribute('font-size'))).toBe(16);
    expect(Number(narrow.querySelector('text')!.getAttribute('font-size'))).toBe(16);
  });

  it('keeps the core visible when the track is only a few pixels across', () => {
    // At DPT 18 the diamond is 18 px wide and 12% of it is barely a pixel; the
    // dot names the pixel the sensor *is*, so it has a floor.
    const tiny = renderSvg(renderSensor(sensor(), size(4), frame));
    expect(Number(tiny.querySelector('circle')!.getAttribute('r'))).toBeGreaterThanOrEqual(1.5);

    // Above the floor it is still a fraction of the diamond.
    const large = renderSvg(renderSensor(sensor(), size(100), frame));
    expect(Number(large.querySelector('circle')!.getAttribute('r'))).toBe(12);
  });

  it('carries its id, which is the handle every gesture refers to', () => {
    const el = renderSvg(renderSensor(sensor(), size(40), frame));
    expect(el.querySelector('[data-sensor-id]')!.getAttribute('data-sensor-id')).toBe('S1abcdefghi');
  });

  it('carries the highlight class when a reveal points at it', () => {
    const lit = renderSvg(renderSensor(sensor(), size(40), frame, true));
    const plain = renderSvg(renderSensor(sensor(), size(40), frame));

    expect(lit.querySelector('g')!.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(plain.querySelector('g')!.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it('labels the sensor with its name, or its id when unnamed', () => {
    expect(
      renderSvg(renderSensor(sensor({ name: 'Yard throat' }), size(40), frame)).querySelector('text')!
        .textContent
    ).toContain('Yard throat');
    expect(
      renderSvg(renderSensor(sensor(), size(40), frame)).querySelector('text')!.textContent
    ).toContain('S1abcdefghi');
  });

  describe('label placement against the frame edges', () => {
    // As with the crosshair: jsdom neither lays out nor paints, so these assert
    // the attributes the flip produces, never that the label is visibly inside.
    const textOf = (el: SVGElement) => el.querySelector('text')!;

    it('draws up and to the right of a sensor well inside the frame', () => {
      const text = textOf(renderSvg(renderSensor(sensor(), size(40), frame)));
      expect(text.getAttribute('text-anchor')).toBe('start');
      expect(text.getAttribute('dominant-baseline')).toBe('text-after-edge');
      expect(Number(text.getAttribute('x'))).toBeGreaterThan(100);
      expect(Number(text.getAttribute('y'))).toBeLessThan(200);
    });

    it('flips the label inwards at the right and top edges', () => {
      const right = textOf(
        renderSvg(renderSensor(sensor({ x: frame.width - 30, y: 500 }), size(40), frame))
      );
      expect(right.getAttribute('text-anchor')).toBe('end');

      const top = textOf(renderSvg(renderSensor(sensor({ x: 500, y: 4 }), size(40), frame)));
      expect(top.getAttribute('dominant-baseline')).toBe('text-before-edge');
    });

    it('leaves the diamond itself untouched by the flip', () => {
      const el = renderSvg(renderSensor(sensor({ x: frame.width - 5, y: 5 }), size(40), frame));
      expect(Number(el.querySelector('circle')!.getAttribute('cx'))).toBe(frame.width - 5);
      expect(Number(el.querySelector('circle')!.getAttribute('cy'))).toBe(5);
    });
  });
});

describe('renderSensor() — L1 state (#85)', () => {
  const detection = {
    centre: { x: 100, y: 200 },
    length: 200,
    width: 42,
    angle: 0,
    class: 'stock',
    confidence: 0.91,
  };

  it('states nothing when nothing is reading the sensor', () => {
    // The editor. A sensor being placed is not a sensor being answered, and the
    // symbol keeps its authored amber.
    const el = renderSvg(renderSensor(sensor(), size(40), frame));
    expect(el.querySelector('.sensor')!.getAttribute('data-state')).toBe('');
    expect(el.querySelector('title')).toBeNull();
  });

  it('carries the state as an attribute the stylesheet recolours on', () => {
    for (const state of ['occupied', 'clear', 'unknown'] as const) {
      const value: SensorState =
        state === 'occupied'
          ? { state, detection }
          : state === 'clear'
            ? { state }
            : { state, reason: 'no-model' };
      const el = renderSvg(renderSensor(sensor(), size(40), frame, false, value));
      expect(el.querySelector('.sensor')!.getAttribute('data-state')).toBe(state);
    }
  });

  it('keeps the diamond whatever the state — shape is identity, colour is state', () => {
    const occupied = renderSvg(
      renderSensor(sensor(), size(40), frame, false, { state: 'occupied', detection })
    );
    const clear = renderSvg(renderSensor(sensor(), size(40), frame, false, { state: 'clear' }));

    expect(occupied.querySelector('polygon')!.getAttribute('points')).toBe(
      clear.querySelector('polygon')!.getAttribute('points')
    );
  });

  it('names the covering detection\'s confidence when occupied', () => {
    const el = renderSvg(
      renderSensor(sensor(), size(40), frame, false, { state: 'occupied', detection })
    );
    expect(el.querySelector('title')!.textContent).toContain('91%');
  });

  it('gives clear no confidence at all', () => {
    // SPEC § Confidence: `clear` is the absence of evidence and nothing scored
    // it. A number here — 0% or 100% — would be the confident-looking miss the
    // encoding exists to prevent.
    const el = renderSvg(renderSensor(sensor(), size(40), frame, false, { state: 'clear' }));
    expect(el.querySelector('title')!.textContent).toBe('clear');
    expect(el.querySelector('title')!.textContent).not.toMatch(/\d/);
  });

  it('says why it could not answer, which the colour cannot', () => {
    const reasons: Record<UnknownReason, RegExp> = {
      'no-model': /no model/i,
      'no-calibration': /calibration/i,
      'outside-frame': /frame/i,
      drift: /drift/i,
    };
    for (const [reason, pattern] of Object.entries(reasons) as [UnknownReason, RegExp][]) {
      const el = renderSvg(renderSensor(sensor(), size(40), frame, false, { state: 'unknown', reason }));
      expect(el.querySelector('title')!.textContent, reason).toMatch(pattern);
    }
  });
});

describe('sensorMarkerStyles', () => {
  it('recolours the whole symbol per state, through the one ink literal', () => {
    for (const state of ['occupied', 'clear', 'unknown']) {
      expect(sensorMarkerStyles.cssText).toContain(`[data-state='${state}']`);
    }
    // The fill follows the ink rather than repeating a colour: a literal here
    // would leave an occupied sensor outlined red and washed amber.
    expect(sensorMarkerStyles.cssText).toContain('fill: var(--sensor-ink)');
  });

  it('carries the sensor rules, so the host cannot render an unstyled one', () => {
    expect(sensorMarkerStyles.cssText).toContain('.sensor');
  });

  it('does not pin the baseline in CSS, which would beat the flipped attribute', () => {
    expect(sensorMarkerStyles.cssText).not.toContain('dominant-baseline:');
    expect(sensorMarkerStyles.cssText).not.toContain('text-anchor:');
  });
});
