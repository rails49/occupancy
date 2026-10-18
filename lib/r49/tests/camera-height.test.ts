import { describe, it, expect } from 'vitest';
import { R49Archive, getDPT, getDPTResidual } from '../src/index.ts';
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
    // Every consumer divides by `h − z`; a camera at the origin is not a pose.
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
