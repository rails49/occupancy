import { describe, it, expect } from 'vitest';
import { carWidthPx } from '@occupancy/detector';
import { R49Archive, getDPT, type ManifestData } from '@rails49/r49';
import { planArchive, type ImageDecoder, type ImagePlan } from '../src/yolo_rules.ts';

/**
 * The YOLO export's rules. Every wrong number here is invisible until a model
 * trains badly for a reason nobody can name, which is why these are pinned
 * rather than eyeballed once.
 *
 * Every archive is built by `R49Archive` and round-tripped through the real
 * serializer, so each manifest under test is one the format accepts. Nothing
 * reads a fixture off disk: a rule is only pinned if the archive that triggers
 * it can be constructed exactly. The decoder is the one stand-in — it reports
 * a stated size for any image the archive carries, so no test needs a real
 * JPEG or `sharp`.
 *
 * The car box's own cases are `@occupancy/detector`'s, with `spanToPolygon`.
 */

const A_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const FRAME = { width: 1920, height: 1080 };

/** Two calibration points at equal height, far enough apart to clear MIN_DPT at HO. */
const CALIBRATED = [
  { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
  { px: { x: 1000, y: 0 }, world: { x: 800, y: 0, z: 0 } },
];

/** Two points at different heights: no equal-height pair, so no DPT. */
const UNCALIBRATED = [
  { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
  { px: { x: 1000, y: 0 }, world: { x: 800, y: 0, z: 50 } },
];

const car = (over: Record<string, unknown> = {}) => ({
  id: 'car-1',
  class: 'stock',
  p0: { x: 100, y: 540 },
  p1: { x: 300, y: 540 },
  provenance: 'human',
  ...over,
});

interface ImageSpec {
  filename?: string;
  complete?: boolean;
  labels?: Record<string, unknown>[];
  /** Leave the file out of the zip while the manifest still names it. */
  missing?: boolean;
}

interface Built {
  manifest: ManifestData;
  decode: ImageDecoder;
}

async function build(
  images: ImageSpec[],
  opts: { calibration?: typeof CALIBRATED; decodesAs?: { width: number; height: number } } = {}
): Promise<Built> {
  const filenames = images.map((spec, i) => spec.filename ?? `image-${i}.jpeg`);
  const draft = new R49Archive();
  // Typed `unknown` on the way in, as the format's own tests build manifests:
  // a literal checked against ManifestData would need every optional key.
  const manifest: unknown = {
    version: 4,
    layout: { scale: 'HO', calibration: { points: opts.calibration ?? CALIBRATED }, sensors: [] },
    camera: { resolution: FRAME },
    images: images.map((spec, i) => ({
      filename: filenames[i],
      labeled_complete: spec.complete ?? true,
      labels: spec.labels ?? [],
    })),
  };
  draft.setManifest(manifest as ManifestData);
  for (const [i, spec] of images.entries()) {
    if (!spec.missing) await draft.addImage(filenames[i], A_JPEG);
  }

  const archive = await R49Archive.load(await draft.export());
  const size = opts.decodesAs ?? FRAME;
  return {
    manifest: archive.getManifest(),
    decode: async filename => ((await archive.getImage(filename)) === null ? null : size),
  };
}

/** The plan for a one-archive corpus, failing the test if the archive is fatal. */
async function plan(name: string, built: Built, valSplit?: number): Promise<readonly ImagePlan[]> {
  const result = await planArchive(name, built.manifest, built.decode, valSplit);
  if (result.kind !== 'planned') throw new Error(`expected a plan, got: ${result.reason}`);
  return result.images;
}

function exported(image: ImagePlan | undefined) {
  if (image?.kind !== 'exported') throw new Error(`expected an export, got ${JSON.stringify(image)}`);
  return image;
}

describe('the labeled_complete gate', () => {
  it('skips an image a human has not vouched for, labels and all', async () => {
    const images = await plan('a', await build([{ complete: false, labels: [car()] }]));
    expect(images).toEqual([{ kind: 'skipped', filename: 'image-0.jpeg' }]);
  });

  it('is the only thing that skips: a complete image beside it still exports', async () => {
    const images = await plan('a', await build([{ complete: false }, { labels: [car()] }]));
    expect(images.map(i => i.kind)).toEqual(['skipped', 'exported']);
  });

  it('does not look inside a skipped image, so its faults are not fatal', async () => {
    const images = await plan(
      'a',
      await build([{ complete: false, missing: true, labels: [car({ class: 'tree' })] }])
    );
    expect(images.map(i => i.kind)).toEqual(['skipped']);
  });
});

describe('fatal', () => {
  it('is a whole archive without a DPT', async () => {
    const built = await build([{ labels: [car()] }], { calibration: UNCALIBRATED });
    expect(getDPT(built.manifest)).toBeNull();

    const result = await planArchive('west', built.manifest, built.decode);
    expect(result.kind).toBe('fatal');
    if (result.kind === 'fatal') expect(result.reason).toMatch(/^west: no DPT/);
  });

  it('is an image whose class no detector.classes entry prefixes', async () => {
    const [image] = await plan('a', await build([{ labels: [car({ id: 'x', class: 'tree' })] }]));
    expect(image?.kind).toBe('fatal');
    if (image?.kind === 'fatal') {
      expect(image.reasons).toHaveLength(1);
      expect(image.reasons[0]).toMatch(/^a\/image-0\.jpeg: label x has class "tree"/);
    }
  });

  it('is an image the manifest names and the archive does not carry', async () => {
    const [image] = await plan('a', await build([{ missing: true }]));
    expect(image).toEqual({
      kind: 'fatal',
      filename: 'image-0.jpeg',
      reasons: ['a: manifest names image-0.jpeg, which the archive does not contain'],
    });
  });

  it('is an image with a span whose ends coincide, which has no orientation', async () => {
    const [image] = await plan(
      'a',
      await build([{ labels: [car({ id: 'x', p0: { x: 100, y: 540 }, p1: { x: 100, y: 540 } })] }])
    );
    expect(image?.kind).toBe('fatal');
    if (image?.kind === 'fatal') expect(image.reasons[0]).toMatch(/^a\/image-0\.jpeg: label x: p0 and p1 coincide/);
  });

  it('names every fault in an image, not only the first', async () => {
    const [image] = await plan(
      'a',
      await build([
        {
          missing: true,
          labels: [car({ id: 'x', class: 'tree' }), car({ id: 'y', class: 'rock' })],
        },
      ])
    );
    expect(image?.kind === 'fatal' && image.reasons).toHaveLength(3);
  });

  it('leaves the other images planned, so the caller sees every fatal one', async () => {
    const images = await plan(
      'a',
      await build([{ labels: [car({ class: 'tree' })] }, { labels: [car()] }, { missing: true }])
    );
    expect(images.map(i => i.kind)).toEqual(['fatal', 'exported', 'fatal']);
  });
});

describe('an exported image', () => {
  it('may carry no cars: an empty label list is an all-background sample', async () => {
    const image = exported((await plan('a', await build([{}])))[0]);
    expect(image.lines).toEqual([]);
    expect(image.warnings).toEqual([]);
  });

  it('carries one line per car, the class index then eight six-decimal corners', async () => {
    const built = await build([{ labels: [car(), car({ id: 'car-2', class: 'stock.boxcar' })] }]);
    const image = exported((await plan('a', built))[0]);

    // A horizontal span from x=100 to x=300 at y=540, half a car width either side.
    const half = carWidthPx(getDPT(built.manifest)!) / 2;
    const top = ((540 + half) / FRAME.height).toFixed(6);
    const bottom = ((540 - half) / FRAME.height).toFixed(6);
    const x0 = (100 / FRAME.width).toFixed(6);
    const x1 = (300 / FRAME.width).toFixed(6);
    const line = `0 ${x0} ${top} ${x1} ${top} ${x1} ${bottom} ${x0} ${bottom}`;

    expect(image.lines).toEqual([line, line]);
    expect(image.cornersClamped).toBe(0);
  });

  it('counts the corners clamped to the frame edge', async () => {
    // At y=0 the two corners on the far side of the chord fall above the frame.
    const image = exported(
      (await plan('a', await build([{ labels: [car({ p0: { x: 100, y: 0 }, p1: { x: 300, y: 0 } })] }])))[0]
    );
    expect(image.cornersClamped).toBe(2);
    expect(image.lines[0]!.split(' ').slice(1).every(c => Number(c) >= 0 && Number(c) <= 1)).toBe(true);
  });

  it('warns, and still exports, when the image decodes at another size than camera.resolution', async () => {
    const image = exported(
      (await plan('a', await build([{ labels: [car()] }], { decodesAs: { width: 1, height: 1 } })))[0]
    );
    expect(image.lines).toHaveLength(1);
    expect(image.warnings).toEqual([
      'a/image-0.jpeg: camera.resolution is 1920x1080 but the image decodes as 1x1; ' +
        'labels were normalized against camera.resolution',
    ]);
  });
});

describe('the stem', () => {
  it('qualifies the image by its archive, so identically named images survive', async () => {
    const built = await build([{}]);
    const stems = await Promise.all(
      ['cars-0-10', 'lighting'].map(async n => exported((await plan(n, built))[0]).stem)
    );
    expect(stems).toEqual(['cars-0-10__image-0', 'lighting__image-0']);
  });

  it('strips only the last extension, and keeps it for the image file', async () => {
    const image = exported((await plan('a', await build([{ filename: 'frame.2.jpg' }])))[0]);
    expect(image.stem).toBe('a__frame.2');
    expect(image.ext).toBe('.jpg');
  });

  it('collapses anything that is not a filename character', async () => {
    const image = exported((await plan('club layout/west', await build([{ filename: 'image 0.jpeg' }])))[0]);
    expect(image.stem).toBe('club-layout-west__image-0');
  });
});

describe('the split', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const splits = async (valSplit?: number) =>
    Promise.all(names.map(async n => exported((await plan(n, await build([{}]), valSplit))[0]).split));

  it('is stable across runs, keyed on the archive and image alone', async () => {
    expect(await splits(0.5)).toEqual(await splits(0.5));
  });

  it('sends everything to val at 1 and nothing at 0', async () => {
    expect(await splits(1)).toEqual(names.map(() => 'val'));
    expect(await splits(0)).toEqual(names.map(() => 'train'));
  });

  it('keeps every car in a frame on one side, by keying on the image', async () => {
    // Labels do not enter the key, so the cars of one frame share its split.
    const bare = exported((await plan('a', await build([{}]), 0.5))[0]);
    const busy = exported((await plan('a', await build([{ labels: [car()] }]), 0.5))[0]);
    expect(busy.split).toBe(bare.split);
  });
});
