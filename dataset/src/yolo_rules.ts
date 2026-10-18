import crypto from 'node:crypto';
import path from 'node:path';
import { DETECTOR_CLASSES, DETECTOR_VAL_SPLIT } from '@occupancy/config';
import { carWidthPx, detectorClassIndex, spanToPolygon } from '@occupancy/detector';
import { getDPT, type ManifestData } from '@rails49/r49';

/**
 * The rules of the YOLO OBB export, with no filesystem in it.
 *
 * `planArchive` decides everything about one archive — which images go, to
 * which split, under which stem, with which label lines, what to warn about,
 * and what is fatal — and `yolo_export.ts` only walks directories and writes
 * what it is handed. The image decoder is a parameter, so a test can state a
 * decoded size without `sharp` and the rules are pinned by assertions rather
 * than by a run over a corpus.
 *
 * The one hard gate is `labeled_complete`: an image whose labeling a human has
 * not vouched for is skipped whole, because a single unlabeled car in an
 * exported frame teaches the detector that cars are background, and that loss
 * is shared across the image so it cannot be scoped away per class. Everything
 * else that could drop a car is fatal instead.
 *
 * The car box itself is **not** here. `carWidthPx` and `spanToPolygon` are
 * `@occupancy/detector`'s, which is the only way the UI's archive diagnostics
 * can draw ground truth in the browser — this module imports `node:crypto` at
 * the top for the split — and the only way the width constant that biases
 * boxes toward `occupied` has one home rather than two.
 */

/** Which side of the split an image falls on. */
export type Split = 'train' | 'val';

/** The size an image decodes to, in pixels. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Decodes the named image far enough to know its size.
 *
 * @returns `null` when the archive does not carry the image.
 */
export type ImageDecoder = (filename: string) => Promise<ImageSize | null>;

/** What the export does with one manifest image. */
export type ImagePlan =
  | {
      /** Not `labeled_complete`: left out whole. */
      readonly kind: 'skipped';
      readonly filename: string;
    }
  | {
      readonly kind: 'exported';
      readonly filename: string;
      readonly split: Split;
      /** Shared by the image file and its label file; Ultralytics pairs them by it. */
      readonly stem: string;
      /** The image file's extension, dot included. */
      readonly ext: string;
      /** One per car. Empty is an all-background sample, not a mistake. */
      readonly lines: readonly string[];
      /** Corners `spanToPolygon` moved onto the frame edge. */
      readonly cornersClamped: number;
      readonly warnings: readonly string[];
    }
  | {
      /** Exporting it would drop a car, or it cannot be exported at all. */
      readonly kind: 'fatal';
      readonly filename: string;
      readonly reasons: readonly string[];
    };

/** What the export does with one archive. */
export type ArchivePlan =
  | { readonly kind: 'planned'; readonly images: readonly ImagePlan[] }
  | {
      /** Nothing in the archive can be exported, whatever its images hold. */
      readonly kind: 'fatal';
      readonly reason: string;
    };

/**
 * The export of one archive, decided without writing anything.
 *
 * Images are planned in manifest order, and every fatal image is reported
 * rather than only the first, so one run names every fix an archive needs.
 * Skipped images are not decoded.
 *
 * @param archiveName The archive's basename without `.r49`; it qualifies every
 *        stem and keys the split.
 * @param valSplit The fraction hashed to `val`. Defaults to
 *        `detector.val_split`.
 */
