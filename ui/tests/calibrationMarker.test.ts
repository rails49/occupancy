import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import type { ReferencePoint } from '@rails49/r49';
import {
  renderCalibrationPoint,
  calibrationMarkerStyles,
} from '../src/calibrationMarker.js';
import { HIGHLIGHT_CLASS } from '../src/highlight.js';

/** Render a lit SVGTemplateResult into a detached <svg> and return it. */
function renderSvg(template: ReturnType<typeof svg>): SVGElement {
  const container = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  render(template, container);
  return container;
}

const point = (over: Partial<ReferencePoint> = {}): ReferencePoint => ({
  px: { x: 100, y: 200 },
  world: { x: 0, y: 250, z: 0 },
  ...over,
});

/** Big enough that the fixture point at (100, 200) is nowhere near an edge. */
const frame = { width: 1920, height: 1080 };

describe('calibrationMarkerStyles', () => {
  it('carries the crosshair rules, so the host cannot render an unstyled one', () => {
    expect(calibrationMarkerStyles.cssText).toContain('calibration-point');
  });
});

describe('renderCalibrationPoint()', () => {
  it('draws a crosshair centered on the image pixel', () => {
    const el = renderSvg(renderCalibrationPoint(point(), 0, 40, frame));
    const lines = [...el.querySelectorAll('line')];
    expect(lines).toHaveLength(2);

    const [horizontal, vertical] = lines;
    // Both arms are centered on (100, 200) and span the full symbol size.
    expect(Number(horizontal.getAttribute('x1')) + Number(horizontal.getAttribute('x2'))).toBe(200);
    expect(Number(horizontal.getAttribute('y1'))).toBe(200);
    expect(Number(horizontal.getAttribute('y2'))).toBe(200);
    expect(Number(horizontal.getAttribute('x2')) - Number(horizontal.getAttribute('x1'))).toBe(40);

    expect(Number(vertical.getAttribute('y1')) + Number(vertical.getAttribute('y2'))).toBe(400);
    expect(Number(vertical.getAttribute('x1'))).toBe(100);
    expect(Number(vertical.getAttribute('y2')) - Number(vertical.getAttribute('y1'))).toBe(40);
  });

  it('labels the point with its world coordinate in millimetres', () => {
    const el = renderSvg(renderCalibrationPoint(point(), 0, 40, frame));
    expect(el.querySelector('text')!.textContent).toContain('0, 250, 0');
    expect(el.querySelector('text')!.textContent).toContain('mm');
  });

  it('rounds a fractional coordinate rather than printing float noise', () => {
    const el = renderSvg(
      renderCalibrationPoint(point({ world: { x: 0.1 + 0.2, y: -12.26, z: 3 } }), 0, 40, frame)
    );
    expect(el.querySelector('text')!.textContent).toContain('0.3, -12.3, 3');
  });

  it('scales with the symbol size, so the crosshair is constant on screen', () => {
    const small = renderSvg(renderCalibrationPoint(point(), 0, 20, frame));
    const large = renderSvg(renderCalibrationPoint(point(), 0, 80, frame));
    const armOf = (el: SVGElement) => {
      const line = el.querySelector('line')!;
      return Number(line.getAttribute('x2')) - Number(line.getAttribute('x1'));
    };
    expect(armOf(large)).toBe(armOf(small) * 4);
    expect(Number(large.querySelector('text')!.getAttribute('font-size'))).toBeGreaterThan(
      Number(small.querySelector('text')!.getAttribute('font-size'))
    );
  });

  it('carries its index, which is the only handle a point has', () => {
    // Calibration points have no id — nothing references one individually —
    // so position in the list is what an editor gesture refers to.
    const el = renderSvg(renderCalibrationPoint(point(), 3, 40, frame));
    expect(el.querySelector('[data-calibration-index]')!.getAttribute('data-calibration-index')).toBe('3');
  });

  it('carries the highlight class when a reveal points at it', () => {
    const lit = renderSvg(renderCalibrationPoint(point(), 0, 40, frame, true));
    const plain = renderSvg(renderCalibrationPoint(point(), 0, 40, frame));

    expect(lit.querySelector('g')!.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(plain.querySelector('g')!.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  describe('label placement against the frame edges', () => {
    // What these assert is the *attributes* the flip produces. jsdom neither
    // lays out nor paints, so nothing here can claim the label is visibly
    // inside the frame — only that the geometric rule was applied.
    const textOf = (el: SVGElement) => el.querySelector('text')!;

    it('draws up and to the right of a point well inside the frame', () => {
      const text = textOf(renderSvg(renderCalibrationPoint(point(), 0, 40, frame)));
      expect(text.getAttribute('text-anchor')).toBe('start');
      expect(text.getAttribute('dominant-baseline')).toBe('text-after-edge');
      expect(Number(text.getAttribute('x'))).toBeGreaterThan(100);
      expect(Number(text.getAttribute('y'))).toBeLessThan(200);
    });

    it('draws the label to the left of a point near the right edge', () => {
      const near = point({ px: { x: frame.width - 30, y: 500 } });
      const text = textOf(renderSvg(renderCalibrationPoint(near, 0, 40, frame)));
      expect(text.getAttribute('text-anchor')).toBe('end');
      expect(Number(text.getAttribute('x'))).toBeLessThan(frame.width - 30);
    });

    it('draws the label below a point near the top edge', () => {
      const near = point({ px: { x: 500, y: 4 } });
      const text = textOf(renderSvg(renderCalibrationPoint(near, 0, 40, frame)));
      expect(text.getAttribute('dominant-baseline')).toBe('text-before-edge');
      expect(Number(text.getAttribute('y'))).toBeGreaterThan(4);
    });

    it('leaves the crosshair itself untouched by the flip', () => {
      // Only the label moves — the symbol still names its exact pixel, and a
      // point on the edge would otherwise stop marking what it calibrates.
      const near = point({ px: { x: frame.width - 5, y: 5 } });
      const el = renderSvg(renderCalibrationPoint(near, 0, 40, frame));
      const [horizontal] = [...el.querySelectorAll('line')];
      expect(Number(horizontal.getAttribute('y1'))).toBe(5);
      expect(Number(el.querySelector('circle')!.getAttribute('cx'))).toBe(frame.width - 5);
    });

    it('flips on the label estimate, so a longer coordinate flips sooner', () => {
      const px = { x: frame.width - 130, y: 500 };
      const short = renderSvg(
        renderCalibrationPoint(point({ px, world: { x: 0, y: 0, z: 0 } }), 0, 40, frame)
      );
      const long = renderSvg(
        renderCalibrationPoint(
          point({ px, world: { x: -1234.5, y: -1234.5, z: -1234.5 } }),
          0,
          40,
          frame
        )
      );
      expect(textOf(short).getAttribute('text-anchor')).toBe('start');
      expect(textOf(long).getAttribute('text-anchor')).toBe('end');
    });
  });
});

describe('calibrationMarkerStyles and the flip', () => {
  it('does not pin the baseline in CSS, which would beat the flipped attribute', () => {
    // A presentation attribute loses to any stylesheet rule, so the baseline
    // has to be set per element for the top-edge flip to take effect at all.
    // Matched as a declaration — the stylesheet's comment names the property
    // precisely to say it is absent on purpose.
    expect(calibrationMarkerStyles.cssText).not.toContain('dominant-baseline:');
    expect(calibrationMarkerStyles.cssText).not.toContain('text-anchor:');
  });
});
