import { DETECTOR_CLASSES } from '@occupancy/config';
import { isSegmentPrefix } from '@rails49/r49';

/** The YOLO class list. A separate name so the default is legible. */
const CLASSES: readonly string[] = DETECTOR_CLASSES;

/**
 * The YOLO class index a stored class trains as: the position of the **longest**
 * entry of `detector.classes` that is a segment-prefix of it.
 *
 * Here rather than in `@rails49/r49` because the class list is this
 * project's, not the format's: an archive's `class` is read against the
 * vocabulary, which the format owns, and trained as an index into
 * `detector.classes`, which only the detector does. The segment-prefix rule is
 * the format's, and is imported rather than restated so the two readings of a
 * class cannot drift.
 *
 * Longest, not first, is what makes the class list append-only in a useful way.
 * Appending `stock.loco` re-maps every already-labeled locomotive onto the new
 * index with no relabeling, because `stock.loco` outranks the `stock` that used
 * to claim them — while a car labeled plain `stock` keeps matching `stock`.
 *
 * @param cls The stored `class` string, rooted and dot-separated.
 * @param classes Defaults to the authored class list; injectable for tests.
 * @returns The index, or `null` when no entry prefixes the class. `null` is a
 *          **fatal export error**, never a drop: an unexported car is an
 *          unlabeled car, which teaches the detector that cars are background.
 */
export function detectorClassIndex(cls: string, classes: readonly string[] = CLASSES): number | null {
  let index: number | null = null;
  let matched = -1;

  classes.forEach((entry, i) => {
    if (!isSegmentPrefix(entry, cls)) return;
    // Two entries that both prefix one class are nested, so the longer string
    // is unambiguously the more specific of the two.
    if (entry.length <= matched) return;
    index = i;
    matched = entry.length;
  });

  return index;
}
