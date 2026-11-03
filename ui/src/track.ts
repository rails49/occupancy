import { headingAt, nearestOnTrack as nearestUncapped, pointAt, segment } from '@rails49/r49';
import type { Click, Point, Segment, Track, TrackNode } from '@rails49/r49';

export type { Track, TrackNode };

/**
 * Tracks as G1 curves (#284): what the editor draws and hits, kept out of the
 * components so jsdom can test it. The curve between two nodes is
 * `@rails49/r49`'s `segment` (FORMAT.md § Node).
 */

/** Spacing, in image pixels, of the points a curve is drawn through. */
export const SAMPLE_PX = 2;

/** The segments between consecutive nodes. */
export function segments(nodes: readonly TrackNode[]): Segment[] {
  return nodes.slice(1).map((node, i) => segment(nodes[i], node));
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
      const h = headingAt(s, t);
      points.push({ x: p.x - offset * Math.sin(h), y: p.y + offset * Math.cos(h) });
    }
  }
  return points;
}

/**
 * How far from a track, in track widths, a sensor or a car end still
 * lands on it. Parallel tracks sit farther apart than this, so the nearest
 * track is the one under the pointer.
 */
export const SNAP_TRACK_WIDTHS = 1.5;

/** The point on `tracks` nearest `at` and no farther than `maxPx`, or null. */
export function nearestOnTrack(tracks: readonly Track[], at: Point, maxPx: number): Point | null {
  const on = nearestUncapped(tracks, at);
  return on && on.distance <= maxPx ? on.point : null;
}

/** A pointer on a line: track `line`. */
export interface TrackHit {
  readonly line: number;
}

/** The line nearest `at` and no farther than `radius`, or null. */
export function hitTrack(tracks: readonly Track[], at: Point, radius: number): TrackHit | null {
  const near = tracks.flatMap((track, line) =>
    segments(track.nodes).flatMap(s => {
      const n = Math.max(4, Math.ceil(Math.hypot(s.p1.x - s.p0.x, s.p1.y - s.p0.y) / SAMPLE_PX));
      return Array.from({ length: n + 1 }, (_, k) => [{ line }, pointAt(s, k / n)] as const);
    })
  );
  return nearestWithin(near, at, radius);
}

/**
 * The gap of `track` whose part of the line is nearest `at`: the index of
 * the click it starts from. The track has two or more clicks.
 */
export function nearestGap(track: Track, at: Point): number {
  // Points along the line in order; a click's place is its nearest point's index.
  const samples = offsetPoints(track.nodes, 0);
  const place = (p: Point) => {
    let best = 0;
    samples.forEach((q, i) => {
      if (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(samples[best].x - p.x, samples[best].y - p.y)) best = i;
    });
    return best;
  };
  const along = place(at);
  const clicks = track.clicks!;
  const passed = clicks.slice(1).filter(p => place(p) < along).length;
  return Math.min(passed, clicks.length - 2);
}

/** Whether click `i` of `clicks` ends a straight gap, and is drawn as a square. */
export function squareAt(clicks: readonly Click[], i: number): boolean {
  return !!(clicks[i].straight || clicks[i - 1]?.straight);
}

/** A pointer on a click: click `index` of track `line`. */
export interface ClickHit {
  readonly line: number;
  readonly index: number;
}

/** The click nearest `at` and no farther than `radius`, or null. */
export function hitClick(tracks: readonly Track[], at: Point, radius: number): ClickHit | null {
  const near = tracks.flatMap((track, line) => (track.clicks ?? []).map((p, index) => [{ line, index }, p] as const));
  return nearestWithin(near, at, radius);
}

/** The item whose point is nearest `at` and no farther than `radius`, or null; a tie goes to the later item. */
function nearestWithin<T>(items: readonly (readonly [T, Point])[], at: Point, radius: number): T | null {
  let best: T | null = null;
  let bestD = radius;
  for (const [item, p] of items) {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= bestD) {
      best = item;
      bestD = d;
    }
  }
  return best;
}