export async function planArchive(
  archiveName: string,
  manifest: ManifestData,
  decode: ImageDecoder,
  valSplit: number = DETECTOR_VAL_SPLIT
): Promise<ArchivePlan> {
  // Width comes from DPT, so an uncalibrated archive has no derivable box at
  // all. Fatal rather than skipped: silently exporting five of six archives is
  // how a training run ends up quietly smaller than the corpus it named.
  const dpt = getDPT(manifest);
  if (dpt === null) {
    return {
      kind: 'fatal',
      reason:
        `${archiveName}: no DPT — its calibration has no pair of points at equal height, ` +
        `so car width cannot be derived. Calibrate it in the editor, or move it out of --in.`,
    };
  }
  const widthPx = carWidthPx(dpt);
  const frame = manifest.camera.resolution;

  const images: ImagePlan[] = [];
  for (const image of manifest.images) {
    const { filename } = image;
    if (!image.labeled_complete) {
      images.push({ kind: 'skipped', filename });
      continue;
    }

    const where = `${archiveName}/${filename}`;
    const reasons: string[] = [];
    const warnings: string[] = [];

    const decoded = await decode(filename);
    if (decoded === null) {
      reasons.push(`${archiveName}: manifest names ${filename}, which the archive does not contain`);
    } else if (decoded.width !== frame.width || decoded.height !== frame.height) {
      // Labels are authored in the camera frame, so that is what normalizes
      // them. A decoded size that disagrees means the two have come apart and
      // every box in this image is scaled wrong — worth saying loudly, but not
      // worth failing on: the frozen v4 test fixture pairs a real declared
      // resolution with a 1x1 placeholder image on purpose.
      warnings.push(
        `${where}: camera.resolution is ${frame.width}x${frame.height} ` +
          `but the image decodes as ${decoded.width}x${decoded.height}; labels were normalized ` +
          `against camera.resolution`
      );
    }

    const lines: string[] = [];
    let cornersClamped = 0;
    for (const label of image.labels) {
      const classIndex = detectorClassIndex(label.class);
      if (classIndex === null) {
        reasons.push(
          `${where}: label ${label.id} has class ` +
            `${JSON.stringify(label.class)}, which no entry of detector.classes ` +
            `[${DETECTOR_CLASSES.join(', ')}] is a segment-prefix of. Dropping it would ` +
            `train this car as background — fix the class, or append its root to ` +
            `detector.classes in config.yaml and regenerate.`
        );
        continue;
      }

      let box: ReturnType<typeof spanToPolygon>;
      try {
        box = spanToPolygon(label, widthPx, frame);
      } catch (err) {
        reasons.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      cornersClamped += box.clamped;
      lines.push(labelLine(classIndex, box.corners));
    }

    if (reasons.length > 0) {
      images.push({ kind: 'fatal', filename, reasons });
      continue;
    }

    images.push({
      kind: 'exported',
      filename,
      split: splitFor(archiveName, filename, valSplit),
      stem: outputStem(archiveName, filename),
      ext: path.extname(filename) || '.jpg',
      lines,
      cornersClamped,
      warnings,
    });
  }

  return { kind: 'planned', images };
}

/** One label file line: the class index, then the eight normalized corners. */
function labelLine(classIndex: number, corners: readonly number[]): string {
  // Six decimals is ~0.01 px at 1920 wide — below what anyone can click, and
  // short enough that the label files stay readable.
  return [classIndex, ...corners.map(c => c.toFixed(6))].join(' ');
}

/**
 * The split an image belongs to, decided by a hash of its identity rather than
 * by counting.
 *
 * Deterministic in the archive and filename alone, so re-exporting never
 * reshuffles, adding an archive never moves an existing image, and two machines
 * exporting the same corpus agree. This is the discipline the retired crop
 * pipeline used, moved up one level: it keyed on the individual marker, and the
 * unit here is the **image**, because two cars in one frame must not land on
 * opposite sides.
 */
function splitFor(archive: string, filename: string, valSplit: number): Split {
  const digest = crypto.createHash('md5').update(`${archive}:${filename}`).digest('hex');
  const bucket = parseInt(digest.slice(0, 8), 16) % 100;
  return bucket < valSplit * 100 ? 'val' : 'train';
}

/**
 * The output stem for an image, qualified by its archive.
 *
 * Every archive in the corpus names its images `image-0.jpeg`, so the archive
 * has to be in the name or the sixth `image-0` silently overwrites the first
 * five. Ultralytics pairs a label to its image by stem, so both files take this
 * one.
 */
function outputStem(archive: string, filename: string): string {
  const imageStem = filename.replace(/\.[^./\\]+$/, '');
  return `${sanitize(archive)}__${sanitize(imageStem)}`;
}

/** Anything that is not a filename character, collapsed to `-`. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-');
}
