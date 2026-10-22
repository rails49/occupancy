/**
 * Opening a drift check against an archive, in one place.
 *
 * Two surfaces need one — the live view refuses to classify on it (#94) and the
 * editor warns on it (#95) — and everything platform-specific about getting
 * there lives here rather than in either. `@occupancy/drift` takes a
 * `GrayPlane`, deliberately: `ImageData` does not exist in Node and the
 * benchmark is a first-class consumer, so somebody has to hold the canvas, and
 * this is the `detectorSession.ts` of the drift path.
 *
 * **The reference is decoded at its native resolution and that is load-bearing.**
 * `DriftResult.displacementPx` is reported in the reference's frame, so handing
 * the check a pre-shrunk image would silently rescale every number — and the
 * tolerance `maxDriftPx` derives is in `camera.resolution` pixels. The check
 * clamps to its own working resolution internally; letting it do that is what
 * keeps the number meaning one thing.
 */

import { createDriftCheck, fromImageData } from '@occupancy/drift';
import type { DriftCheck, GrayPlane } from '@occupancy/drift';
import type { R49Archive } from '@rails49/r49';

/**
 * The drift tolerance: the largest drift still taken as the pose, as a
 * fraction of one track width (ADR 0013,
 * `docs/adr/0013-drift-is-measured-against-the-first-image.md`).
 *
 * Why 0.25: a sensor fails when it slides off its car or onto a neighbouring
 * track's, and both sit about one track width away, so a quarter is roughly a
 * 4x margin — ~4.7 px at the fixture corpus's DPT 18-19, which ordinary
 * mounting holds. Unmeasured: validation is synthetic warps of tripod shots,
 * so nothing says how often a real camera drifts this far, which is why the
 * live view's refusal carries an override.
 */
export const MAX_DRIFT_TRACK_FRACTION = 0.25;

/**
 * How far the camera may appear to have moved before it counts as drift, in
 * `camera.resolution` pixels.
 *
 * **The one place `MAX_DRIFT_TRACK_FRACTION` is multiplied by a DPT.** Both
 * surfaces need the number — the live view refuses on it and prints it, the
 * editor warns on it — and written twice it is the `carWidthPx` mistake again: a
 * constant that biases a safety decision, living in two files with nothing
 * checking that they agree.
 *
 * DPT *is* pixels per track gauge, so this is a fraction of a track width
 * expressed in the frame the sensors were authored in. That is the frame the
 * failure happens in: occupancy breaks when a sensor stops sitting on the car it
 * reads, which is a geometric condition, not a pixel count — the same physical
 * misalignment matters equally at DPT 18 and at DPT 90.
 *
 * @param dpt the layout's resolution in dots per track. `null` yields `null`:
 *            an uncalibrated layout has no track width to take a fraction of,
 *            and its sensors already read `unknown` / `no-calibration` — a
 *            fabricated tolerance would be a second, quieter wrong answer.
 */
export function maxDriftPx(dpt: number | null): number | null {
  return dpt === null ? null : MAX_DRIFT_TRACK_FRACTION * dpt;
}

/** A drift measurement judged against the layout's tolerance. */
export interface DriftVerdict {
  /** The measured displacement, in `camera.resolution` pixels. */
  readonly px: number;
  /** The same displacement in track widths, the unit the tolerance is set in. */
  readonly tracks: number;
  /** {@link maxDriftPx} for this layout. */
  readonly tolerancePx: number;
  /** Whether the displacement is past the tolerance. Exactly at it passes. */
  readonly past: boolean;
}

/**
 * Judge a drift measurement, for the editor's row and the live view's refusal
 * alike, so the two cannot disagree about where the line is.
 *
 * @returns `null` when `dpt` is `null` — see {@link maxDriftPx}.
 */
export function driftVerdict(px: number, dpt: number | null): DriftVerdict | null {
  const tolerancePx = maxDriftPx(dpt);
  if (dpt === null || tolerancePx === null) return null;
  return { px, tracks: px / dpt, tolerancePx, past: px > tolerancePx };
}

/**
 * A drift check, plus the name of the image it checks against.
 *
 * One reference, not a set — see {@link openDriftCheck}. `DriftResult.refIndex`
 * is therefore always 0 and callers can ignore it; what they want to name is
 * this.
 */
export interface DriftSession {
  readonly check: DriftCheck;
  /** The archive's reference image: `manifest.images[0]`. */
  readonly refName: string;
}

