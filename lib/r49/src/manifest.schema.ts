import { z } from 'zod';
import { STANDARD_GAUGE, SCALE_TO_RATIO, SCALES, type Scale } from './data.ts';

/**
 * Every valid scale name, in the order `r49.json` defines them.
 *
 * Read from the package's data file; no scale table is declared in code.
 */
export const VALID_SCALES: readonly Scale[] = SCALES;

/** A scale name — a key of `r49.json`'s `scale_to_ratio`. */
export type ValidScales = Scale;

/** Model-domain track gauge in mm (prototype gauge / scale ratio). Internal — the prototype domain is not part of the package's public contract. */
function getGaugeMM(scale: Scale): number {
  return STANDARD_GAUGE / SCALE_TO_RATIO[scale];
}

/**
 * Resolution in Dots Per Track (DPT): a least-squares scale fit over the
 * calibration pairs, normalized to layout zero by the camera height and
 * reported at the reference plane, converted to track widths.
 *
 * ```
 * pairs = { (i,j) : z_i == z_j,  i < j }
 * d_px' = d_px · (h − z)/h                      // camera height known
 * s     = Σ(d_px' · d_mm) / Σ(d_mm²)   over pairs
 * DPT   = s · gauge_mm(scale) · h/(h − z_ref)
 * ```
 *
 * **Why a height at all.** Layouts are not planar and cameras are not at
 * infinity, so under a pinhole camera at height `h` every length at height `z`
 * images `z/(h−z)` too large — 9.3% at track height under a 1 m camera. That
 * bias lands in DPT and so in car width, the drift tolerance, the `min_dpt`
 * gate and the resample factor. `h` removes it in closed form; focal length
 * cannot, because it cancels from the ratio. See `SPEC.md` § Camera height.
 *
 * **A pair still needs one height.** Both points of a pair must share `z`, and
 * that is not a simplification: two points at different heights sit at
 * different depths *and* different azimuths, so their pixel separation is not
 * any scale times any distance — recovering it would need the position model
 * deliberately not built (#135). What the camera height changes is that pairs
 * at *different* heights now combine correctly into one fit, each normalized to
 * layout zero, where before they either blended silently (a latent ~9% error)
 * or one plane's worth was all you could use.
 *
 * **Absent `h` the fit restricts to the reference plane** — "without a camera
 * height I can only speak about the plane you named" — and points off it stay
 * stored but inert. That is the historical behaviour for the single-plane
 * archives that are the only ones in existence, so it changes no number any of
 * them reports. `z` equality is exact: the values are typed by hand.
 *
 * The `d_mm²` weighting favours long baselines automatically, which is the
 * right bias — click error is a fixed number of pixels, so short baselines are
 * proportionally noisier. It matters twice here, because a wrong `h` is only
 * visible through pairs at two heights, and short baselines drown that signal.
 *
 * @returns DPT, or `null` when no usable pair with a nonzero separation exists
 *          — one rule covering the empty, single-point, off-reference-plane and
 *          coincident-point cases — or when the geometry is incoherent
 *          (`h` at or below the reference plane). `null` means "I cannot
 *          answer", not "zero".
 */
export function getDPT(manifest: ManifestData): number | null {
  const { calibration } = manifest.layout;
  const h = calibration.camera_height_mm;
  const zRef = calibration.reference_height_mm ?? 0;

  if (h !== undefined && h <= zRef) return null;

  const scale = fitScale(calibrationPairs(calibration));
  if (scale === null) return null;

  // Absent `h` the fit already sits on the reference plane; with it, the fit is
  // at layout zero and this lifts it to where the track is.
  const atReference = h === undefined ? scale : scale * (h / (h - zRef));
  return atReference * getGaugeMM(manifest.layout.scale);
}

/** One equal-height pair of calibration points, as the two separations the fit sees. */
interface CalibrationPair {
  /** Separation in image pixels, normalized to layout zero when the camera height is known. */
  readonly dPx: number;
  /** Separation on the layout, in mm. */
  readonly dMm: number;
}

/**
 * Every usable pair of calibration points, reduced to two separations.
 *
 * The one place the pair rule is applied. {@link getDPT} and
 * {@link getDPTResidual} must select and normalize the same pairs or the
 * residual would describe a fit nobody computed — which is also what makes the
 * residual validate the camera height for free: a wrong `h` normalizes pairs at
 * different heights inconsistently, and that disagreement is exactly what the
 * residual measures. It is blind when every point shares one height, because a
 * uniform scale bias is indistinguishable from a different camera distance.
 */
