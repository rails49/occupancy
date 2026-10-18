import { calibrationFit, type ManifestData } from '@occupancy/r49';

/**
 * The layout metadata an archive must carry before it can be authored, and the
 * one place the list is declared.
 *
 * Decided on [#139](https://github.com/rails49/occupancy/issues/139). `SPEC.md`
 * § Camera height carries the reasoning; the short version is that
 * `camera_height_mm` costs one tape measurement per layout, cannot be
 * recovered later once the camera has moved, and is the difference between
 * archives whose DPT is comparable across contributors and archives whose DPT
 * is up to ~9% apart depending on which plane someone happened to calibrate on.
 *
 * **Enforcement is here and not in the schema.** A required *field* would fail
 * every archive that predates it — the orphan-everything cost of a version bump
 * arriving by another road. A required *dialog* migrates an archive on its
 * first edit and orphans nothing, which is the `.optional()`-plus-a-gate shape
 * `@occupancy/r49` was given.
 *
 * Adding a requirement is one entry in {@link missingLayoutMetadata}.
 */
export interface MissingRequirement {
  /** Stable machine name, safe to match on. Human text may be reworded. */
  readonly field: 'name' | 'camera_height_mm';
  /** One sentence, addressed to the author, naming what to supply. */
  readonly message: string;
}

/**
 * What this layout still owes before it can be authored, in the order the
 * settings dialog presents its fields. Empty means the gate is satisfied.
 *
 * `scale` is deliberately absent: the schema requires it, so it is never
 * missing. A new archive is created with a placeholder, and the gate still
 * shows the dialog then — because a new archive has no camera height — which is
 * where a wrong scale gets seen and corrected. There is no representable
 * difference between "scale the user confirmed" and "scale the app invented",
 * and inventing one (a `scale_confirmed` flag) would be a field the format does
 * not need.
 */
export function missingLayoutMetadata(
  manifest: ManifestData | null | undefined,
): MissingRequirement[] {
  if (!manifest) return [];
  const { layout } = manifest;
  const missing: MissingRequirement[] = [];

  if (!layout.name?.trim()) {
    missing.push({
      field: 'name',
      message: 'Give the layout a name — it identifies the archive wherever it is listed.',
    });
  }

  const h = layout.calibration?.camera_height_mm;
  if (h === undefined) {
    missing.push({
      field: 'camera_height_mm',
      message:
        'Measure the camera height above layout zero, in mm. Scale varies with height, ' +
        'so without it DPT describes only the plane the calibration points sit on.',
    });
  } else {
    // The one cross-field rule, and the reason it is worth having: a
    // single-plane calibration makes the fit residual structurally blind to a
    // decimal or unit slip, because a pair at the reference plane normalizes by
    // 1 whatever the height is. This bound is what catches 115 for 1150.
    const fit = calibrationFit(manifest);
    if (!fit.cameraHeightFits) {
      const tallest = Math.max(
        ...fit.leftOut.filter(l => l.reason === 'above-camera').map(l => l.point.world.z),
      );
      missing.push({
        field: 'camera_height_mm',
        message:
          `The camera must be above the layout: ${formatMM(h)} is not more than the ` +
          `tallest calibration point at ${formatMM(tallest)}. Check the units.`,
      });
    }
  }

  return missing;
}

/** Millimetres, without a trailing `.0` on whole numbers. */
function formatMM(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} mm`;
}
