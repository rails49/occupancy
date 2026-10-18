import { describe, it, expect } from 'vitest';
import type { ManifestData } from '@rails49/r49';
// Internal base class — not part of the package interface, imported directly.
import { BaseClassifier } from '../src/base.ts';

class TestClassifier extends BaseClassifier {
  async load() {}
  async classify() { return []; }

  public testScalingMath(point: {x: number, y: number}, img_dpt: number) {
    return this.getScalingMath(point, img_dpt);
  }
}

function makeManifest(overrides: Partial<ManifestData['layout']>): ManifestData {
  return {
    version: 4,
    layout: { scale: 'N', calibration: { points: [] }, sensors: [], ...overrides },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
  };
}

describe('BaseClassifier', () => {
  it('calculates DPT correctly', () => {
    const manifest = makeManifest({
      calibration: {
        points: [
          { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
          { px: { x: 100, y: 0 }, world: { x: 100, y: 0, z: 0 } },
        ],
      },
    });
    // Gauge for N is 8.96875mm. 100 pixels / 100 mm = 1 px/mm. 1 px/mm * 8.96875mm = 8.96875 DPT.
    expect(BaseClassifier.calculateDpt(manifest)).toBeCloseTo(8.96875);
  });

  it('throws when no calibration pair resolves a scale', () => {
    const manifest = makeManifest({});
    expect(() => BaseClassifier.calculateDpt(manifest)).toThrow();
  });

  it('calculates scaling math correctly', () => {
    const config = {
      dpt: 30,
      crop_size: 96,
      labels: ['coupling', 'other', 'track', 'train'],
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225]
    };
    const classifier = new TestClassifier(config);
    
    // Image is 60 DPT, so we need to crop twice as many pixels to get the same "real world" area.
    const result = classifier.testScalingMath({ x: 500, y: 500 }, 60);
    
    expect(result.cropSize).toBe(96);
    expect(result.srcSize).toBe(192); // 96 * (60/30)
    expect(result.sx).toBe(500 - 192/2);
    expect(result.sy).toBe(500 - 192/2);
  });
});