function calibrationPairs(calibration: ManifestData['layout']['calibration']): CalibrationPair[] {
  const h = calibration.camera_height_mm;
  const zRef = calibration.reference_height_mm ?? 0;
  const pairs: CalibrationPair[] = [];

  for (let i = 0; i < calibration.points.length; i++) {
    for (let j = i + 1; j < calibration.points.length; j++) {
      const a = calibration.points[i];
      const b = calibration.points[j];
      const z = a.world.z;
      if (b.world.z !== z) continue;
      // Without a camera height, only the named plane can be spoken about.
      if (h === undefined && z !== zRef) continue;
      // A point at or above the camera is not a pose the pinhole model has.
      if (h !== undefined && z >= h) continue;

      const dPx = Math.hypot(a.px.x - b.px.x, a.px.y - b.px.y);
      pairs.push({
        dPx: h === undefined ? dPx : dPx * ((h - z) / h),
        dMm: Math.hypot(a.world.x - b.world.x, a.world.y - b.world.y),
      });
    }
  }
  return pairs;
}

/**
 * The least-squares scale in **pixels per millimetre**, before the gauge turns
 * it into DPT: `Σ(d_px · d_mm) / Σ(d_mm²)`.
 *
 * `null` when the denominator is zero — no pair, or every pair zero millimetres
 * apart. Zero-separation pairs contribute nothing to either sum, so coincident
 * points land here rather than dividing by zero.
 */
function fitScale(pairs: readonly CalibrationPair[]): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const { dPx, dMm } of pairs) {
    numerator += dPx * dMm;
    denominator += dMm * dMm;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * How badly the calibration points disagree with the scale fitted through them:
 * the RMS of `d_px − s · d_mm` over the same pairs {@link getDPT} uses and with
 * the same height normalization applied, in **image pixels**.
 *
 * A mis-typed world coordinate is otherwise absorbed silently into `s`, which
 * shifts DPT and therefore every derived car width without anything looking
 * wrong. The residual is what makes it visible, so the editor shows it.
 *
 * It carries a second job once a camera height is authored: a wrong `h`
 * normalizes pairs at different heights inconsistently, so the same number
 * rises. Note the fit *refits* rather than holding a scale fixed, so the RMS
 * lands at roughly half the raw disagreement between planes — a 50% error in
 * `h` over 500 mm baselines at DPT 20 shows ~8 px, against a ~1.4 px click
 * floor. It stays **one number** — which fault it is, is the reader's — and it
 * is blind when every point shares a height, because a uniform scale bias is
 * indistinguishable from a different camera distance. A cross-check, never a gate.
 *
 * Pixels rather than a percentage because a click error is a fixed number of
 * pixels; the number is directly comparable to how precisely a user can hit a
 * feature. It is a pixel-domain quantity and so does not depend on `layout.scale`.
 *
 * @returns The RMS residual, or `null` when fewer than two pairs contribute —
 *          one pair reproduces itself exactly, so its residual is zero by
 *          construction and would claim an agreement nothing checked. This is
 *          "more than two coplanar points", stated in terms of the fit.
 */
export function getDPTResidual(manifest: ManifestData): number | null {
  const pairs = calibrationPairs(manifest.layout.calibration);
  if (pairs.length < 2) return null;

  const scale = fitScale(pairs);
  if (scale === null) return null;

  let sumSq = 0;
  for (const { dPx, dMm } of pairs) {
    sumSq += (dPx - scale * dMm) ** 2;
  }
  return Math.sqrt(sumSq / pairs.length);
}

/**
 * The manifest version this package reads and writes. There is no v3 code here
 * and no compatibility shim: loading anything else fails on the version number
 * alone. The existing archives were converted once, by a throwaway script.
 */
export const MANIFEST_VERSION = 4;

const ScaleSchema = z.enum(SCALES);

// Every object below is `.strict()`: an unknown key is a parse error, not
// something to strip. zod's default is to drop unrecognized keys silently,
// which means a manifest written by a newer build round-trips through an older
// one *shorter* than it arrived — the same failure class as a defaulted
// `scale` or a defaulted `provenance`, and invisible until something
// downstream misses a field nobody knows was deleted. Strictness is per
// object, so it has to be spelled on each one; a new object schema without it
// reopens the hole quietly.
const PointSchema = z
  .object({
    x: z.number(),
    y: z.number(),
  })
  .strict();

const WorldPointSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  })
  .strict();

