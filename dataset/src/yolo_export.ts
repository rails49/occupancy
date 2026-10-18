import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { DETECTOR_CLASSES, DETECTOR_VAL_SPLIT } from '@occupancy/config';
import { carWidthPx, detectorClassIndex, spanToPolygon } from '@occupancy/detector';
import { R49Archive, getDPT } from '@rails49/r49';
import { labelLine, outputStem, splitFor, type Split } from './yolo_rules.ts';

/**
 * Derives the Ultralytics OBB dataset layout from a directory of `.r49`
 * archives — directly, with no intermediate database.
 *
 *     images/{train,val}/<archive>__<image>.jpeg
 *     labels/{train,val}/<archive>__<image>.txt
 *     data.yaml
 *
 * See SPEC.md § YOLO annotations. The one hard gate is `labeled_complete`: an
 * image whose labeling a human has not vouched for is skipped whole, because a
 * single unlabeled car in an exported frame teaches the detector that cars are
 * background, and that loss is shared across the image so it cannot be scoped
 * away per class. Everything else that could drop a car is fatal instead.
 *
 * This is **not** a revival of the parked CNN crop prep. That derivation is
 * blocked on a vocabulary v4 cannot produce; this one needs nothing v4 does not
 * already store.
 */

const USAGE = `Usage: pnpm --filter dataset run export:yolo -- [--in <dir>] [--out <dir>]

  --in   Directory of .r49 archives, scanned recursively. Default: ./r49
         (a checkout of https://github.com/rails49/r49 works as-is)
  --out  Dataset root to write. Default: ./yolo — gitignored, and replaced
         wholesale on every run.
`;

