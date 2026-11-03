import type { Click, Point } from '@rails49/r49';
import { wrapAngle } from './track.js';
import type { TrackNode } from './track.js';

/**
 * Straights and circular arcs, tangent where they meet, through the clicks
 * traced along the middle of a track (#317). Pure.
 *
 * A line is a start pose and a length and a curvature per part (curvature 0
 * is a straight); tangency holds by construction. `buildLine` takes the
 * clicks and gives the line through every one of them, or why there is
 * none. Each click takes a heading from its neighbours, and the gap to the
 * next click is two arcs that meet tangentially, so a click changes the line
 * only nearby, and the clicks give the same line in either order.
 */

/** The rule's constants, in gauges. `fitOptions` converts them through DPT. */
export const TRACK_FIT = {
  /** How far a click of a straight run may lie off it. */
  tolerance: 0.1,
  /** Tightest arc track comes in. */
  minRadius: 10,
  /** How far a click must be from every track to start a line. */
  startDistance: 1,
} as const;

export interface FitOptions {
  /** How far a click of a straight run may lie off it, px. */
  readonly tolerance: number;
  /** Tightest arc, px. */
  readonly minRadius: number;
}

export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export interface Part {
  readonly length: number;
  /** 1/radius in 1/px, positive when the heading increases; 0 for a straight. */
  readonly curvature: number;
}

export interface Fit {
  readonly start: Pose;
  readonly parts: readonly Part[];
}

function advance(p: Pose, s: number, k: number): Pose {
  if (Math.abs(k) < 1e-12) {
    return { x: p.x + s * Math.cos(p.heading), y: p.y + s * Math.sin(p.heading), heading: p.heading };
  }
  const h = p.heading + k * s;
  return {
    x: p.x + (Math.sin(h) - Math.sin(p.heading)) / k,
    y: p.y - (Math.cos(h) - Math.cos(p.heading)) / k,
    heading: h,
  };
}

/**
 * The line as stored nodes: one per join, heading along the line. An arc is
 * split into equal pieces of at most 90°, which a Bézier between nodes
 * follows closely.
 */
export function fitNodes(fit: Fit): TrackNode[] {
  const node = (p: Pose): TrackNode => ({ x: p.x, y: p.y, heading: wrapAngle(p.heading) });
  const nodes = [node(fit.start)];
  let pose = fit.start;
  for (const part of fit.parts) {
    const pieces = Math.max(1, Math.ceil(Math.abs(part.length * part.curvature) / (Math.PI / 2) - 1e-9));
    for (let i = 1; i < pieces; i++) nodes.push(node(advance(pose, (part.length * i) / pieces, part.curvature)));
    pose = advance(pose, part.length, part.curvature);
    nodes.push(node(pose));
  }
  return nodes;
}

/** Points along the line every `step` px, `offset` px to its left (negative is right). */
export function sampleFit(fit: Fit, step: number, offset: number): Point[] {
  const out: Point[] = [];
  let pose: Pose = fit.start;
  const push = (p: Pose) =>
    out.push({ x: p.x - offset * Math.sin(p.heading), y: p.y + offset * Math.cos(p.heading) });
  push(pose);
  for (const part of fit.parts) {
    const n = Math.max(1, Math.ceil(part.length / step));
    for (let i = 1; i <= n; i++) push(advance(pose, (part.length * i) / n, part.curvature));
    pose = advance(pose, part.length, part.curvature);
  }
  return out;
}

/** `TRACK_FIT`'s constants in image pixels, for a layout whose DPT (a gauge in pixels) is `dpt`. */
export function fitOptions(dpt: number): FitOptions {
  return { tolerance: TRACK_FIT.tolerance * dpt, minRadius: TRACK_FIT.minRadius * dpt };
}

/** Why the rule refuses a set of clicks. */
export type Refusal =
  /** A click is not ahead of the click before it along that click's heading, or the other way round. */
  | 'behind'
  /** An arc is tighter than the minimum radius. */
  | 'tight';

/** The line of a set of clicks, or why there is none. */
export type Built = { readonly kind: 'line'; readonly fit: Fit } | { readonly kind: 'refused'; readonly reason: Refusal };

