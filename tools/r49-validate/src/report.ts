/**
 * The one shape both surfaces read.
 *
 * A corpus PR is reported in two places — `::warning` annotations attached to
 * the archive's path, and a table on the run's job summary — and they must
 * never disagree about what was found. So the validator produces this, and the
 * workflow renders it twice. Nothing about GitHub appears below: the tool
 * decides what is true, the workflow decides how it is displayed.
 *
 * Blocking errors and warnings are separate fields rather than one list with a
 * severity, because the distinction is the whole point of the soft bar and a
 * workflow must not have to filter correctly to respect it.
 */

/** Which bar an archive is held to, decided by where it sits in the corpus. */
export type Scope =
  /** `archives/<handle>/<slug>.r49` — a contributor submission. Full bar. */
  | 'archives'
  /** `fixtures/<slug>.r49` — the six. Structure only, and no warnings. */
  | 'fixtures'
  /** Neither. A `.r49` somewhere the corpus layout does not define. */
  | 'unknown';

import type { Rule } from '@occupancy/r49';

/** One thing found, blocking or not. */
export interface Finding {
  /** Stable machine name, safe to match on. Human text may be reworded. */
  readonly code: string;
  /** One sentence, addressed to the contributor, naming the fix where there is one. */
  readonly message: string;
}

/**
 * A finding that blocks a submission, naming the rule it broke from
 * `@occupancy/r49`'s closed set (#182) — the id the conformance cases and the
 * Python reader agree on.
 *
 * `rule` and `code` coincide for every corpus rule. They differ for a load
 * failure: its `code` is `archive/load` for all of them, as before, and its
 * `rule` says which format rule refused the archive.
 */
export interface BlockingFinding extends Finding {
  readonly rule: Rule;
}

/**
 * Everything known about one archive: the facts for the summary table and the
 * findings for the annotations.
 *
 * The facts are present even when the archive failed to load — `path` and
 * `scope` always, the rest `null` — so a row exists for every file examined.
 * A table missing its worst row would be the wrong table.
 */
export interface ArchiveReport {
  readonly path: string;
  readonly scope: Scope;
  readonly id: string | null;
  /** Resolution in Dots Per Track, or `null` when calibration does not resolve. */
  readonly dpt: number | null;
  /**
   * The fit's disagreement in image pixels — **reported, never thresholded**.
   * It is the only signal that makes a mis-typed world coordinate visible
   * rather than absorbed into the scale, but no calibrated threshold exists and
   * inventing one here would put a number in the pipeline that nothing earned.
   */
  readonly dptResidual: number | null;
  /**
   * Camera height above layout zero in mm, or `null` when the archive does not
   * carry one — **reported, never required**. Every archive predates the field,
   * and blocking on it would reject real data with valid pixel-space labels for
   * a defect nothing has shown costs accuracy (#136, #139). The editor is where
   * it is required; here it is a fact a maintainer triaging a submission wants
   * at a glance.
   */
  readonly cameraHeightMM: number | null;
  /** Railhead height in mm — the plane DPT is reported at. `null` when unauthored (reads as 0). */
  readonly referenceHeightMM: number | null;
  /**
   * Worst-case obliquity in degrees, and the apparent car-width inflation that
   * follows from it — `null` unless a camera height and calibration extent make
   * them computable.
   *
   * The same `dptResidual` rule applies, and for the same reason: the geometry
   * is quantified but its cost to *accuracy* is unmeasured, so a threshold here
   * would be a number nothing earned. See `SPEC.md` § Camera height.
   */
  readonly obliquityDeg: number | null;
  readonly widthInflation: number | null;
  readonly images: number | null;
  readonly labels: number | null;
  readonly complete: number | null;
  readonly incomplete: number | null;
  readonly errors: readonly BlockingFinding[];
  readonly warnings: readonly Finding[];
}

/** The whole run. */
export interface Report {
  /** Bumped when a reader of the report would have to change. The workflow pins it. */
  readonly version: 1;
  readonly archives: readonly ArchiveReport[];
  /** True when no archive carries a blocking error. Warnings do not clear it. */
  readonly ok: boolean;
}

/** Whether a report passes the blocking bar. Warnings are not failures. */
export function isOk(archives: readonly ArchiveReport[]): boolean {
  return archives.every(a => a.errors.length === 0);
}
