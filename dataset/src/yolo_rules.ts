import crypto from 'node:crypto';

/**
 * The arithmetic of the YOLO OBB export, with no filesystem in it.
 *
 * Kept apart from `yolo_export.ts` because these are the parts worth pinning:
 * a class lookup and a split rule are each one assertion away from a test,
 * while reading a directory of archives is not. The script holds the I/O and
 * the reporting; everything a wrong number could hide in lives here.
 *
 * The car box itself is **not** here. `carWidthPx` and `spanToPolygon` moved
 * to `@occupancy/detector`, which is the only way the UI's archive diagnostics
 * can draw ground truth in the browser — this module imports `node:crypto` at
 * the top for `splitFor` — and the only way the width constant that biases
 * boxes toward `occupied` has one home rather than two.
 */

/** One label file line: the class index, then the eight normalized corners. */
export function labelLine(classIndex: number, corners: readonly number[]): string {
  // Six decimals is ~0.01 px at 1920 wide — below what anyone can click, and
  // short enough that the label files stay readable.
  return [classIndex, ...corners.map(c => c.toFixed(6))].join(' ');
}

/** Which side of the split an image falls on. */
export type Split = 'train' | 'val';

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
export function splitFor(archive: string, filename: string, valSplit: number): Split {
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
export function outputStem(archive: string, filename: string): string {
  const imageStem = filename.replace(/\.[^./\\]+$/, '');
  return `${sanitize(archive)}__${sanitize(imageStem)}`;
}

/** Anything that is not a filename character, collapsed to `-`. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-');
}