/** The angle of the chord from `a` to `b`. */
function chord(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * The circle through `a`, `b` and `c`, for travel from `a` to `c`: its
 * curvature, and its heading at each of the three. Collinear points give the
 * chord's heading and curvature 0.
 */
function circle3(a: Point, b: Point, c: Point): { curvature: number; ha: number; hb: number; hc: number } {
  const g1 = chord(a, b);
  const g2 = chord(b, c);
  const hb = g1 + wrapAngle(g2 - g1) - wrapAngle(chord(a, c) - g1);
  const curvature = (2 * Math.sin(wrapAngle(g2 - g1))) / Math.hypot(c.x - a.x, c.y - a.y);
  return { curvature, ha: 2 * g1 - hb, hb, hc: 2 * g2 - hb };
}

/**
 * The heading at each of `clicks`, a free stretch of two or more. Two give
 * their chord. Between, a click with two clicks on each side mixes the
 * headings there of the circles behind and ahead, each weighted by how much
 * the curvature changes on the other side, after Akima (1970); the click next
 * to an end takes the heading of the circle through it and its two
 * neighbours. An end takes the one arc through the end gap tangent at the
 * inner click.
 */
function headings(clicks: readonly Point[]): number[] {
  const m = clicks.length;
  if (m === 2) return [chord(clicks[0], clicks[1]), chord(clicks[0], clicks[1])];
  const h = new Array<number>(m);
  for (let i = 1; i < m - 1; i++) {
    const mid = circle3(clicks[i - 1], clicks[i], clicks[i + 1]);
    if (i < 2 || i > m - 3) {
      h[i] = mid.hb;
      continue;
    }
    const behind = circle3(clicks[i - 2], clicks[i - 1], clicks[i]);
    const ahead = circle3(clicks[i], clicks[i + 1], clicks[i + 2]);
    const wb = Math.abs(ahead.curvature - mid.curvature);
    const wf = Math.abs(behind.curvature - mid.curvature);
    const share = wb + wf < 1e-15 ? 0.5 : wf / (wb + wf);
    h[i] = behind.hc + share * wrapAngle(ahead.ha - behind.hc);
  }
  h[0] = 2 * chord(clicks[0], clicks[1]) - h[1];
  h[m - 1] = 2 * chord(clicks[m - 2], clicks[m - 1]) - h[m - 2];
  return h;
}

/** The one arc from `a` with heading `heading` through `b`. */
function arc(a: Point, heading: number, b: Point): Part {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const turn = 2 * wrapAngle(chord(a, b) - heading);
  const length = Math.abs(turn) < 1e-9 ? d : (d * turn) / 2 / Math.sin(turn / 2);
  return { length, curvature: turn / length };
}

/**
 * The equal-chord biarc from `a` with heading `ha` to `b` with heading `hb`:
 * two arcs that meet tangentially on the perpendicular bisector of the chord.
 */
function biarc(a: Point, ha: number, b: Point, hb: number): Part[] {
  const g = chord(a, b);
  const t0 = wrapAngle(ha - g);
  const t1 = wrapAngle(hb - g);
  const k = (Math.hypot(b.x - a.x, b.y - a.y) / 2) * Math.tan((t0 - t1) / 4);
  const joint = { x: (a.x + b.x) / 2 - k * Math.sin(g), y: (a.y + b.y) / 2 + k * Math.cos(g) };
  return [arc(a, ha, joint), arc(joint, g - (t0 + t1) / 2, b)];
}

/**
 * The line through `clicks`, two or more, in order: a function of the
 * clicks alone, built whole. Every gap is free; a click's `straight` mark is
 * not read. Refused when a click is not
 * ahead of the click before it along that click's heading, or that click
 * not behind it along its own, which would loop; or when an arc is tighter
 * than the minimum radius.
 */
export function buildLine(clicks: readonly Click[], opts: FitOptions): Built {
  for (let i = 1; i < clicks.length; i++) {
    if (clicks[i].x === clicks[i - 1].x && clicks[i].y === clicks[i - 1].y) return { kind: 'refused', reason: 'behind' };
  }
  const h = headings(clicks);
  for (let i = 1; i < clicks.length; i++) {
    const g = chord(clicks[i - 1], clicks[i]);
    if (Math.cos(h[i - 1] - g) <= 0 || Math.cos(h[i] - g) <= 0) return { kind: 'refused', reason: 'behind' };
  }
  const parts = clicks.slice(1).flatMap((b, i) => biarc(clicks[i], h[i], b, h[i + 1]));
  if (parts.some(part => Math.abs(part.curvature) * opts.minRadius > 1)) return { kind: 'refused', reason: 'tight' };
  return { kind: 'line', fit: { start: { x: clicks[0].x, y: clicks[0].y, heading: h[0] }, parts } };
}
