import { describe, it, expect } from 'vitest';
import { R49Archive, calibrationFit, getDPT, getDPTResidual } from '../src/index.ts';
import type { ManifestData } from '../src/index.ts';

/**
 * The camera-height correction (#135) and the format decisions around it (#139).
 *
 * Kept out of `archive.test.ts` because it is one coherent behaviour with its
 * own arithmetic, not another pass over the archive seam — but it drives the
 * same public interface for the same reason: the schemas stay withheld, so
 * nothing here reaches for a zod object.
 */

/** HO gauge in mm: 1435 / 87. */
const HO_GAUGE = 1435 / 87;

const cal = (px: [number, number], world: [number, number, number?]) => ({
  px: { x: px[0], y: px[1] },
  world: { x: world[0], y: world[1], z: world[2] ?? 0 },
});

function manifest(calibration: Record<string, unknown>): ManifestData {
  return {
    version: 4,
    layout: { name: 'Test Layout', scale: 'HO', calibration, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
  } as unknown as ManifestData;
}

const dpt = (calibration: Record<string, unknown>) => getDPT(manifest(calibration));
const residual = (calibration: Record<string, unknown>) => getDPTResidual(manifest(calibration));
const fit = (calibration: Record<string, unknown>) => calibrationFit(manifest(calibration));

/** Two points 100 px apart over 10 mm, at height `z`: 10 px/mm as imaged. */
const plane = (z: number, px = 100, mm = 10) => [
  cal([0, 0], [0, 0, z]),
  cal([px, 0], [mm, 0, z]),
];

describe('the schema accepts the two heights', () => {
  it('round-trips both', async () => {
    const archive = new R49Archive();
    archive.setManifest(manifest({ points: plane(0), camera_height_mm: 1150, reference_height_mm: 85 }));
    const loaded = await R49Archive.load(await archive.export());
    const { calibration } = loaded.getManifest().layout;
    expect(calibration.camera_height_mm).toBe(1150);
    expect(calibration.reference_height_mm).toBe(85);
  });

  it('rejects a camera height at or below layout zero', () => {
    // Every reader of the height divides by `h − z`; a camera at the origin is not a pose.
    const archive = new R49Archive();
    expect(() => archive.setManifest(manifest({ points: plane(0), camera_height_mm: 0 }))).toThrow(
      expect.objectContaining({ rule: 'manifest/schema' }),
    );
    expect(() => archive.setManifest(manifest({ points: plane(0), camera_height_mm: -5 }))).toThrow(
      expect.objectContaining({ rule: 'manifest/schema' }),
    );
  });

  it('still rejects an unknown calibration key', () => {
    const archive = new R49Archive();
    expect(() => archive.setManifest(manifest({ points: [], focal_length_mm: 24 }))).toThrow(
      expect.objectContaining({ rule: 'manifest/unknown-key' }),
    );
  });

  /**
   * The #139 decision, as a regression test.
   *
   * Neither field may take a zod `.default()`: a default is populated by the
   * parser, so merely opening and re-saving someone else's archive would write
   * the key into their file. That is damage done at save time and invisible
   * afterwards. If this fails, a `.default()` has crept in.
   */
  it('does not inject either key into an archive that lacked them', async () => {
    const archive = new R49Archive();
    archive.setManifest(manifest({ points: plane(0) }));
    const json = new TextDecoder().decode(
      await (await R49Archive.load(await archive.export())).export().then(async bytes => {
        const reloaded = await R49Archive.load(bytes);
        return new TextEncoder().encode(JSON.stringify(reloaded.getManifest()));
      }),
    );
    expect(json).not.toContain('camera_height_mm');
    expect(json).not.toContain('reference_height_mm');
  });
});

describe('getDPT with a camera height', () => {
  it('changes nothing for a single plane at layout zero', () => {
    // The fixtures' case: h = 1150, every point at z = 0, reference plane 0.
    // Normalization is (h−0)/h = 1 and the lift is h/(h−0) = 1, both exactly.
    const points = plane(0);
    expect(dpt({ points, camera_height_mm: 1150 })).toBeCloseTo(dpt({ points })!, 12);
  });

  it('reports the scale at the reference plane, not at layout zero', () => {
    // Calibrated at z = 0, track at 85 mm, camera at 1150: the track images
    // h/(h−z_ref) = 1150/1065 larger, ~8.0%.
    const points = plane(0);
    const atZero = dpt({ points, camera_height_mm: 1150 })!;
    const atRail = dpt({ points, camera_height_mm: 1150, reference_height_mm: 85 })!;
    expect(atRail / atZero).toBeCloseTo(1150 / 1065, 12);
    expect(atRail / atZero).toBeGreaterThan(1.079);
  });

  it('combines pairs at different heights instead of blending them', () => {
    // Two planes imaged by the same camera: 10 px/mm at z = 0 and, 85 mm
    // closer to a 1150 mm camera, 10·1150/1065 px/mm at z = 85. Normalized,
    // both report the same scale at layout zero, so the fit is exact and the
    // residual is zero — the blend the old rule produced is gone.
    const points = [...plane(0), ...plane(85, 100 * (1150 / 1065), 10)];
    expect(dpt({ points, camera_height_mm: 1150 })).toBeCloseTo(10 * HO_GAUGE, 8);
    expect(residual({ points, camera_height_mm: 1150 })!).toBeLessThan(1e-9);
  });

  it('leaves a pair spanning two heights out of the fit', () => {
    // Two points at different z have different depths *and* azimuths, so their
    // pixel separation is not a scale times a distance under any model kept.
    expect(dpt({ points: [cal([0, 0], [0, 0, 0]), cal([100, 0], [10, 0, 85])], camera_height_mm: 1150 })).toBeNull();
  });

  it('returns null when the reference plane is at or above the camera', () => {
    expect(dpt({ points: plane(0), camera_height_mm: 100, reference_height_mm: 100 })).toBeNull();
    expect(dpt({ points: plane(0), camera_height_mm: 100, reference_height_mm: 150 })).toBeNull();
  });

  it('ignores a pair at or above the camera rather than inverting it', () => {
    const points = [...plane(0), ...plane(1200)];
    // The z = 1200 pair sits above a 1150 mm camera; only the z = 0 pair survives.
    expect(dpt({ points, camera_height_mm: 1150 })).toBeCloseTo(10 * HO_GAUGE, 10);
  });
});

describe('getDPT without a camera height', () => {
  it('restricts the fit to the reference plane', () => {
    // z = 0 and z = 85 both present, no camera height: only the named plane is
    // spoken about. Previously both entered one fit and blended silently.
    const points = [...plane(0), ...plane(85, 200, 10)];
    expect(dpt({ points })).toBeCloseTo(10 * HO_GAUGE, 10);
    expect(dpt({ points, reference_height_mm: 85 })).toBeCloseTo(20 * HO_GAUGE, 10);
  });

  it('returns null when no point sits on the reference plane', () => {
    expect(dpt({ points: plane(0), reference_height_mm: 85 })).toBeNull();
  });
});

describe('the residual validates the camera height', () => {
  /** Two planes consistent with a 1150 mm camera, on 500 mm baselines. */
  const twoPlanes = [
    cal([0, 0], [0, 0, 0]),
    cal([606, 0], [500, 0, 0]),
    cal([0, 400], [0, 0, 85]),
    cal([606 * (1150 / 1065), 400], [500, 0, 85]),
  ];

  it('is ~zero at the true height', () => {
    expect(residual({ points: twoPlanes, camera_height_mm: 1150 })!).toBeLessThan(1e-9);
  });

  it('rises far above the click floor when the height is wrong', () => {
    // A 50% error (1725 for 1150). The z = 0 pair normalizes by (h−0)/h = 1
    // whatever `h` is, so only the z = 85 pair moves: 606 px against 622.12,
    // a 16.12 px disagreement. The fit then *splits* it — least squares over
    // two equal-weight pairs puts the scale midway — so the RMS residual is
    // half the disagreement, 8.06 px, not the raw 16. Against a ~1.4 px click
    // floor that is still ~6×, which is the claim: detectable, not a gate.
    const wrong = residual({ points: twoPlanes, camera_height_mm: 1725 })!;
    expect(wrong).toBeCloseTo(8.06, 1);
    expect(wrong).toBeGreaterThan(5);
  });

  it('is blind when every point shares one height', () => {
    // A uniform scale bias is indistinguishable from a different camera
    // distance, so this is a cross-check and never a gate.
    const onePlane = [cal([0, 0], [0, 0]), cal([606, 0], [500, 0]), cal([1212, 0], [1000, 0])];
    expect(residual({ points: onePlane, camera_height_mm: 1150 })).toBeCloseTo(
      residual({ points: onePlane, camera_height_mm: 300 })!,
      12,
    );
  });
});

describe('calibrationFit', () => {
  it('names the pairs the fit used, normalized to layout zero', () => {
    // 100 px over 10 mm at z = 85 under a 1150 mm camera: (1150 − 85)/1150 of
    // the imaged separation is what the fit sees.
    const points = [...plane(0), ...plane(85)];
    const { pairs } = fit({ points, camera_height_mm: 1150 });
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ a: points[0], b: points[1], dPx: 100, dMm: 10 });
    expect(pairs[1].a).toBe(points[2]);
    expect(pairs[1].b).toBe(points[3]);
    expect(pairs[1].dPx).toBeCloseTo(100 * (1065 / 1150), 12);
    expect(pairs[1].dMm).toBe(10);
  });

  it('carries the DPT and residual getDPT and getDPTResidual report', () => {
    const points = [...plane(0), ...plane(85, 110)];
    const result = fit({ points, camera_height_mm: 1150, reference_height_mm: 85 });
    expect(result.dpt).toBeCloseTo(dpt({ points, camera_height_mm: 1150, reference_height_mm: 85 })!, 12);
    expect(result.residual).toBeGreaterThan(0);
    expect(result.residual).toBe(residual({ points, camera_height_mm: 1150, reference_height_mm: 85 }));
  });

  describe('leftOut', () => {
    const at = (z: number, x = 0) => cal([x, 0], [x, 0, z]);
    const reasons = (calibration: Record<string, unknown>) =>
      fit(calibration).leftOut.map(l => [l.point, l.reason]);

    it('names points off the reference plane when there is no camera height', () => {
      const points = [at(0), at(0, 10), at(85)];
      expect(reasons({ points })).toEqual([[points[2], 'off-reference-plane']]);
    });

    it('measures against the authored reference plane, not zero', () => {
      const points = [at(0), at(85), at(85, 10)];
      expect(reasons({ points, reference_height_mm: 85 })).toEqual([[points[0], 'off-reference-plane']]);
    });

    it('leaves nothing off the plane once a camera height makes every height usable', () => {
      const points = [at(0), at(0, 10), at(85), at(85, 10)];
      expect(reasons({ points, camera_height_mm: 1150 })).toEqual([]);
    });

    it('names points at or above the camera', () => {
      const points = [at(0), at(0, 10), at(1150), at(1200), at(1200, 10)];
      expect(reasons({ points, camera_height_mm: 1150 })).toEqual([
        [points[2], 'above-camera'],
        [points[3], 'above-camera'],
        [points[4], 'above-camera'],
      ]);
    });

    it('names a usable point no other point shares a height with', () => {
      const points = [at(0), at(0, 10), at(85)];
      expect(reasons({ points, camera_height_mm: 1150 })).toEqual([[points[2], 'no-partner']]);
      expect(reasons({ points: [at(0)] })).toEqual([[at(0), 'no-partner']]);
    });

    it('accounts for every point exactly once, in a pair or left out', () => {
      const points = [at(0), at(0, 10), at(85), at(1200)];
      const result = fit({ points, camera_height_mm: 1150 });
      const used = new Set(result.pairs.flatMap(p => [p.a, p.b]));
      const left = new Set(result.leftOut.map(l => l.point));
      expect(points.every(p => used.has(p) !== left.has(p))).toBe(true);
    });
  });

  describe('cameraHeightFits', () => {
    it('is null without a camera height', () => {
      expect(fit({ points: plane(0) }).cameraHeightFits).toBeNull();
    });

    it('holds when the camera is above every point', () => {
      expect(fit({ points: [...plane(0), ...plane(85)], camera_height_mm: 1150 }).cameraHeightFits).toBe(true);
    });

    it('holds with no points to compare against', () => {
      expect(fit({ points: [], camera_height_mm: 5 }).cameraHeightFits).toBe(true);
    });

    it('fails for a camera at or below any point, partnered or not', () => {
      // 115 for 1150, the decimal slip: one point at 230 mm is enough.
      expect(fit({ points: [cal([0, 0], [0, 0, 230])], camera_height_mm: 115 }).cameraHeightFits).toBe(false);
      expect(fit({ points: plane(500), camera_height_mm: 500 }).cameraHeightFits).toBe(false);
    });
  });

  it('reports no DPT and no residual for an empty calibration', () => {
    expect(fit({ points: [] })).toMatchObject({ dpt: null, residual: null, pairs: [], leftOut: [] });
  });
});