interface Options {
  readonly inDir: string;
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): Options {
  let inDir = 'r49';
  let outDir = 'yolo';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // pnpm passes its own `--` separator through to the script.
      continue;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--in') {
      inDir = argv[++i] ?? fail(`--in needs a directory\n\n${USAGE}`);
    } else if (arg === '--out') {
      outDir = argv[++i] ?? fail(`--out needs a directory\n\n${USAGE}`);
    } else {
      fail(`unrecognized argument ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
  }

  return { inDir: path.resolve(inDir), outDir: path.resolve(outDir) };
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Every `.r49` under `dir`, in sorted order so a run is reproducible.
 *
 * Recursive because the corpus keeps its archives one level down, in
 * `fixtures/` — pointing `--in` at a checkout root has to work.
 *
 * `Dirent.parentPath` carries the containing directory, and was named `path`
 * before Node 20.12. @types/node no longer declares the old name, but the
 * runtime pinned here still only emits it, so both are read: taking the new
 * name alone loses the subdirectory **silently**, exporting nothing and
 * reporting no error, rather than failing.
 */
async function findArchives(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.r49'))
    .map(e => path.join(e.parentPath ?? (e as { path?: string }).path ?? dir, e.name))
    .sort();
}

/**
 * Empties the output directory, refusing anything that is not obviously a
 * previous export.
 *
 * Stale files left from an earlier run would be trained on — Ultralytics reads
 * whatever is in `images/`, not whatever this run wrote — so the tree has to be
 * replaced rather than merged into. The `data.yaml` check is what keeps a
 * mistyped `--out` from deleting a directory that was never ours.
 */
async function resetOutDir(outDir: string): Promise<void> {
  const existing = await fs.readdir(outDir).catch(() => null);
  if (existing === null) {
    await fs.mkdir(outDir, { recursive: true });
    return;
  }
  if (existing.length > 0 && !existing.includes('data.yaml')) {
    fail(
      `refusing to replace ${outDir}: it is not empty and holds no data.yaml, so it ` +
        `is not a previous export. Point --out somewhere else, or empty it yourself.`
    );
  }
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
}

interface Tally {
  archives: number;
  imagesExported: number;
  imagesSkipped: number;
  cars: number;
  emptyFrames: number;
  cornersClamped: number;
  readonly perSplit: Record<Split, number>;
  readonly warnings: string[];
}

async function exportArchive(file: string, outDir: string, tally: Tally): Promise<void> {
  const archiveName = path.basename(file, '.r49');
  const archive = await R49Archive.load(await fs.readFile(file));
  const manifest = archive.getManifest();

  // Width comes from DPT, so an uncalibrated archive has no derivable box at
  // all. Fatal rather than skipped: silently exporting five of six archives is
  // how a training run ends up quietly smaller than the corpus it named.
  const dpt = getDPT(manifest);
  if (dpt === null) {
    fail(
      `${archiveName}: no DPT — its calibration has no pair of points at equal height, ` +
        `so car width cannot be derived. Calibrate it in the editor, or move it out of --in.`
    );
  }
  const widthPx = carWidthPx(dpt);
  const frame = manifest.camera.resolution;

  for (const image of manifest.images) {
    if (!image.labeled_complete) {
      tally.imagesSkipped++;
      continue;
    }

    const bytes = await archive.getImage(image.filename);
    if (bytes === null) {
      fail(`${archiveName}: manifest names ${image.filename}, which the archive does not contain`);
    }

    // Labels are authored in the camera frame, so that is what normalizes
    // them. A decoded size that disagrees means the two have come apart and
    // every box in this image is scaled wrong — worth saying loudly, but not
    // worth failing on: the frozen v4 test fixture pairs a real declared
    // resolution with a 1x1 placeholder image on purpose.
    const decoded = await sharp(Buffer.from(bytes)).metadata();
    if (decoded.width !== frame.width || decoded.height !== frame.height) {
      tally.warnings.push(
        `${archiveName}/${image.filename}: camera.resolution is ${frame.width}x${frame.height} ` +
          `but the image decodes as ${decoded.width}x${decoded.height}; labels were normalized ` +
          `against camera.resolution`
      );
    }

    const lines: string[] = [];
    for (const label of image.labels) {
      const classIndex = detectorClassIndex(label.class);
      if (classIndex === null) {
        fail(
          `${archiveName}/${image.filename}: label ${label.id} has class ` +
            `${JSON.stringify(label.class)}, which no entry of detector.classes ` +
            `[${DETECTOR_CLASSES.join(', ')}] is a segment-prefix of. Dropping it would ` +
            `train this car as background — fix the class, or append its root to ` +
            `detector.classes in config.yaml and regenerate.`
        );
      }

      const { corners, clamped } = spanToPolygon(label, widthPx, frame);
      tally.cornersClamped += clamped;
      lines.push(labelLine(classIndex, corners));
      tally.cars++;
    }

    // An empty label file is not a mistake here. `labeled_complete` on a frame
    // with no cars is a human asserting it is all background, which is exactly
    // the negative a detector wants.
    if (lines.length === 0) tally.emptyFrames++;

    const split = splitFor(archiveName, image.filename, DETECTOR_VAL_SPLIT);
    const stem = outputStem(archiveName, image.filename);
    const ext = path.extname(image.filename) || '.jpg';

    await fs.writeFile(path.join(outDir, 'images', split, `${stem}${ext}`), bytes);
    await fs.writeFile(
      path.join(outDir, 'labels', split, `${stem}.txt`),
      lines.length > 0 ? `${lines.join('\n')}\n` : ''
    );

    tally.perSplit[split]++;
    tally.imagesExported++;
  }

  tally.archives++;
}

/** `data.yaml`, the file Ultralytics is actually pointed at. */
function renderDataYaml(outDir: string): string {
  const names = DETECTOR_CLASSES.map((name, i) => `  ${i}: ${name}`).join('\n');
  return [
    '# GENERATED by dataset/src/yolo_export.ts — do not edit.',
    '#',
    '# Derived from .r49 archives; regenerate rather than patching. `path` is',
    '# absolute because Ultralytics resolves a relative one against its own',
    '# settings directory, not against this file.',
    '#',
    '# ⚠️  The class list is APPEND-ONLY (config.yaml § detector.classes): an',
    '# index here is a position in trained weights.',
    '',
    `path: ${outDir}`,
    'train: images/train',
    'val: images/val',
    '',
    'names:',
    names,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const { inDir, outDir } = parseArgs(process.argv.slice(2));

  const archives = await findArchives(inDir).catch(() => {
    fail(`cannot read ${inDir}. Pass --in <dir> pointing at a directory of .r49 archives.`);
  });
  if (archives.length === 0) {
    fail(`no .r49 archives under ${inDir}`);
  }

  await resetOutDir(outDir);
  for (const split of ['train', 'val'] as const) {
    await fs.mkdir(path.join(outDir, 'images', split), { recursive: true });
    await fs.mkdir(path.join(outDir, 'labels', split), { recursive: true });
  }

  const tally: Tally = {
    archives: 0,
    imagesExported: 0,
    imagesSkipped: 0,
    cars: 0,
    emptyFrames: 0,
    cornersClamped: 0,
    perSplit: { train: 0, val: 0 },
    warnings: [],
  };

  for (const file of archives) {
    await exportArchive(file, outDir, tally);
  }

  await fs.writeFile(path.join(outDir, 'data.yaml'), renderDataYaml(outDir));

  for (const warning of tally.warnings) {
    console.warn(`⚠️  ${warning}`);
  }

  console.log(
    [
      `Exported ${tally.imagesExported} images (${tally.cars} cars) from ${tally.archives} archives.`,
      `  train ${tally.perSplit.train} / val ${tally.perSplit.val}`,
      `  ${tally.imagesSkipped} images skipped: not labeled_complete`,
      `  ${tally.emptyFrames} exported frames carry no cars (all-background samples)`,
      `  ${tally.cornersClamped} corners clamped to the frame edge`,
      `  → ${path.join(outDir, 'data.yaml')}`,
    ].join('\n')
  );

  // A run that produced no validation images is not a smaller dataset, it is a
  // broken one — Ultralytics has nothing to score epochs against. Louder here
  // than a stack trace three minutes into training.
  for (const split of ['train', 'val'] as const) {
    if (tally.perSplit[split] === 0) {
      fail(
        `the ${split} split is empty. With ${tally.imagesExported} images and a ` +
          `val_split of ${DETECTOR_VAL_SPLIT}, every image hashed to the other side — ` +
          `export more archives, or change detector.val_split in config.yaml.`
      );
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
