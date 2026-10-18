import { describe, it, expect } from 'vitest';
import { R49Archive, R49Error, getDPT, getDPTResidual } from '../src/index.ts';
import type { ManifestData } from '../src/index.ts';

// One seam: the archive. Every test here drives the package's public interface
// — build or load an archive, mutate the manifest, export, reload the bytes,
// assert on what comes back. Nothing reaches for a zod schema object, asserts
// on a parse error's internal shape, or imports a sibling module to check an
// intermediate: the schemas are deliberately withheld from index.ts so that
// validation stays replaceable, and a test that pinned them down would undo
// that.

/** A minimal valid v4 manifest, spread-and-overridden per test. */
function manifest(overrides: Record<string, unknown> = {}): ManifestData {
  return {
    version: 4,
    layout: { name: 'Test Layout', scale: 'HO', calibration: { points: [] }, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
    ...overrides,
  } as ManifestData;
}

/** Round-trip through the real serializer: set, export bytes, load them back. */
async function roundTrip(data: ManifestData): Promise<R49Archive> {
  const archive = new R49Archive();
  archive.setManifest(data);
  return await R49Archive.load(await archive.export());
}

/**
 * Assert that setting this manifest is rejected, and return the refusal.
 * Tests assert its `rule`, never its wording (#182).
 */
function rejection(data: unknown): R49Error {
  const archive = new R49Archive();
  try {
    archive.setManifest(data as ManifestData);
  } catch (err) {
    expect(err).toBeInstanceOf(R49Error);
    return err as R49Error;
  }
  throw new Error('expected the manifest to be rejected, but it was accepted');
}

const car = (over: Record<string, unknown> = {}) => ({
  id: 'car-1',
  class: 'stock',
  p0: { x: 10, y: 20 },
  p1: { x: 110, y: 25 },
  provenance: 'human',
  ...over,
});

/** Calibration point at pixel (px) and world (world), z defaulting to 0. */
const cal = (px: [number, number], world: [number, number, number?]) => ({
  px: { x: px[0], y: px[1] },
  world: { x: world[0], y: world[1], z: world[2] ?? 0 },
});

describe('R49Archive', () => {
  describe('round trip', () => {
    it('preserves cars in all three provenance variants', async () => {
      const loaded = await roundTrip(manifest({
        images: [{
          filename: 'a.jpg',
          labeled_complete: true,
          labels: [
            car({ id: 'a', provenance: 'human' }),
            car({ id: 'b', provenance: 'proposed', proposed_by: 'v1.0.0' }),
            car({ id: 'c', class: 'stock.loco.steam', provenance: 'corrected', proposed_by: 'v2' }),
          ],
        }],
      }));

      const labels = loaded.getManifest().images[0].labels;
      expect(labels).toHaveLength(3);
      expect(labels[0]).toEqual(car({ id: 'a', provenance: 'human' }));
      expect(labels[1]).toEqual(car({ id: 'b', provenance: 'proposed', proposed_by: 'v1.0.0' }));
      expect(labels[2]).toEqual(
        car({ id: 'c', class: 'stock.loco.steam', provenance: 'corrected', proposed_by: 'v2' })
      );
    });

    it('preserves sensors with and without names', async () => {
      const loaded = await roundTrip(manifest({
        layout: {
          scale: 'N',
          calibration: { points: [] },
          sensors: [
            { id: 's1', x: 5, y: 6, name: 'yard ladder east' },
            { id: 's2', x: 7, y: 8 },
          ],
        },
      }));

      const sensors = loaded.getManifest().layout.sensors;
      expect(sensors[0]).toEqual({ id: 's1', x: 5, y: 6, name: 'yard ladder east' });
      // A nameless sensor stays nameless — nothing invents a "Sensor 2".
      expect(sensors[1]).toEqual({ id: 's2', x: 7, y: 8 });
      expect('name' in sensors[1]).toBe(false);
    });

    it('preserves multi-point calibration and mixed labeled_complete', async () => {
      const loaded = await roundTrip(manifest({
        layout: {
          scale: 'HO',
          sensors: [],
          calibration: { points: [cal([0, 0], [0, 0]), cal([100, 0], [10, 0]), cal([50, 50], [5, 5, 12])] },
        },
        images: [
          { filename: 'a.jpg', labeled_complete: true, labels: [] },
          { filename: 'b.jpg', labeled_complete: false, labels: [] },
        ],
      }));

      const m = loaded.getManifest();
      expect(m.layout.calibration.points).toHaveLength(3);
      expect(m.layout.calibration.points[2]).toEqual(cal([50, 50], [5, 5, 12]));
      expect(m.images.map(i => i.labeled_complete)).toEqual([true, false]);
    });

    it('carries DPT and its residual across a save and reopen unchanged', async () => {
      // What the editor writes when a user calibrates: three coplanar points,
      // one of them slightly off, so both derived numbers are non-trivial.
      const points = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0]), cal([210, 0], [20, 0])];
      const authored = manifest({
        layout: { scale: 'HO', sensors: [], calibration: { points } },
      });

      const loaded = await roundTrip(authored);

      expect(loaded.getManifest().layout.calibration.points).toEqual(points);
      expect(getDPT(loaded.getManifest())).toBe(getDPT(authored));
      expect(getDPTResidual(loaded.getManifest())).toBe(getDPTResidual(authored));
      expect(getDPTResidual(loaded.getManifest())).toBeGreaterThan(0);
    });

    it('preserves layout metadata and camera resolution', async () => {
      const loaded = await roundTrip(manifest({
        layout: {
          name: 'Basement', description: 'HO switching layout', contact: 'a@b.c',
          scale: 'HO', calibration: { points: [] }, sensors: [],
        },
        camera: { resolution: { width: 4032, height: 3024 }, model: 'iPhone 13' },
      }));

      const m = loaded.getManifest();
      expect(m.layout).toMatchObject({
        name: 'Basement', description: 'HO switching layout', contact: 'a@b.c', scale: 'HO',
      });
      expect(m.camera).toEqual({ resolution: { width: 4032, height: 3024 }, model: 'iPhone 13' });
    });
  });

  describe('version', () => {
    it('rejects a v3 manifest, naming the version', () => {
      const refusal = rejection({
        version: 3,
        layout: { name: 'Old', scale: 'N', calibration: { p0: { x: 0, y: 0 }, p1: { x: 1, y: 1 }, size_mm: 1 } },
        camera: { resolution: { width: 640, height: 480 } },
        images: [{ filename: '1.jpg', labels: {} }],
      });
      expect(refusal.rule).toBe('manifest/version');
    });

    it('rejects a v3 archive on load, naming the version', async () => {
      // Build v3 bytes the way v3 wrote them, bypassing the v4 validator.
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify({
        version: 3,
        layout: { scale: 'N' },
        camera: { resolution: { width: 640, height: 480 } },
        images: [{ filename: '1.jpg', labels: { m1: { x: 1, y: 2, type: 'track' } } }],
      }));
      const bytes = await zip.generateAsync({ type: 'uint8array' });

      await expect(R49Archive.load(bytes)).rejects.toMatchObject({ rule: 'manifest/version' });
    });
  });

  describe('schema invariants, at the boundary', () => {
    it('rejects proposed_by on a human label', () => {
      const m = manifest({
        images: [{ filename: 'a.jpg', labels: [car({ provenance: 'human', proposed_by: 'v1' })] }],
      });
      expect(rejection(m).rule).toBe('manifest/provenance');
    });

    it('rejects a missing proposed_by on proposed and on corrected', () => {
      for (const provenance of ['proposed', 'corrected']) {
        const m = manifest({
          images: [{ filename: 'a.jpg', labels: [car({ provenance })] }],
        });
        expect(rejection(m).rule, `${provenance} without proposed_by`).toBe('manifest/provenance');
      }
    });

    it('rejects a missing provenance', () => {
      const { provenance: _omitted, ...withoutProvenance } = car();
      const m = manifest({
        images: [{ filename: 'a.jpg', labels: [withoutProvenance] }],
      });
      expect(rejection(m).rule).toBe('manifest/provenance');
    });

    it('rejects duplicate ids within one collection', () => {
      const dupLabels = manifest({
        images: [{ filename: 'a.jpg', labels: [car({ id: 'x' }), car({ id: 'x' })] }],
      });
      expect(rejection(dupLabels).rule).toBe('manifest/duplicate-id');

      const dupSensors = manifest({
        layout: {
          scale: 'N', calibration: { points: [] },
          sensors: [{ id: 'x', x: 1, y: 1 }, { id: 'x', x: 2, y: 2 }],
        },
      });
      expect(rejection(dupSensors).rule).toBe('manifest/duplicate-id');
    });

    it('accepts an id shared between a sensor and a label', async () => {
      // Separate namespaces, never compared.
      const loaded = await roundTrip(manifest({
        layout: { scale: 'N', calibration: { points: [] }, sensors: [{ id: 'shared', x: 1, y: 1 }] },
        images: [{ filename: 'a.jpg', labels: [car({ id: 'shared' })] }],
      }));

      expect(loaded.getManifest().layout.sensors[0].id).toBe('shared');
      expect(loaded.getManifest().images[0].labels[0].id).toBe('shared');
    });

    it('accepts an out-of-vocabulary class string', async () => {
      // Pruning the vocabulary must not lock anyone out of their own files.
      const loaded = await roundTrip(manifest({
        images: [{ filename: 'a.jpg', labels: [car({ class: 'not.in.any.vocabulary' })] }],
      }));
      expect(loaded.getManifest().images[0].labels[0].class).toBe('not.in.any.vocabulary');
    });

    it('rejects a missing scale rather than defaulting it', () => {
      // v3 defaulted this to 'N'. DPT = s · gauge_mm(scale), so a silently
      // assumed scale reports a DPT wrong by the ratio between the two — up
      // to 8.8x between Z and G. SPEC names only two defaults, and this is
      // not one of them.
      const m = manifest({ layout: { calibration: { points: [] }, sensors: [] } });
      expect(rejection(m).rule).toBe('manifest/schema');
    });

    it('defaults an absent calibration to empty points', async () => {
      const loaded = await roundTrip(manifest({ layout: { scale: 'N' } }));
      expect(loaded.getManifest().layout.calibration).toEqual({ points: [] });
      expect(loaded.getManifest().layout.sensors).toEqual([]);
    });

    it('defaults an absent labeled_complete to false', async () => {
      const loaded = await roundTrip(manifest({ images: [{ filename: 'a.jpg' }] }));
      const image = loaded.getManifest().images[0];
      expect(image.labeled_complete).toBe(false);
      expect(image.labels).toEqual([]);
    });

    it('accepts an image marked complete with zero cars', async () => {
      // A legitimate all-background sample, not a gap.
      const loaded = await roundTrip(manifest({
        images: [{ filename: 'a.jpg', labeled_complete: true, labels: [] }],
      }));
      expect(loaded.getManifest().images[0].labeled_complete).toBe(true);
    });
  });

  describe('getDPT', () => {
    /** HO gauge in mm: 1435 / 87. */
    const HO_GAUGE = 1435 / 87;

    function dptOf(points: ReturnType<typeof cal>[], scale = 'HO') {
      return getDPT(manifest({ layout: { scale, calibration: { points }, sensors: [] } }));
    }

    it('gives the v3 answer for two coplanar points', () => {
      // 100 px over 10 mm => 10 px/mm, the d_px / d_mm the v3 code computed.
      expect(dptOf([cal([0, 0], [0, 0]), cal([100, 0], [10, 0])])).toBeCloseTo(10 * HO_GAUGE, 10);
    });

    it('is unmoved by a third point at a different z', () => {
      const base = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0])];
      const withOffPlane = [...base, cal([500, 500], [1, 1, 25])];
      // Off-plane points are stored but inert.
      expect(dptOf(withOffPlane)).toBeCloseTo(dptOf(base)!, 10);
    });

    it('returns null for empty, single-point, and all-different-height cases', () => {
      expect(dptOf([])).toBeNull();
      expect(dptOf([cal([0, 0], [0, 0])])).toBeNull();
      expect(dptOf([cal([0, 0], [0, 0, 1]), cal([100, 0], [10, 0, 2])])).toBeNull();
    });

    it('returns null for coincident points rather than dividing by zero', () => {
      const result = dptOf([cal([0, 0], [5, 5]), cal([100, 100], [5, 5])]);
      expect(result).toBeNull();
    });

    it('weights a long baseline over a short one', () => {
      // Three coplanar points, so all three pairs enter the fit:
      //   origin–far   1000 px / 100 mm  => 10.0 px/mm   (long)
      //   origin–near    20 px /   1 mm  => 20.0 px/mm   (short, disagrees)
      //   near–far      980 px /  99 mm  =>  9.9 px/mm   (long)
      const origin = cal([0, 0], [0, 0]);
      const near = cal([20, 0], [1, 0]);
      const far = cal([1000, 0], [100, 0]);

      const fitted = dptOf([origin, near, far])! / HO_GAUGE;

      // An unweighted mean of the three pair ratios would be ~13.3. The d_mm²
      // weighting instead lands within 1% of the two long baselines and all
      // but ignores the short one, which is the bias the fit exists to have:
      // click error is a fixed number of pixels, so short baselines are
      // proportionally noisier.
      const unweightedMean = (10 + 20 + 980 / 99) / 3;
      expect(unweightedMean).toBeGreaterThan(13);

      expect(fitted).toBeGreaterThan(9.9);
      expect(fitted).toBeLessThan(10.0);
      expect(Math.abs(fitted - 20)).toBeGreaterThan(Math.abs(fitted - 10) * 50);
    });

    it('scales by the gauge ratio when the scale changes', () => {
      const points = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0])];
      const ho = dptOf(points, 'HO')!;
      const n = dptOf(points, 'N')!;
      // gauge_HO / gauge_N == ratio_N / ratio_HO == 160 / 87
      expect(ho / n).toBeCloseTo(160 / 87, 10);
    });
  });

  describe('getDPTResidual', () => {
    function residualOf(points: ReturnType<typeof cal>[], scale = 'HO') {
      return getDPTResidual(manifest({ layout: { scale, calibration: { points }, sensors: [] } }));
    }

    it('is null while the fit is exact by construction', () => {
      // Nothing to fit, nothing over-determined: no pair, and the single pair
      // a two-point calibration gives, both reproduce themselves exactly, so a
      // residual of zero would claim agreement nobody checked.
      expect(residualOf([])).toBeNull();
      expect(residualOf([cal([0, 0], [0, 0])])).toBeNull();
      expect(residualOf([cal([0, 0], [0, 0]), cal([100, 0], [10, 0])])).toBeNull();
    });

    it('is null when no scale resolves at all', () => {
      // Three points, three pairs, every one of them zero millimetres apart.
      expect(residualOf([cal([0, 0], [5, 5]), cal([50, 0], [5, 5]), cal([99, 0], [5, 5])])).toBeNull();
    });

    it('is zero when three coplanar points agree', () => {
      const points = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0]), cal([200, 0], [20, 0])];
      expect(residualOf(points)).toBeCloseTo(0, 10);
    });

    it('reports a mistyped coordinate in image pixels', () => {
      // The third point's world y is 200 mm where the pixels say 20 mm — the
      // millimetre/pixel confusion the readout exists to make visible.
      const points = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0]), cal([200, 0], [200, 0])];
      const residual = residualOf(points)!;
      expect(residual).toBeGreaterThan(10);
      // RMS over the three pairs of (d_px - s·d_mm), s = 60000/76100 px/mm.
      expect(residual).toBeCloseTo(65.2, 1);
    });

    it('ignores pairs at a different height, exactly as the fit does', () => {
      const coplanar = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0]), cal([200, 0], [20, 0])];
      // An off-plane point disagrees wildly and still contributes nothing: it
      // pairs with nothing at its own z, and cross-height pairs never enter.
      expect(residualOf([...coplanar, cal([9999, 9999], [1, 1, 30])])).toBeCloseTo(0, 10);
    });

    it('is unaffected by the scale, being a pixel-domain quantity', () => {
      const points = [cal([0, 0], [0, 0]), cal([100, 0], [10, 0]), cal([200, 0], [30, 0])];
      expect(residualOf(points, 'N')).toBeCloseTo(residualOf(points, 'G')!, 10);
    });
  });

  describe('image management', () => {
    it('appends an image with no labels and labeled_complete false', async () => {
      const archive = new R49Archive();
      archive.setManifest(manifest());

      const imgData = new Uint8Array([1, 2, 3]);
      await archive.addImage('test.jpg', imgData);

      const images = archive.getManifest().images;
      expect(images).toHaveLength(1);
      expect(images[0]).toEqual({ filename: 'test.jpg', labeled_complete: false, labels: [] });
      expect(await archive.getImage('test.jpg')).toEqual(imgData);

      archive.removeImage('test.jpg');
      expect(archive.getManifest().images).toHaveLength(0);
    });

    it('reorders images', () => {
      const archive = new R49Archive();
      archive.setManifest(manifest({
        images: [
          { filename: '1.jpg', labeled_complete: false, labels: [] },
          { filename: '2.jpg', labeled_complete: false, labels: [] },
          { filename: '3.jpg', labeled_complete: false, labels: [] },
        ],
      }));

      archive.reorderImages(0, 2);
      expect(archive.getManifest().images.map(i => i.filename)).toEqual(['2.jpg', '3.jpg', '1.jpg']);

      archive.reorderImages(2, 1);
      expect(archive.getManifest().images.map(i => i.filename)).toEqual(['2.jpg', '1.jpg', '3.jpg']);
    });

    it('removes an image together with its labels', async () => {
      const archive = new R49Archive();
      archive.setManifest(manifest({
        images: [{ filename: 'a.jpg', labeled_complete: true, labels: [car()] }],
      }));

      archive.removeImage('a.jpg');
      expect(archive.getManifest().images).toHaveLength(0);
      expect(await archive.getImage('a.jpg')).toBeNull();
    });
  });

  // The archive-level id is identity: optional at the format layer, required
  // by the corpus repo, and — once minted — never changed by anything this
  // package does. The two properties below are the whole contract, and both
  // are about *writes*, because a write is the only thing that could break it.
  describe('archive id', () => {
    it('mints one on write when the manifest has none', async () => {
      const archive = new R49Archive();
      archive.setManifest(manifest());
      expect(archive.getManifest().id).toBeUndefined();

      const loaded = await R49Archive.load(await archive.export());
      expect(loaded.getManifest().id).toEqual(expect.any(String));
      expect(loaded.getManifest().id).not.toHaveLength(0);
    });

    it('never overwrites an existing id, however many times it is written', async () => {
      const archive = new R49Archive();
      archive.setManifest(manifest({ id: 'aBcDeFgHiJk' }));

      // Three writes, because the download fallback writes a freshly-named
      // file on every save: if minting were unconditional this is where a
      // single archive would acquire a new identity per save.
      await archive.export();
      await archive.export();
      const loaded = await R49Archive.load(await archive.export());

      expect(loaded.getManifest().id).toBe('aBcDeFgHiJk');
    });

    it('carries a minted id through a reload and a second export unchanged', async () => {
      const first = new R49Archive();
      first.setManifest(manifest());
      const reloaded = await R49Archive.load(await first.export());
      const minted = reloaded.getManifest().id;

      const again = await R49Archive.load(await reloaded.export());
      expect(again.getManifest().id).toBe(minted);
    });

    it('rejects an empty id rather than treating it as absent', () => {
      expect(rejection(manifest({ id: '' })).rule).toBe('manifest/schema');
    });
  });

  // Strictness is per object in zod, so it has to be asserted per object:
  // a schema that gained a nested object without `.strict()` would pass every
  // test above while silently deleting whatever a newer build wrote into it.
  describe('unknown keys are rejected, not stripped', () => {
    // Asserted on the rule and the *offending key*, not on the wording. The
    // message is reworded for the person who meets it (#139) and may be
    // reworded again; what must never change is that the refusal names what
    // was wrong — the key is data the message carries, not prose.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['the manifest root', manifest({ vendor_extra: 1 }), 'vendor_extra'],
      ['layout', manifest({ layout: { scale: 'HO', calibration: { points: [] }, sensors: [], hue: 1 } }), 'layout.hue'],
      ['calibration', manifest({ layout: { scale: 'HO', calibration: { points: [], fitted: true }, sensors: [] } }), 'layout.calibration.fitted'],
      [
        'a calibration point',
        manifest({
          layout: {
            scale: 'HO',
            calibration: { points: [{ ...cal([0, 0], [0, 0]), label: 'origin' }] },
            sensors: [],
          },
        }),
        'layout.calibration.points.0.label',
      ],
      [
        'a point',
        manifest({
          layout: {
            scale: 'HO',
            calibration: { points: [{ px: { x: 0, y: 0, z: 0 }, world: { x: 0, y: 0, z: 0 } }] },
            sensors: [],
          },
        }),
        'layout.calibration.points.0.px.z',
      ],
      [
        'a world point',
        manifest({
          layout: {
            scale: 'HO',
            calibration: { points: [{ px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0, w: 0 } }] },
            sensors: [],
          },
        }),
        'layout.calibration.points.0.world.w',
      ],
      [
        'a sensor',
        manifest({
          layout: {
            scale: 'HO',
            calibration: { points: [] },
            sensors: [{ id: 's1', x: 1, y: 2, colour: 'red' }],
          },
        }),
        'layout.sensors.0.colour',
      ],
      ['camera', manifest({ camera: { resolution: { width: 1920, height: 1080 }, fps: 30 } }), 'camera.fps'],
      ['camera resolution', manifest({ camera: { resolution: { width: 1920, height: 1080, depth: 8 } } }), 'camera.resolution.depth'],
      ['an image', manifest({ images: [{ filename: 'a.jpg', labels: [], captured_at: 'now' }] }), 'images.0.captured_at'],
      ['a car label', manifest({ images: [{ filename: 'a.jpg', labels: [car({ colour: 'red' })] }] }), 'images.0.labels.0.colour'],
    ];

    for (const [where, data, key] of cases) {
      it(`rejects an unknown key in ${where}`, () => {
        const refusal = rejection(data);
        expect(refusal.rule).toBe('manifest/unknown-key');
        expect(refusal.message).toContain(key);
      });
    }

    it('keeps accepting every optional key the format does define', async () => {
      const loaded = await roundTrip(
        manifest({
          id: 'aBcDeFgHiJk',
          layout: {
            name: 'Yard',
            description: 'west end',
            contact: 'me@example.com',
            scale: 'HO',
            calibration: { points: [] },
            sensors: [{ id: 's1', x: 1, y: 2, name: 'siding 3' }],
          },
          camera: { resolution: { width: 1920, height: 1080 }, model: 'Pi HQ' },
        })
      );

      const m = loaded.getManifest();
      expect(m.id).toBe('aBcDeFgHiJk');
      expect(m.layout.description).toBe('west end');
      expect(m.layout.sensors[0].name).toBe('siding 3');
      expect(m.camera.model).toBe('Pi HQ');
    });
  });
});