describe('the unknown-key refusal is worded for the person who meets it', () => {
  /**
   * The additive fields add no version (#139), so an unknown key — not a
   * version mismatch — is how a stale reader meets a newer archive. zod's own
   * `Unrecognized key(s) in object` is legible to someone holding the schema
   * and useless to a model railroader looking at a file that will not open.
   */
  it('names the key, the likely cause, and the fix', () => {
    const archive = new R49Archive();
    let message = '';
    try {
      archive.setManifest(manifest({ points: [], invented_by_a_newer_build: 7 }));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('invented_by_a_newer_build');
    expect(message).toContain('newer version of rails49');
    expect(message).toContain('reload the app');
    // The hedge is not padding: an unknown key is equally a hand-edit typo,
    // and nothing can tell the two apart.
    expect(message).toContain('hand-edited');
  });

  it('gives the dotted path, so a nested key is findable', () => {
    const archive = new R49Archive();
    let message = '';
    try {
      archive.setManifest(manifest({ points: [], focal_length_mm: 24 }));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('layout.calibration.focal_length_mm');
  });

  it('leaves every other validation failure alone', () => {
    // Rewording a type error as "reload the app" would send the reader to the
    // wrong place entirely.
    const archive = new R49Archive();
    let message = '';
    try {
      archive.setManifest(manifest({ points: [], camera_height_mm: 'tall' }));
    } catch (err) {
      message = String(err);
    }
    expect(message).not.toContain('reload the app');
  });
});