const CalibrationPointSchema = z
  .object({
    /** Where the feature is in the image. */
    px: PointSchema,
    /** Where it is on the layout, in mm from an arbitrary but fixed origin. */
    world: WorldPointSchema,
  })
  .strict();

// Calibration is always present with `points` defaulting to []. "Uncalibrated"
// is a real state the editor handles, and an empty list expresses it without
// every consumer null-checking the parent.
//
// The two heights below are `.optional()` and deliberately **not** `.default()`
// (#139). A default is populated by the parser, so the first save of any
// archive — including one merely opened to look at — would write the key into
// someone else's file. That is damage done at save time and invisible
// afterwards, which is the failure the strictness note above exists to prevent.
// They add no version: an old archive loads unchanged, and a new archive is
// refused rather than misread, which is the loud failure `.strict()` produces.
const CalibrationSchema = z
  .object({
    points: z.array(CalibrationPointSchema).default([]),
    /**
     * Camera height above layout zero, in mm. Optional here, required by the
     * editor — see {@link getDPT}. `.positive()` because a camera at or below
     * the origin is not a representable pose and every consumer divides by
     * `h − z`; the cross-field rule that it must also clear the tallest
     * calibration point is the editor's, not the schema's.
     */
    camera_height_mm: z.number().positive().optional(),
    /**
     * Railhead height above layout zero, in mm — the plane DPT is reported at.
     * Absent reads as 0, which is the historical meaning of DPT.
     */
    reference_height_mm: z.number().optional(),
  })
  .strict()
  .default({});

const SensorSchema = z
  .object({
    id: z.string().min(1),
    x: z.number(),
    y: z.number(),
    /** Free text, not unique, and never auto-generated — absent when unset. */
    name: z.string().optional(),
  })
  .strict();

// `provenance` is a discriminated union with no default. `proposed_by` is
// required on `proposed`/`corrected` and forbidden on `human`, enforced by the
// schema rather than by a downstream runtime check: a default of `human` would
// launder model output as human authorship, which is the exact feedback loop
// provenance exists to make measurable.
const carLabelBase = {
  id: z.string().min(1),
  /**
   * A plain string here, deliberately unvalidated against the vocabulary.
   * Conformance is a warning in the editor and a fatal error in the training
   * exporter; a format that refused to open files because someone pruned
   * the vocabulary would punish vocabulary edits.
   */
  class: z.string(),
  p0: PointSchema,
  p1: PointSchema,
};

const CarLabelSchema = z.discriminatedUnion('provenance', [
  z
    .object({
      ...carLabelBase,
      provenance: z.literal('human'),
      // Present-and-set fails; absent passes.
      proposed_by: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...carLabelBase,
      provenance: z.literal('proposed'),
      proposed_by: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...carLabelBase,
      provenance: z.literal('corrected'),
      proposed_by: z.string().min(1),
    })
    .strict(),
]);

/**
 * Ids are unique **within** a collection. Sensor ids and label ids are separate
 * namespaces and are never compared — an id shared between the two is fine.
 */
function uniqueIds<T extends { id: string }>(kind: string) {
  return {
    check: (items: readonly T[]) => new Set(items.map(i => i.id)).size === items.length,
    message: `duplicate ${kind} id: ids must be unique within their collection`,
  };
}

const sensorIds = uniqueIds<z.infer<typeof SensorSchema>>('sensor');
const labelIds = uniqueIds<z.infer<typeof CarLabelSchema>>('label');

const ImageSchema = z
  .object({
    filename: z.string(),
    /**
     * A human asserts that no car in this image is unlabeled. Defaults to
     * `false` unconditionally — that is a claim no default and no conversion can
     * make on a human's behalf. An image marked complete with zero labels is
     * legitimate: it is an all-background sample.
     */
    labeled_complete: z.boolean().default(false),
    labels: z.array(CarLabelSchema).refine(labelIds.check, labelIds.message).default([]),
  })
  .strict();

const LayoutSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    contact: z.string().optional(),
    /**
     * Required, with **no default**. v3 defaulted this to `'N'`, which is not
     * safe here: `DPT = s · gauge_mm(scale)`, so a silently-assumed scale
     * reports a DPT wrong by the ratio between the two scales — up to 8.8×
     * between Z and G. SPEC § The v4 manifest names only two defaults,
     * `points: []` and `labeled_complete: false`, and this is not one of them.
     */
    scale: ScaleSchema,
    calibration: CalibrationSchema,
    /** Per **layout**, not per image: placing one answers for every frame. */
    sensors: z.array(SensorSchema).refine(sensorIds.check, sensorIds.message).default([]),
  })
  .strict();

