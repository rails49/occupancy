import { describe, expect, it } from 'vitest';
import { boxCorners, carWidthPx, spanToPolygon } from '../src/geometry.ts';
import type { Detection } from '../src/types.ts';

/**
 * The car rectangle. Every wrong number here is invisible until a model trains
 * badly for a reason nobody can name, or a sensor reads clear with a car
 * sitting on it — which is why these are pinned rather than eyeballed once
 * against a rendered box.
 *
 * The `spanToPolygon` cases came with the function from `dataset/tests`, where
 * they were written for the exporter; they are the same assertions because it
 * is the same function, moved.
 */

const FRAME = { width: 1000, height: 500 };

function detection(fields: Partial<Detection>): Detection {
  return {
    centre: { x: 0, y: 0 },
    length: 100,
    width: 40,
    angle: 0,
    class: 'stock',
    confidence: 0.9,
    ...fields,
  };
}

describe('car width', () => {
  it('is 2.09 track widths, whatever the scale', () => {
    // 3000 / 1435. The scale ratio cancels out of DPT * width / gauge, so this
    // ratio is the same number in every scale — the property the format leans
    // on to avoid storing width per label.
    expect(carWidthPx(1)).toBeCloseTo(2.0906, 4);
    expect(carWidthPx(18.5) / carWidthPx(1)).toBeCloseTo(18.5, 10);
  });
});

describe('span to polygon', () => {
  it('offsets a horizontal chord by half a car in each direction', () => {
    const { corners, clamped } = spanToPolygon(
      { id: 'a', p0: { x: 100, y: 250 }, p1: { x: 300, y: 250 } },
      50,
      FRAME
    );

    expect(clamped).toBe(0);
    // Normalized: x/1000, y/500. The chord runs along +x, so the normal is
    // along y and the corners sit at 250 ± 25 px = 0.55 / 0.45. They come out
    // walking the perimeter — p0+n, p1+n, p1-n, p0-n — not as two pairs.
    expect([...corners]).toEqual([0.1, 0.55, 0.3, 0.55, 0.3, 0.45, 0.1, 0.45]);
  });

  it('rotates the offset with the chord', () => {
    // A vertical chord: the normal now runs along x.
    const { corners } = spanToPolygon(
      { id: 'a', p0: { x: 500, y: 100 }, p1: { x: 500, y: 300 } },
      100,
      FRAME
    );

    expect([...corners]).toEqual([0.45, 0.2, 0.45, 0.6, 0.55, 0.6, 0.55, 0.2]);
  });

  it('keeps the box the length of the chord, not longer', () => {
    const { corners } = spanToPolygon(
      { id: 'a', p0: { x: 200, y: 100 }, p1: { x: 600, y: 400 } },
      40,
      FRAME
    );

    // Corner 0 and corner 3 straddle p0; their midpoint must be p0 itself.
    expect((corners[0] + corners[6]) / 2).toBeCloseTo(0.2, 10);
    expect((corners[1] + corners[7]) / 2).toBeCloseTo(0.2, 10);
    // Likewise corners 1 and 2 straddle p1.
    expect((corners[2] + corners[4]) / 2).toBeCloseTo(0.6, 10);
    expect((corners[3] + corners[5]) / 2).toBeCloseTo(0.8, 10);
  });

  it('clamps a car at the frame edge and says how many corners moved', () => {
    const { corners, clamped } = spanToPolygon(
      { id: 'a', p0: { x: 10, y: 4 }, p1: { x: 300, y: 4 } },
      40,
      FRAME
    );

    // y = 4 ± 20 px, so the two corners on the -n side land at -16 px and are
    // pulled to 0. They are the last two in perimeter order.
    expect(clamped).toBe(2);
    expect(corners.every(c => c >= 0 && c <= 1)).toBe(true);
    expect(corners[5]).toBe(0);
    expect(corners[7]).toBe(0);
  });

  it('refuses a zero-length span rather than inventing an orientation', () => {
    expect(() =>
      spanToPolygon({ id: 'squashed', p0: { x: 5, y: 5 }, p1: { x: 5, y: 5 } }, 40, FRAME)
    ).toThrow(/squashed/);
  });
});

describe('box corners', () => {
  it('walks the perimeter in the same order a span does', () => {
    const corners = boxCorners(
      detection({ centre: { x: 200, y: 250 }, length: 200, width: 50, angle: 0 })
    );

    // The same rectangle the first spanToPolygon case draws, in pixels rather
    // than normalized: p0 = (100, 250), p1 = (300, 250), half-width 25.
    expect(corners.map(c => [c.x, c.y])).toEqual([
      [100, 275],
      [300, 275],
      [300, 225],
      [100, 225],
    ]);
  });

  it('is the inverse of a span, for a rotated car', () => {
    const p0 = { x: 200, y: 100 };
    const p1 = { x: 600, y: 400 };
    const width = 40;

    const fromDetection = boxCorners(
      detection({
        centre: { x: 400, y: 250 },
        length: Math.hypot(400, 300),
        width,
        angle: Math.atan2(300, 400),
      })
    );

    // spanToPolygon normalizes; undo that to compare the same quantities.
    const { corners } = spanToPolygon({ id: 'a', p0, p1 }, width, FRAME);
    const fromSpan = [0, 2, 4, 6].map(i => ({
      x: corners[i] * FRAME.width,
      y: corners[i + 1] * FRAME.height,
    }));

    fromDetection.forEach((corner, i) => {
      expect(corner.x).toBeCloseTo(fromSpan[i].x, 9);
      expect(corner.y).toBeCloseTo(fromSpan[i].y, 9);
    });
  });

  it('draws the raw predicted width, not a normalized one', () => {
    // L0 stays raw: a drawn box is what the model said, however wrong.
    const corners = boxCorners(
      detection({ centre: { x: 0, y: 0 }, length: 100, width: 7, angle: 0 })
    );
    expect(corners[0].y - corners[3].y).toBe(7);
  });
});
