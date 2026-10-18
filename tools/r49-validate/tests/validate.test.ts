import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { R49Archive, RULES, type ManifestData } from '@occupancy/r49';
import { MIN_DPT } from '@occupancy/config';
import { validate, type ArchiveInput } from '../src/validate.ts';

// Every archive here is built by R49Archive and exported through the real
// serializer, so the bytes under test are the bytes this project emits. Nothing
// reads a fixture off disk: a check is only meaningful if the archive that
// triggers it can be constructed exactly, and a shared fixture tree drifts from
// the assertions that depend on it.

const A_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** Two calibration points far enough apart to clear MIN_DPT at HO. */
const CALIBRATED = [
  { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
  { px: { x: 1000, y: 0 }, world: { x: 800, y: 0, z: 0 } },
];

interface Build {
  id?: string | null;
  calibration?: typeof CALIBRATED | [];
  labels?: Record<string, unknown>[];
  complete?: boolean;
  images?: number;
  extraEntry?: string;
  missingImage?: boolean;
}

async function build(path: string, opts: Build = {}): Promise<ArchiveInput> {
  const archive = new R49Archive();
  const count = opts.images ?? 1;
  const images = Array.from({ length: count }, (_, i) => ({
    filename: `img_${i}.jpg`,
    labeled_complete: opts.complete ?? true,
    labels: i === 0 ? (opts.labels ?? []) : [],
  }));

  // Typed `unknown` on the way in: several tests build labels the schema
  // rejects, which is the point, and a cast from a well-typed literal would
  // not compile.
  const manifest: unknown = {
    version: 4,
    ...(opts.id === null ? {} : { id: opts.id ?? 'aBcDeFgHiJk' }),
    layout: {
      scale: 'HO',
      calibration: { points: opts.calibration ?? CALIBRATED },
      sensors: [],
    },
    camera: { resolution: { width: 1920, height: 1080 } },
    images,
  };
  archive.setManifest(manifest as ManifestData);

  if (!opts.missingImage) {
    for (let i = 0; i < count; i++) await archive.addImage(`img_${i}.jpg`, A_JPEG);
  }
  if (opts.extraEntry) await archive.addImage(opts.extraEntry, A_JPEG);
  // addImage appends a manifest entry, which is exactly what makes it *not*
  // orphaned — remove the entry again so the zip carries a file nothing names.
  if (opts.extraEntry) {
    const manifest = archive.getManifest();
    manifest.images = manifest.images.filter(img => img.filename !== opts.extraEntry);
  }

  return { path, bytes: await archive.export() };
}

/**
 * A valid v4 archive carrying no `id`, assembled zip-first.
 *
 * `R49Archive` cannot make one — `saveManifest` mints on every write — so the
 * only way to exercise check 5 is to write `manifest.json` directly.
 */
async function idlessArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      version: 4,
      layout: { scale: 'HO', calibration: { points: CALIBRATED }, sensors: [] },
      camera: { resolution: { width: 1920, height: 1080 } },
      images: [{ filename: 'img_0.jpg', labeled_complete: true, labels: [] }],
    })
  );
  zip.file('img_0.jpg', A_JPEG);
  return await zip.generateAsync({ type: 'uint8array' });
}

const car = (over: Record<string, unknown> = {}) => ({
  id: 'car-1',
  class: 'stock',
  p0: { x: 10, y: 20 },
  p1: { x: 110, y: 25 },
  provenance: 'human',
  ...over,
});

/** The one report produced for a single submitted archive. */
async function reportFor(input: ArchiveInput, author: string | null = 'alice') {
  const report = await validate([input], { author });
  return report.archives[0];
}

const codes = (findings: readonly { code: string }[]) => findings.map(f => f.code);

