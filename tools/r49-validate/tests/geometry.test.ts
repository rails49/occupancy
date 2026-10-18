import { describe, it, expect } from 'vitest';
import { obliquityOf } from '../src/geometry.ts';
import type { ManifestData } from '@occupancy/r49';

/** A manifest carrying only what obliquityOf reads. */
function manifest(calibration: Record<string, unknown>): ManifestData {
  return {
    version: 4,
    layout: { name: 'Test', scale: 'HO', calibration, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
  } as unknown as ManifestData;
}

/** The corners of a 2 x 1 m layout, the case worked through in SPEC. */
const CORNERS = [
  { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
  { px: { x: 1000, y: 500 }, world: { x: 2000, y: 1000, z: 0 } },
];

describe('obliquityOf', () => {
  it('reproduces the 2x1 m layout under a 1 m camera', () => {
    // Half-diagonal 1118 mm over 1000 mm => 48.2 degrees, and an HO car
    // presenting 2.60x its nadir width. These are SPEC's published numbers.
    const o = obliquityOf(manifest({ points: CORNERS, camera_height_mm: 1000 }))!;
    expect(o.degrees).toBeCloseTo(48.2, 1);
    expect(o.widthInflation).toBeCloseTo(2.6, 1);
  });

  it('falls with mount height, which is the only lever', () => {
    const at = (h: number) => obliquityOf(manifest({ points: CORNERS, camera_height_mm: h }))!;
    expect(at(2000).widthInflation).toBeCloseTo(1.8, 1);
    expect(at(3000).widthInflation).toBeCloseTo(1.53, 1);
    // Monotone: focal length cancels, so height is the whole story.
    expect(at(3000).degrees).toBeLessThan(at(2000).degrees);
    expect(at(2000).degrees).toBeLessThan(at(1000).degrees);
  });

  it('is scale-independent, because the car ratio is', () => {
    // The same geometry in N reports the same inflation: a prototype car's
    // height over its width survives the scale ratio, so one constant serves
    // every scale.
    const inScale = (scale: string) => {
      const m = manifest({ points: CORNERS, camera_height_mm: 1000 });
      return obliquityOf({ ...m, layout: { ...m.layout, scale } } as ManifestData)!;
    };
    expect(inScale('N').widthInflation).toBeCloseTo(inScale('HO').widthInflation, 12);
    expect(inScale('Z').widthInflation).toBeCloseTo(inScale('HO').widthInflation, 12);
  });

  it('cannot answer without a camera height', () => {
    expect(obliquityOf(manifest({ points: CORNERS }))).toBeNull();
  });

  it('cannot answer without an extent to measure across', () => {
    expect(obliquityOf(manifest({ points: [], camera_height_mm: 1000 }))).toBeNull();
    expect(obliquityOf(manifest({ points: [CORNERS[0]], camera_height_mm: 1000 }))).toBeNull();
    // Two points at one spot give a zero half-diagonal, not a zero angle.
    expect(obliquityOf(manifest({ points: [CORNERS[0], CORNERS[0]], camera_height_mm: 1000 })))
      .toBeNull();
  });
});