const CameraSchema = z
  .object({
    /** Retained because L0 detections are reported in this frame. */
    resolution: z
      .object({
        width: z.number().int(),
        height: z.number().int(),
      })
      .strict(),
    model: z.string().optional(),
  })
  .strict();

export const ManifestDataSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    /**
     * Identity of the archive itself, stable across every save.
     *
     * **Optional at the format layer, required by the corpus repo** — an
     * archive without one is still valid v4, which is what lets a hand-built
     * manifest and every file written before this field existed keep loading.
     * `R49Archive` mints one on write when it is absent and never overwrites
     * one that exists, so a file only lacks an `id` until the first save.
     *
     * It is identity, not an address: the path a file sits at, and its name,
     * may both change without making it a different archive.
     */
    id: z.string().min(1).optional(),
    layout: LayoutSchema,
    camera: CameraSchema,
    images: z.array(ImageSchema).default([]),
  })
  .strict();

/**
 * Rejects a non-v4 manifest with a message that names the version, before the
 * schema gets a chance to report it as one issue among many.
 *
 * @throws If `data` is not an object, or its `version` is not 4.
 */
/**
 * Validate a manifest, rewording the one parse failure a user can act on.
 *
 * `.strict()` refuses an unknown key rather than stripping it, which is what
 * stops a newer build's file round-tripping through an older one shorter than
 * it arrived. That refusal is correct and stays — but zod states it as
 * `Unrecognized key(s) in object: 'camera_height_mm'`, which is legible to
 * someone holding the schema and useless to a model railroader looking at a
 * file that will not open.
 *
 * It is worth rewording because the additive fields decided on
 * [#139](https://github.com/rails49/occupancy/issues/139) add **no version** — so
 * this, and not a version mismatch, is how a stale reader meets a newer
 * archive. A cached bundle is the ordinary way to be behind in a client-side
 * app served from one origin, and "reload the app" is the one thing the reader
 * can act on. Every future additive field inherits the wording.
 *
 * The hedge is not padding: an unknown key is equally a typo in a hand-built
 * manifest, and nothing can tell the two apart.
 *
 * @throws A reworded `Error` for an unknown key; otherwise whatever zod threw.
 */
export function parseManifest(data: unknown): ManifestData {
  try {
    return ManifestDataSchema.parse(data);
  } catch (err) {
    const unknown = unknownKeyPaths(err);
    if (unknown.length === 0) throw err;
    const names = unknown.map(k => `\`${k}\``).join(', ');
    throw new Error(
      `This archive uses ${unknown.length === 1 ? 'a field' : 'fields'} this build does not ` +
        `know (${names}). It may have been written by a newer version of rails49 — reload the ` +
        `app and try again. If you hand-edited manifest.json, check the key ` +
        `${unknown.length === 1 ? 'name' : 'names'}.`,
    );
  }
}

/** Dotted paths of every key `.strict()` rejected, or `[]` for any other failure. */
function unknownKeyPaths(err: unknown): string[] {
  if (!(err instanceof z.ZodError)) return [];
  return err.issues.flatMap(issue =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map(key => [...issue.path, key].join('.'))
      : [],
  );
}

export function assertManifestVersion(data: unknown): void {
  const version = (data as { version?: unknown } | null)?.version;
  if (version === MANIFEST_VERSION) return;

  throw new Error(
    `Unsupported manifest version ${JSON.stringify(version)}: this build reads version ` +
      `${MANIFEST_VERSION} only. There is no v3 compatibility path — v4 replaced point ` +
      `markers with cars and sensors, and no automated migration is possible because a ` +
      `point carries neither extent nor orientation.`
  );
}

export type Point = z.infer<typeof PointSchema>;
export type WorldPoint = z.infer<typeof WorldPointSchema>;
export type CalibrationPoint = z.infer<typeof CalibrationPointSchema>;
export type Calibration = z.infer<typeof CalibrationSchema>;
export type Sensor = z.infer<typeof SensorSchema>;
export type CarLabel = z.infer<typeof CarLabelSchema>;
export type Provenance = CarLabel['provenance'];
export type Image = z.infer<typeof ImageSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type ManifestData = z.infer<typeof ManifestDataSchema>;
