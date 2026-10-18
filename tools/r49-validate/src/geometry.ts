import type { ManifestData } from '@occupancy/r49';

/**
 * A prototype freight car's height above railhead over its width — the only
 * shape constant obliquity inflation needs, and **scale-independent**: both
 * dimensions divide by the same ratio, so one number serves HO, N and Z alike.
 *
 * From a typical boxcar, ~15 ft rail-to-roof over 10 ft 6 in wide.
 */
const CAR_HEIGHT_OVER_WIDTH = 4570 / 3200;

/** Worst-case obliquity in degrees and what it does to apparent car width. */
export interface Obliquity {
  /** Angle off vertical at the furthest calibrated corner. */
  readonly degrees: number;
  /** Apparent width there, as a multiple of the nadir width. */
  readonly widthInflation: number;
}

/**
 * How obliquely this camera sees the far corner of what it calibrated, and how
 * much wider a car presents there than directly below.
 *
 * ```
 * θ         = atan(ρ_max / h)
 * inflation = 1 + (c/w)·tan θ
 * ```
 *
 * **Reported, never thresholded.** The geometry is quantified but its cost to
 * detection accuracy is unmeasured, so a bar here would be a number nothing
 * earned — the `dptResidual` precedent, and the substitute gate `SPEC.md`
 * § Accuracy warns against.
 *
 * Two approximations, both stated because neither is checkable from an archive:
 * the camera is assumed **over the centre** of the calibrated extent (nothing
 * records where it actually hangs), and the calibration points are taken to
 * span the area of interest — an archive calibrated on one small patch of a
 * large layout under-reports. Both make this a *lower* bound, which is the safe
 * direction for a fact nobody gates on.
 *
 * Worst case over car orientation: a car lying radially shows its end, not its
 * side.
 *
 * @returns `null` when no camera height is authored or fewer than two
 *          calibration points give the extent an obliquity would be measured
 *          across.
 */
export function obliquityOf(manifest: ManifestData): Obliquity | null {
  const { calibration } = manifest.layout;
  const h = calibration.camera_height_mm;
  if (h === undefined || calibration.points.length < 2) return null;

  const xs = calibration.points.map(p => p.world.x);
  const ys = calibration.points.map(p => p.world.y);
  const halfDiagonal =
    Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  if (halfDiagonal === 0) return null;

  const radians = Math.atan(halfDiagonal / h);
  return {
    degrees: (radians * 180) / Math.PI,
    widthInflation: 1 + CAR_HEIGHT_OVER_WIDTH * Math.tan(radians),
  };
}
