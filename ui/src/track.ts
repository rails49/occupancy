import type { Point } from '@rails49/r49';

/**
 * Track centerlines as G1 curves (#284): the arithmetic, kept out of the
 * components so jsdom can test it.
 *
 * A centerline is a list of nodes, each a position and a heading. Between two
 * nodes the curve is a cubic Bézier whose handles leave each node along its
 * heading. Two segments that meet at a node share its heading, so the line has
 * no kink anywhere. Equal headings along the chord make a straight.
 */

/** A point on a centerline and the direction the track runs there. */
export interface TrackNode {
  readonly x: number;
  readonly y: number;
  /** Radians, `atan2(dy, dx)` in image pixels, pointing the way the nodes run. */
  readonly heading: number;
}

/** A traced centerline: at least two nodes. */
export interface Track {
  readonly nodes: readonly TrackNode[];
}

/** One cubic Bézier between two nodes. */
export interface Segment {
  readonly p0: Point;
  readonly c0: Point;
  readonly c1: Point;
  readonly p1: Point;
}

/**
 * How far off the current tangent line, in screen pixels, a click still makes a
 * straight. The click is moved onto the line.
 */
export const STRAIGHT_SNAP_SCREEN_PX = 6;

/** The largest turn one segment may make. A cubic follows an arc closely up to here. */
export const MAX_TURN = Math.PI / 2;

/** Spacing, in image pixels, of the points a curve is drawn through. */
const SAMPLE_PX = 2;

/** `angle` in (-π, π]. */
export function wrapAngle(angle: number): number {
  const wrapped = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/**
 * The Bézier from `a` to `b`. Each handle has length `d / (3 cos²(φ/4))`, with
 * `d` the chord and `φ` the turn, which reproduces a circular arc when the two
 * headings are symmetric about the chord.
 */
export function segment(a: TrackNode, b: TrackNode): Segment {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const turn = wrapAngle(b.heading - a.heading);
  const h = d / (3 * Math.cos(turn / 4) ** 2);
  return {
    p0: { x: a.x, y: a.y },
    c0: { x: a.x + h * Math.cos(a.heading), y: a.y + h * Math.sin(a.heading) },
    c1: { x: b.x - h * Math.cos(b.heading), y: b.y - h * Math.sin(b.heading) },
    p1: { x: b.x, y: b.y },
  };
}

/** The segments between consecutive nodes. */
export function segments(nodes: readonly TrackNode[]): Segment[] {
  return nodes.slice(1).map((node, i) => segment(nodes[i], node));
}

/** The point at `t` in [0, 1]. */
export function pointAt(s: Segment, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * s.p0.x + b * s.c0.x + c * s.c1.x + d * s.p1.x,
    y: a * s.p0.y + b * s.c0.y + c * s.c1.y + d * s.p1.y,
  };
}

/** The derivative at `t`, which points along the curve. */
export function tangentAt(s: Segment, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * (u * u * (s.c0.x - s.p0.x) + 2 * u * t * (s.c1.x - s.c0.x) + t * t * (s.p1.x - s.c1.x)),
    y: 3 * (u * u * (s.c0.y - s.p0.y) + 2 * u * t * (s.c1.y - s.c0.y) + t * t * (s.p1.y - s.c1.y)),
  };
}

/** An SVG path through the nodes: one `C` command per segment. */
export function trackPath(nodes: readonly TrackNode[]): string {
  if (nodes.length === 0) return '';
  const curves = segments(nodes).map(
    s => `C ${s.c0.x} ${s.c0.y} ${s.c1.x} ${s.c1.y} ${s.p1.x} ${s.p1.y}`
  );
  return [`M ${nodes[0].x} ${nodes[0].y}`, ...curves].join(' ');
}

/**
 * Points along the line, `offset` image pixels to its right (looking along the
 * nodes; negative is left). Offset curves are not Béziers, so they are sampled.
 */
export function offsetPoints(nodes: readonly TrackNode[], offset: number): Point[] {
  const points: Point[] = [];
  for (const [i, s] of segments(nodes).entries()) {
    const n = Math.max(4, Math.ceil(Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y) / SAMPLE_PX));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const p = pointAt(s, t);
      const v = tangentAt(s, t);
      const len = Math.hypot(v.x, v.y);
      if (len === 0) continue;
      points.push({ x: p.x - (offset * v.y) / len, y: p.y + (offset * v.x) / len });
    }
  }
  return points;
}

/** What a click does to a trace. */
export type TraceStep =
  | { readonly kind: 'node'; readonly nodes: readonly TrackNode[] }
  /** No farther than `minPx` from the last point placed: nothing. */
  | { readonly kind: 'too-close' }
  /** The arc would turn more than {@link MAX_TURN}. */
  | { readonly kind: 'too-sharp' };

/**
 * What a click at `to` does to a trace.
 *
 * `start` is the first click and `nodes` the nodes placed since, empty until
 * the second click. The first segment is a straight, so both of its nodes take
 * the chord's heading. Every later click ends a circular arc that leaves the
 * last node along its heading: the new node's heading is the old one mirrored
 * about the chord. A click within `snapPx` of the tangent line, ahead of the
 * last node, is moved onto it and makes a straight.
 */
export function traceTo(
  start: Point,
  nodes: readonly TrackNode[],
  to: Point,
  snapPx: number,
  minPx: number
): TraceStep {
  const last = nodes[nodes.length - 1] ?? start;
  const dx = to.x - last.x;
  const dy = to.y - last.y;
  if (Math.hypot(dx, dy) <= minPx) return { kind: 'too-close' };

  if (nodes.length === 0) {
    const heading = Math.atan2(dy, dx);
    return {
      kind: 'node',
      nodes: [
        { x: start.x, y: start.y, heading },
        { x: to.x, y: to.y, heading },
      ],
    };
  }

  const cos = Math.cos(last.heading);
  const sin = Math.sin(last.heading);
  const along = dx * cos + dy * sin;
  const across = -dx * sin + dy * cos;
  if (along > 0 && Math.abs(across) <= snapPx) {
    const node = { x: last.x + along * cos, y: last.y + along * sin, heading: last.heading };
    return { kind: 'node', nodes: [...nodes, node] };
  }

  const deviation = wrapAngle(Math.atan2(dy, dx) - last.heading);
  if (Math.abs(2 * deviation) > MAX_TURN) return { kind: 'too-sharp' };
  const node = { x: to.x, y: to.y, heading: wrapAngle(last.heading + 2 * deviation) };
  return { kind: 'node', nodes: [...nodes, node] };
}
