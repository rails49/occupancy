import { STANDARD_GAUGE, STANDARD_WIDTH } from '@occupancy/config';
import type { CarLabel, Point } from '@rails49/r49';
import type { Detection, Frame } from './types.ts';

/**
 * Car boxes, from both ends: an authored span becomes a training label
 * (`spanToPolygon`), and a detected pose becomes drawable corners
 * (`boxCorners`). They are the same rectangle construction run in opposite
 * directions, so they share one internal core — a chord plus a half-width
 * normal — and one winding rule.
 *
 * This lives in the detector package rather than in `dataset` because both
 * consumers of the width constant are on this side of the line: L1 replaces a
 * predicted width with `carWidthPx`, and the UI's archive diagnostics draw
 * ground truth beside detections in the same frame. Leaving it in `dataset`
 * would put the constant that biases boxes toward `occupied` in two packages
 * with nothing checking that they agree — and `dataset/src/yolo_rules.ts` imports
 * `node:crypto` at module top, so the browser could not have reached it.
 */

/** Pixel width of a car, from the resolution it was photographed at.
 *
 * `DPT × STANDARD_WIDTH / STANDARD_GAUGE`. The scale ratio cancels — a car is
 * the same 2.09 track-widths wide in every scale — which is why this needs the
 * DPT and nothing else. Width is derived rather than stored per label, and
 * derived from the *widest* real prototype: an over-wide box biases toward
 * `occupied`, the direction the occupancy output deliberately errs in.
 */
export function carWidthPx(dpt: number): number {
  return (dpt * STANDARD_WIDTH) / STANDARD_GAUGE;
}

/**
 * The four corners of a rectangle given its long axis as a chord, wound around
 * the perimeter: `p0 + n`, `p1 + n`, `p1 - n`, `p0 - n`, where `n` is half a
 * car width along the chord's normal.
 *
 * Walking the perimeter rather than pairing the ends is what makes it a simple
 * quadrilateral — pairing them draws a bowtie. The chord carries centre,
 * orientation and length already, so no trigonometry is involved and none
 * should be reintroduced: an angle would have to be unwrapped somewhere, and
 * the corner form has no branch to get wrong.
 *
 * @param unit Unit vector along `p0 → p1`. Passed in rather than derived so
 *             that the one caller with a degenerate case to report (a
 *             zero-length authored span) can say so in its own words.
 */
function offsetCorners(p0: Point, p1: Point, unit: Point, widthPx: number): Point[] {
  const half = widthPx / 2;
  const nx = -unit.y * half;
  const ny = unit.x * half;

  return [
    { x: p0.x + nx, y: p0.y + ny },
    { x: p1.x + nx, y: p1.y + ny },
    { x: p1.x - nx, y: p1.y - ny },
    { x: p0.x - nx, y: p0.y - ny },
  ];
}

/**
 * A car span as the four **normalized** polygon corners Ultralytics reads,
 * flattened in `x1 y1 x2 y2 x3 y3 x4 y4` order and wound around the perimeter.
 *
 * Corners are **clamped** into `[0, 1]`. A car at the frame edge genuinely has
 * corners outside it, and Ultralytics rejects a label file containing one
 * outright, so the choice is between a clamped box and no box at all — and no
 * box is the unlabeled-car-as-background failure. Clamping bends the rectangle
 * into a quad, which training re-fits to the tightest enclosing rotated rect;
 * the caller is told how many corners moved so it is never silent.
 *
 * Normalizing and clamping are the *exporter's* concerns and stay here rather
 * than in the shared core: a detection drawn over a video is neither.
 *
 * @throws If the chord has zero length. Two coincident points name no
 *         orientation, so there is no box to derive — a malformed label, not a
 *         degenerate case to paper over with a default.
 */
export function spanToPolygon(
  label: Pick<CarLabel, 'id' | 'p0' | 'p1'>,
  widthPx: number,
  frame: Frame
): { readonly corners: readonly number[]; readonly clamped: number } {
  const dx = label.p1.x - label.p0.x;
  const dy = label.p1.y - label.p0.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    throw new Error(
      `label ${label.id}: p0 and p1 coincide at (${label.p0.x}, ${label.p0.y}), ` +
        `so the span has no orientation and no box can be derived from it`
    );
  }

  const corners = offsetCorners(
    label.p0,
    label.p1,
    { x: dx / length, y: dy / length },
    widthPx
  ).flatMap(c => [c.x, c.y]);

  let clamped = 0;
  const normalized = corners.map((value, i) => {
    const scaled = value / (i % 2 === 0 ? frame.width : frame.height);
    if (scaled < 0 || scaled > 1) clamped++;
    return Math.min(1, Math.max(0, scaled));
  });

  return { corners: normalized, clamped };
}

/**
 * A detection's four corners, in the frame the detection is reported in and in
 * the same winding as `spanToPolygon`.
 *
 * Exported although it is derivable from the `Detection` fields, because
 * "derivable" is exactly how the width constant came to exist in two packages:
 * both the live view and the diagnostics need corners to draw, and a second
 * hand-rolled corner formula is a second winding rule to get wrong. Uses the
 * detection's **raw** width — L1's normalization is L1's, and a drawn box
 * should be what the model said.
 */
export function boxCorners(detection: Detection): readonly Point[] {
  const ux = Math.cos(detection.angle);
  const uy = Math.sin(detection.angle);
  const hx = (ux * detection.length) / 2;
  const hy = (uy * detection.length) / 2;

  return offsetCorners(
    { x: detection.centre.x - hx, y: detection.centre.y - hy },
    { x: detection.centre.x + hx, y: detection.centre.y + hy },
    { x: ux, y: uy },
    detection.width
  );
}

/**
 * Whether an oriented box of the given width **strictly contains** a point.
 *
 * Tested in the box's own axes rather than against its corners: a point is
 * inside when its along-axis and across-axis offsets from the centre are both
 * within the respective half-extents. Four corners and a winding rule would
 * answer the same question with more ways to be wrong.
 *
 * No tolerance epsilon, per SPEC. Any value would be unvalidatable, the lateral
 * direction already carries ~1.4 m prototype of slack from the derived width,
 * and at a coupler two boxes abut on a shared endpoint so a point between
 * coupled cars is already inside one of them. A real gap between uncoupled cars
 * should read `clear`, and an epsilon would manufacture a phantom there.
 *
 * Internal: L1 is the only caller, so exporting it would publish a seam that
 * nothing yet needs on the other side.
 */
export function covers(detection: Detection, widthPx: number, point: Point): boolean {
  const dx = point.x - detection.centre.x;
  const dy = point.y - detection.centre.y;
  const ux = Math.cos(detection.angle);
  const uy = Math.sin(detection.angle);

  const along = dx * ux + dy * uy;
  const across = -dx * uy + dy * ux;

  return Math.abs(along) < detection.length / 2 && Math.abs(across) < widthPx / 2;
}