/**
 * One scratch canvas for every grab, resized in place.
 *
 * A canvas per frame is a canvas per frame's worth of garbage, and the live view
 * grabs one every few seconds for the length of a session. Reused rather than
 * pooled because nothing here is re-entrant: a grab is synchronous from
 * `drawImage` to `getImageData`, so no second caller can be mid-grab.
 */
let scratch: HTMLCanvasElement | null = null;

function scratchContext(width: number, height: number): CanvasRenderingContext2D {
  scratch ??= document.createElement('canvas');
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('drift: no 2d canvas context');
  return ctx;
}

/**
 * Read a drawable source into a grayscale plane at the given size.
 *
 * The size is the caller's because only it knows what the source's intrinsic
 * dimensions are — `videoWidth` for a stream, `naturalWidth` for an image — and
 * a zero there means a source that is not ready yet rather than an error.
 *
 * @throws if `width` or `height` is below 1, or the canvas yields no context
 */
export function grabPlane(source: CanvasImageSource, width: number, height: number): GrayPlane {
  if (width < 1 || height < 1) {
    throw new Error(`drift: cannot grab a ${width}x${height} frame`);
  }
  const ctx = scratchContext(width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return fromImageData(ctx.getImageData(0, 0, width, height));
}

/** Decode image bytes from an archive into a plane at their native size. */
export async function planeFromBytes(bytes: Uint8Array): Promise<GrayPlane> {
  // The same Blob dance `rr-editor-view._refreshImageUrls` does, for the same
  // reason: the archive holds bytes and the platform decodes blobs.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));
  try {
    return grabPlane(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Build a drift check against the archive's **reference image**: `images[0]`,
 * the first thumbnail in the strip.
 *
 * **One image defines the pose, and it is the one the user can see and move.**
 * The alternative — every image a reference, scored as the minimum over them —
 * is what shipped first, and it had a hole: an image captured from a moved
 * camera and kept anyway (the editor warns, it never blocks) joined the
 * reference set, so the drifted pose then scored ~0 and the refusal never fired
 * again. One accepted warning permanently widened the accepted pose (#118).
 *
 * Position 0 closes it, and the reorder control is what makes the choice
 * legible rather than hidden: dragging a thumbnail to the front changes the
 * reference, and because the editor shows **every** image's drift against it,
 * every number on screen updates when you do. A rule keyed on something the
 * user cannot see — the oldest filename, say — would be safer against accident
 * and much harder to understand or correct.
 *
 * Returns `null` for an archive with no decodable first image, which is a real
 * state and not an error: a layout that has just been created has no pose to
 * have drifted from. Callers say so rather than reporting no drift — "cannot
 * tell" and "steady" are different claims.
 *
 * @throws whatever decoding or `createDriftCheck` throws. Callers report it;
 *         neither treats a missing drift check as fatal.
 */
export async function openDriftCheck(archive: R49Archive): Promise<DriftSession | null> {
  const reference = archive.getManifest().images[0];
  if (!reference) return null;
  const check = await checkAgainst(archive, reference.filename);
  return check && { check, refName: reference.filename };
}

/** A drift check against one image of the archive, or `null` if it has no bytes. */
async function checkAgainst(archive: R49Archive, filename: string): Promise<DriftCheck | null> {
  const bytes = await archive.getImage(filename);
  if (!bytes) return null;
  const plane: GrayPlane = await planeFromBytes(bytes);
  return createDriftCheck([plane]);
}

/**
 * The editor's measuring function: one image of the archive against another,
 * by filename, in the reference's pixels.
 *
 * The drift check for a reference is built once and kept until a different
 * reference is asked for, so adding an image costs one decode, not two.
 *
 * @throws if either image has no bytes in the archive, or decoding fails
 */
export function measureAgainst(
  archive: R49Archive
): (reference: string, image: string) => Promise<number> {
  let cached: { reference: string; check: Promise<DriftCheck | null> } | null = null;
  return async (reference, image) => {
    if (cached?.reference !== reference) {
      cached = { reference, check: checkAgainst(archive, reference) };
    }
    const check = await cached.check;
    if (!check) throw new Error(`drift: reference ${reference} has no image bytes`);
    const bytes = await archive.getImage(image);
    if (!bytes) throw new Error(`drift: ${image} has no image bytes`);
    return (await check.check(await planeFromBytes(bytes))).displacementPx;
  };
}