describe('validate', () => {
  describe('the blocking bar under archives/', () => {
    it('passes a well-formed submission with no findings at all', async () => {
      const result = await reportFor(await build('archives/alice/west-yard.r49', {
        labels: [car()],
      }));

      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.scope).toBe('archives');
    });

    it('reports bytes that are not a v4 archive as one load failure', async () => {
      const result = await reportFor({
        path: 'archives/alice/west-yard.r49',
        bytes: new Uint8Array([1, 2, 3, 4]),
      });

      expect(codes(result.errors)).toEqual(['archive/load']);
      // The facts are unknown, not zero — a row still exists for the file.
      expect(result.images).toBeNull();
      expect(result.id).toBeNull();
    });

    it('blocks a manifest naming an image the archive does not carry', async () => {
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', { missingImage: true })
      );
      expect(codes(result.errors)).toContain('images/missing');
    });

    it('blocks an image nobody references', async () => {
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', { extraEntry: 'stray.jpg' })
      );
      expect(codes(result.errors)).toContain('images/orphan');
    });

    it('blocks an untouched proposal, and accepts a corrected one', async () => {
      const proposed = await reportFor(
        await build('archives/alice/west-yard.r49', {
          labels: [car({ provenance: 'proposed', proposed_by: 'v1.0.0' })],
        })
      );
      expect(codes(proposed.errors)).toContain('labels/provenance');

      const corrected = await reportFor(
        await build('archives/alice/west-yard.r49', {
          labels: [car({ provenance: 'corrected', proposed_by: 'v1.0.0' })],
        })
      );
      // Assisted labeling must survive the corpus, or #13's payoff dies here.
      expect(corrected.errors).toEqual([]);
    });

    it('blocks a class outside the vocabulary, segment by segment', async () => {
      const unknown = await reportFor(
        await build('archives/alice/west-yard.r49', { labels: [car({ class: 'stockyard' })] })
      );
      expect(codes(unknown.errors)).toContain('labels/class');
      // #187: the message must send the contributor to where the vocabulary lives.
      const message = unknown.errors.find(e => e.code === 'labels/class')!.message;
      expect(message).toContain('lib/r49/r49.json');
      expect(message).not.toContain('config.yaml');

      const nested = await reportFor(
        await build('archives/alice/west-yard.r49', {
          labels: [car({ class: 'stock.loco.steam' })],
        })
      );
      expect(nested.errors).toEqual([]);
    });

    it('blocks an archive with no id', async () => {
      // Built by hand, because R49Archive can no longer produce one: every
      // export() mints an id when the manifest lacks one. So this check fires
      // only for a hand-assembled archive or one written by a build predating
      // that change — which is exactly the population it is aimed at, and the
      // reason the fix in the message is "open it and save".
      const result = await reportFor({
        path: 'archives/alice/west-yard.r49',
        bytes: await idlessArchive(),
      });

      expect(codes(result.errors)).toEqual(['archive/id']);
      expect(result.id).toBeNull();
      // The rest of the archive is fine, so nothing else fires.
      expect(result.warnings).toEqual([]);
    });

    it('blocks two archives in one directory sharing an id', async () => {
      const report = await validate(
        [
          await build('archives/alice/west-yard.r49', { id: 'sameIdHere' }),
          await build('archives/alice/east-yard.r49', { id: 'sameIdHere' }),
        ],
        { author: 'alice' }
      );

      expect(codes(report.archives[0].errors)).toEqual([]);
      expect(codes(report.archives[1].errors)).toContain('archive/id-collision');
      expect(report.ok).toBe(false);
    });

    it('leaves the same id in two different directories alone', async () => {
      // The cross-contributor fork case is deliberately un-designed-for.
      const report = await validate(
        [
          await build('archives/alice/west-yard.r49', { id: 'sameIdHere' }),
          await build('archives/bob/west-yard.r49', { id: 'sameIdHere' }),
        ],
        { author: null }
      );

      expect(report.ok).toBe(true);
    });
  });

  describe('warnings, which never block', () => {
    it('warns below the minimum DPT without failing the run', async () => {
      const report = await validate(
        [
          await build('archives/alice/west-yard.r49', {
            // 10 px over 800 mm at HO is far below MIN_DPT.
            calibration: [
              { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
              { px: { x: 10, y: 0 }, world: { x: 800, y: 0, z: 0 } },
            ],
            labels: [car()],
          }),
        ],
        { author: 'alice' }
      );

      expect(codes(report.archives[0].warnings)).toContain('calibration/dpt');
      expect(report.archives[0].dpt).toBeLessThan(MIN_DPT);
      expect(report.ok).toBe(true);
    });

    it('warns when calibration does not resolve at all', async () => {
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', { calibration: [], labels: [car()] })
      );

      expect(codes(result.warnings)).toContain('calibration/unresolved');
      expect(result.dpt).toBeNull();
      expect(result.errors).toEqual([]);
    });

    it('warns when points off the reference plane are left out of the fit', async () => {
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', {
          calibration: [...CALIBRATED, { px: { x: 0, y: 500 }, world: { x: 0, y: 400, z: 85 } }],
          labels: [car()],
        })
      );

      const warning = result.warnings.find(w => w.code === 'calibration/off-reference-plane');
      expect(warning?.message).toContain('1 calibration point sits off the plane');
      expect(result.errors).toEqual([]);
    });

    it('warns about incomplete images', async () => {
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', { complete: false, images: 3 })
      );

      expect(codes(result.warnings)).toContain('images/incomplete');
      expect(result.incomplete).toBe(3);
    });

    it('says nothing about a complete image with zero labels', async () => {
      // An all-background sample is exactly what the corpus wants, and an
      // earlier candidate check would have warned on the good case.
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', { labels: [], complete: true })
      );

      expect(result.warnings).toEqual([]);
      expect(result.labels).toBe(0);
    });
  });

  // #182: the conformance cases and the Python reader agree on *why* an archive
  // was refused through the rule id, so every blocking error carries one from
  // @occupancy/r49's closed set — and the JSON on stdout is where they read it.
  describe('every blocking error names the rule it broke', () => {
    /** A zip whose manifest.json is exactly this object, with one image. */
    async function rawArchive(manifest: unknown): Promise<Uint8Array> {
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify(manifest));
      zip.file('img_0.jpg', A_JPEG);
      return await zip.generateAsync({ type: 'uint8array' });
    }

    const v4 = {
      version: 4,
      id: 'aBcDeFgHiJk',
      layout: { scale: 'HO', calibration: { points: CALIBRATED }, sensors: [] },
      camera: { resolution: { width: 1920, height: 1080 } },
      images: [{ filename: 'img_0.jpg', labeled_complete: true, labels: [] }],
    };

    const rulesOf = (findings: readonly { rule: string }[]) => findings.map(f => f.rule);

    it('names which format rule a load failure broke, under the one archive/load code', async () => {
      const cases: Array<[Uint8Array, string]> = [
        [new Uint8Array([1, 2, 3, 4]), 'archive/not-zip'],
        [await rawArchive({ ...v4, version: 3 }), 'manifest/version'],
        [await rawArchive({ ...v4, vendor_extra: 1 }), 'manifest/unknown-key'],
        [
          await rawArchive({
            ...v4,
            layout: { ...v4.layout, sensors: [{ id: 's', x: 0, y: 0 }, { id: 's', x: 1, y: 1 }] },
          }),
          'manifest/duplicate-id',
        ],
      ];

      for (const [bytes, rule] of cases) {
        const result = await reportFor({ path: 'archives/alice/west-yard.r49', bytes });
        expect(codes(result.errors), rule).toEqual(['archive/load']);
        expect(rulesOf(result.errors), rule).toEqual([rule]);
      }
    });

    it('names the rule for every other blocking error, all from the closed set', async () => {
      const report = await validate(
        [
          await build('archives/alice/Bad Name.r49', { missingImage: true }),
          await build('archives/bob/west-yard.r49', { extraEntry: 'stray.jpg' }),
          await build('archives/alice/proposals.r49', {
            labels: [car({ provenance: 'proposed', proposed_by: 'v1', class: 'stockyard' })],
          }),
          { path: 'archives/alice/no-id.r49', bytes: await idlessArchive() },
          await build('archives/alice/twin-a.r49', { id: 'sameIdHere' }),
          await build('archives/alice/twin-b.r49', { id: 'sameIdHere' }),
          await build('elsewhere.r49'),
        ],
        { author: 'alice' }
      );

      const errors = report.archives.flatMap(a => a.errors);
      expect(new Set(rulesOf(errors))).toEqual(
        new Set([
          'path/slug',
          'images/missing',
          'path/owner',
          'images/orphan',
          'labels/provenance',
          'labels/class',
          'archive/id',
          'archive/id-collision',
          'path/shape',
        ])
      );
      for (const error of errors) expect(RULES).toContain(error.rule);
    });

    it('carries the rule into the JSON the corpus workflow reads', async () => {
      const report = await validate([
        {
          path: 'archives/alice/west-yard.r49',
          bytes: await rawArchive({ ...v4, version: 3 }),
        },
      ]);

      // Exactly what cli.ts writes to stdout.
      const json = JSON.parse(JSON.stringify(report, null, 2));
      expect(json.archives[0].errors[0].rule).toBe('manifest/version');
    });
  });

  describe('fixtures/ gets a thinner bar', () => {
    it('holds a fixture to structure only, with no warnings', async () => {
      const result = await reportFor(
        await build('fixtures/cars-0-10.r49', {
          id: null,
          calibration: [],
          complete: false,
          labels: [],
        })
      );

      // No id, no calibration, nothing marked complete — every one of which is
      // a finding under archives/, and none of which is one here.
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.scope).toBe('fixtures');
    });

    it('still requires a fixture to load and to name its images', async () => {
      const result = await reportFor(
        await build('fixtures/cars-0-10.r49', { id: null, extraEntry: 'stray.jpg' })
      );
      expect(codes(result.errors)).toContain('images/orphan');
    });
  });

  describe('facts, which the summary table renders', () => {
    it('counts images, labels and completeness, and reports the residual', async () => {
      const result = await reportFor(
        await build('archives/alice/west-yard.r49', {
          images: 2,
          complete: false,
          labels: [car(), car({ id: 'car-2' })],
        })
      );

      expect(result.images).toBe(2);
      expect(result.labels).toBe(2);
      expect(result.complete).toBe(0);
      expect(result.incomplete).toBe(2);
      expect(result.id).toBe('aBcDeFgHiJk');
      // Two points make exactly one pair, which reproduces itself: no residual.
      expect(result.dptResidual).toBeNull();
    });
  });
});
