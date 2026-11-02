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

/** A centerline: at least two nodes, and the clicks they were fitted from, if any. */
export interface Track {
  readonly nodes: readonly TrackNode[];
  readonly clicks?: readonly Point[];
}

/** One cubic Bézier between two nodes. */
export interface Segment {
  readonly p0: Point;
  readonly c0: Point;
  readonly c1: Point;
  readonly p1: Point;
}

/** Spacing, in image pixels, of the points a curve is drawn through. */
export const SAMPLE_PX = 2;

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

/**
 * How far from a centerline, in track widths, a sensor or a car end still
 * lands on it. Parallel tracks sit farther apart than this, so the nearest
 * track is the one under the pointer.
 */
export const SNAP_TRACK_WIDTHS = 1.5;

/**
 * The point on `tracks` nearest `at` and no farther than `maxPx`, or null.
 * Each segment is sampled every couple of image pixels, and the nearest sample
 * refined between its neighbours, so a point on a straight comes back exact.
 */
export function nearestOnTrack(tracks: readonly Track[], at: Point, maxPx: number): Point | null {
  const dist = (s: Segment, t: number) => {
    const p = pointAt(s, t);
    return Math.hypot(p.x - at.x, p.y - at.y);
  };
  let best: { s: Segment; t: number; step: number } | null = null;
  let bestD = Infinity;
  for (const track of tracks) {
    for (const s of segments(track.nodes)) {
      const n = Math.max(4, Math.ceil(Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y) / SAMPLE_PX));
      for (let k = 0; k <= n; k++) {
        const d = dist(s, k / n);
        if (d < bestD) {
          best = { s, t: k / n, step: 1 / n };
          bestD = d;
        }
      }
    }
  }
  if (!best) return null;

  // Golden-section search on the interval around the nearest sample.
  const { s } = best;
  let lo = Math.max(0, best.t - best.step);
  let hi = Math.min(1, best.t + best.step);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40; i++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    if (dist(s, a) < dist(s, b)) hi = b;
    else lo = a;
  }
  const t = (lo + hi) / 2;
  return dist(s, t) <= maxPx ? pointAt(s, t) : null;
}

/** Indices of the clicks of `track` farther than `maxPx` from its line. */
export function clicksOff(track: Track, maxPx: number): number[] {
  const clicks = track.clicks ?? [];
  return clicks.flatMap((p, i) => (nearestOnTrack([track], p, maxPx) ? [] : [i]));
}

/** A pointer on a line: `t` along `segment` of centerline `line`. */
export interface TrackHit {
  readonly line: number;
  readonly segment: number;
  readonly t: number;
}

/** The point on a line nearest `at` and no farther than `radius`, or null. */
export function hitTrack(tracks: readonly Track[], at: Point, radius: number): TrackHit | null {
  let best: TrackHit | null = null;
  let bestD = radius;
  for (const [line, track] of tracks.entries()) {
    for (const [segment, s] of segments(track.nodes).entries()) {
      const n = Math.max(4, Math.ceil(Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y) / SAMPLE_PX));
      for (let k = 0; k <= n; k++) {
        const p = pointAt(s, k / n);
        const d = Math.hypot(p.x - at.x, p.y - at.y);
        if (d <= bestD) {
          best = { line, segment, t: k / n };
          bestD = d;
        }
      }
    }
  }
  return best;
}

/** A pointer on a click: click `index` of centerline `line`. */
export interface ClickHit {
  readonly line: number;
  readonly index: number;
}

/** The click nearest `at` and no farther than `radius`, or null. */
export function hitClick(tracks: readonly Track[], at: Point, radius: number): ClickHit | null {
  let best: ClickHit | null = null;
  let bestD = radius;
  for (const [line, track] of tracks.entries()) {
    for (const [index, p] of (track.clicks ?? []).entries()) {
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d <= bestD) {
        best = { line, index };
        bestD = d;
      }
    }
  }
  return best;
}
