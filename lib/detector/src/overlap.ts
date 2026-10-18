/**
 * How much two oriented boxes share.
 *
 * Its own module, importing nothing: this is plane geometry over convex
 * quadrilaterals, and both callers want it for different reasons — the decode
 * suppresses duplicates with it (issue #107), and the UI's archive diagnostics
 * match predictions to labels with it. It moved down here from
 * `ui/src/diagnostics.ts` when the second caller appeared, which is the bar
 * this package's interface note sets for promoting anything.
 */

import type { Point } from '@rails49/r49';

/** Area of a simple polygon, by the shoelace formula. Sign-free. */
export function polygonArea(polygon: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/**
 * Area shared by two **convex** polygons, by Sutherland–Hodgman clipping.
 *
 * Convexity is what makes this correct, and it is not an assumption to relax:
 * every input here is a rectangle by construction — `boxCorners` and the UI's
 * `carCorners` both walk a perimeter rather than pairing ends, so neither can
 * produce the bowtie that would break it.
 *
 * Winding is **normalized before clipping rather than assumed**. The two corner
 * builders derive their normals from spans that may run in opposite directions,
 * so a shared winding cannot be relied on — and a mismatched pair clips to
 * nothing, which reads as two boxes that do not overlap at all.
 */
export function convexIntersectionArea(a: readonly Point[], b: readonly Point[]): number {
  let output = counterClockwise(a);
  const clip = counterClockwise(b);

  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const edgeStart = clip[i];
    const edgeEnd = clip[(i + 1) % clip.length];
    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const currentInside = side(edgeStart, edgeEnd, current) >= 0;
      const previousInside = side(edgeStart, edgeEnd, previous) >= 0;

      if (currentInside) {
        if (!previousInside) output.push(intersect(previous, current, edgeStart, edgeEnd));
        output.push(current);
      } else if (previousInside) {
        output.push(intersect(previous, current, edgeStart, edgeEnd));
      }
    }
  }

  return output.length < 3 ? 0 : polygonArea(output);
}

/** Intersection over union of two convex polygons. */
export function polygonIoU(a: readonly Point[], b: readonly Point[]): number {
  const intersection = convexIntersectionArea(a, b);
  if (intersection === 0) return 0;
  const union = polygonArea(a) + polygonArea(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Positive when `p` is left of the directed edge `a → b`. */
function side(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function counterClockwise(polygon: readonly Point[]): Point[] {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice < 0 ? [...polygon].reverse() : [...polygon];
}

/** Where segment `p → q` crosses the infinite line through `a → b`. */
function intersect(p: Point, q: Point, a: Point, b: Point): Point {
  const dx1 = q.x - p.x;
  const dy1 = q.y - p.y;
  const dx2 = b.x - a.x;
  const dy2 = b.y - a.y;
  const denominator = dx1 * dy2 - dy1 * dx2;
  // Parallel: only reachable when the endpoints straddle the edge, so a zero
  // here is floating-point noise on a near-tangent crossing. Answering with `p`
  // keeps the polygon closed instead of emitting NaN.
  if (denominator === 0) return { ...p };
  const t = ((a.x - p.x) * dy2 - (a.y - p.y) * dx2) / denominator;
  return { x: p.x + t * dx1, y: p.y + t * dy1 };
}
