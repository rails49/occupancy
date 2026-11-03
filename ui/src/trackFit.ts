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
  | 'tight'
  /** A click of a straight run is more than the tolerance off the run's line. */
  | 'off-straight';

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
 * The heading at each of `clicks`, a free stretch of two or more, where
 * `fixed` gives none. Two give their chord. Between, a click with two clicks
 * on each side mixes the headings there of the circles behind and ahead,
 * each weighted by how much the curvature changes on the other side, after
 * Akima (1970); the click next to an end takes the heading of the circle
 * through it and its two neighbours. An end takes the one arc through the
 * end gap tangent at the inner click.
 */
function headings(clicks: readonly Point[], fixed: readonly (number | null)[]): number[] {
  const m = clicks.length;
  const h = [...fixed];
  if (m === 2 && h[0] === null && h[1] === null) return [chord(clicks[0], clicks[1]), chord(clicks[0], clicks[1])];
  for (let i = 1; i < m - 1; i++) {
    if (h[i] !== null) continue;
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
  h[0] ??= 2 * chord(clicks[0], clicks[1]) - h[1]!;
  h[m - 1] ??= 2 * chord(clicks[m - 2], clicks[m - 1]) - h[m - 2]!;
  return h as number[];
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

/** A straight through `p` with heading `heading`. */
interface Straight {
  readonly p: Point;
  readonly heading: number;
}

/** The foot of `x` on `line`, and how far along it from `line.p`. */
function foot(line: Straight, x: Point): { at: Point; s: number } {
  const s = (x.x - line.p.x) * Math.cos(line.heading) + (x.y - line.p.y) * Math.sin(line.heading);
  return { at: { x: line.p.x + s * Math.cos(line.heading), y: line.p.y + s * Math.sin(line.heading) }, s };
}

/** The total least squares line through `points`, heading from the first towards the last. */
function fitStraight(points: readonly Point[]): Straight {
  const n = points.length;
  const p = { x: points.reduce((s, q) => s + q.x, 0) / n, y: points.reduce((s, q) => s + q.y, 0) / n };
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const q of points) {
    sxx += (q.x - p.x) ** 2;
    sxy += (q.x - p.x) * (q.y - p.y);
    syy += (q.y - p.y) ** 2;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const first = points[0];
  const last = points[n - 1];
  const ahead = (last.x - first.x) * Math.cos(a) + (last.y - first.y) * Math.sin(a) >= 0;
  return { p, heading: ahead ? a : a + Math.PI };
}

/**
 * The circle through `u` then `v` that goes on to touch `line` and leave
 * along it, no tighter than `minRadius` and within a half turn from `u` to
 * `v`: where it touches, and its heading at `u` and `v`. Null when there is
 * none, or it touches the line outside `[from, to]` px along it.
 */
function joinCircle(
  line: Straight,
  u: Point,
  v: Point,
  from: number,
  to: number,
  minRadius: number
): { touch: Point; hu: number; hv: number } | null {
  const half = Math.hypot(v.x - u.x, v.y - u.y) / 2;
  const mid = { x: (u.x + v.x) / 2, y: (u.y + v.y) / 2 };
  const g = chord(u, v);
  // The centre is mid + t w, w the left normal of the chord, and lies as far from the line as from u.
  const w = { x: -Math.sin(g), y: Math.cos(g) };
  const n = { x: -Math.sin(line.heading), y: Math.cos(line.heading) };
  const alpha = n.x * (mid.x - line.p.x) + n.y * (mid.y - line.p.y);
  const beta = n.x * w.x + n.y * w.y;
  const qa = beta * beta - 1;
  const qb = 2 * alpha * beta;
  const qc = alpha * alpha - half * half;
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-12) {
    if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) roots.push((-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa));
  }
  const sweep = (c: Point, sigma: number, a: Point, b: Point) => {
    const d = sigma * (chord(c, b) - chord(c, a));
    return d - 2 * Math.PI * Math.floor(d / (2 * Math.PI));
  };
  let best: { touch: Point; hu: number; hv: number; beyond: number } | null = null;
  for (const t of roots) {
    const c = { x: mid.x + t * w.x, y: mid.y + t * w.y };
    if (Math.hypot(half, t) < minRadius) continue;
    const { at: touch, s } = foot(line, c);
    if (s < from || s > to) continue;
    // Travel round c that leaves along the line where it touches.
    const sigma = (touch.y - c.y) * Math.cos(line.heading) - (touch.x - c.x) * Math.sin(line.heading) <= 0 ? 1 : -1;
    const uv = sweep(c, sigma, u, v);
    const ut = sweep(c, sigma, u, touch);
    if (uv >= Math.PI || ut <= uv) continue;
    if (!best || ut - uv < best.beyond) {
      best = { touch, hu: chord(c, u) + (sigma * Math.PI) / 2, hv: chord(c, v) + (sigma * Math.PI) / 2, beyond: ut - uv };
    }
  }
  return best;
}

/** Where a circle from two free clicks touches a run, and its heading, in the direction of travel, at the click next to the run (`near`) and the one beyond (`far`). */
interface Join {
  readonly touch: Point;
  readonly near: number;
  readonly far: number;
}

/**
 * A run of neighbouring straight gaps: clicks `a` to `b`, its line, and the
 * circles from the free clicks before and after it that meet it, or null.
 */
interface Run {
  readonly a: number;
  readonly b: number;
  readonly line: Straight;
  readonly into: Join | null;
  readonly out: Join | null;
}

/**
 * The line through `clicks`, two or more, in order: a function of the
 * clicks and their marks alone, built whole. A click marked `straight`
 * starts a straight gap; the last click's mark is not read.
 *
 * A run of neighbouring straight gaps is the total least squares line
 * through its clicks. Every other click is on the line. Next to a run, the
 * circle through the two nearest free clicks that touches the run gives
 * their headings and where the run starts or ends, if it is no tighter than
 * the minimum radius and touches the run between the nearest free click and
 * the run's second click, and the run still starts before it ends;
 * otherwise the free gap is two arcs to the foot of the run's end click.
 *
 * Refused when a click is not ahead of the click before it along that
 * click's heading, or that click not behind it along its own, which would
 * loop; when an arc is tighter than the minimum radius; or when a click of a
 * straight run is more than the tolerance off its line.
 */
export function buildLine(clicks: readonly Click[], opts: FitOptions): Built {
  const n = clicks.length;
  for (let i = 1; i < n; i++) {
    if (clicks[i].x === clicks[i - 1].x && clicks[i].y === clicks[i - 1].y) return { kind: 'refused', reason: 'behind' };
  }

  const spans: { a: number; b: number; line: Straight }[] = [];
  for (let g = 0; g < n - 1; g++) {
    if (!clicks[g].straight) continue;
    let b = g + 1;
    while (b < n - 1 && clicks[b].straight) b++;
    const points = clicks.slice(g, b + 1);
    const line = fitStraight(points);
    const n0 = { x: -Math.sin(line.heading), y: Math.cos(line.heading) };
    if (points.some(q => Math.abs(n0.x * (q.x - line.p.x) + n0.y * (q.y - line.p.y)) > opts.tolerance)) {
      return { kind: 'refused', reason: 'off-straight' };
    }
    spans.push({ a: g, b, line });
    g = b - 1;
  }
  const free = (i: number) => i >= 0 && i < n && !spans.some(r => i >= r.a && i <= r.b);
  const runs: Run[] = spans.map(({ a, b, line }) => {
    const into = free(a - 2) && free(a - 1) ? join(line, clicks[a - 2], clicks[a - 1], clicks[a + 1], opts) : null;
    // Looking back along the run.
    const back = { p: line.p, heading: line.heading + Math.PI };
    const away = free(b + 2) && free(b + 1) ? join(back, clicks[b + 2], clicks[b + 1], clicks[b - 1], opts) : null;
    const out = away && { touch: away.touch, near: away.near + Math.PI, far: away.far + Math.PI };
    // On a run of one gap the two circles can touch it the wrong way round.
    if (into && out && foot(line, into.touch).s > foot(line, out.touch).s) return { a, b, line, into: null, out: null };
    return { a, b, line, into, out };
  });

  const h = new Array<number>(n);
  for (const r of runs) for (let i = r.a; i <= r.b; i++) h[i] = r.line.heading;
  for (let i = 0; i < n; i++) {
    if (!free(i)) continue;
    let j = i;
    while (free(j + 1)) j++;
    const before = runs.find(r => r.b === i - 1);
    const after = runs.find(r => r.a === j + 1);
    freeHeadings(clicks, i, j, before, after).forEach((hk, k) => (h[i + k] = hk));
    i = j;
  }

  for (let i = 1; i < n; i++) {
    const g = chord(clicks[i - 1], clicks[i]);
    if (Math.cos(h[i - 1] - g) <= 0 || Math.cos(h[i] - g) <= 0) return { kind: 'refused', reason: 'behind' };
  }

  // The line goes through each free click and along each run from its start to its end.
  const ways: { p: Point; h: number; straight: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const r = runs.find(q => q.a === i);
    if (!r) {
      ways.push({ p: clicks[i], h: h[i], straight: false });
      continue;
    }
    ways.push({ p: runStart(r, clicks), h: r.line.heading, straight: true }, { p: runEnd(r, clicks), h: r.line.heading, straight: false });
    i = r.b;
  }
  const parts: Part[] = [];
  for (let k = 0; k + 1 < ways.length; k++) {
    const [a, b] = [ways[k], ways[k + 1]];
    if (!a.straight) {
      parts.push(...biarc(a.p, a.h, b.p, b.h));
      continue;
    }
    const length = (b.p.x - a.p.x) * Math.cos(a.h) + (b.p.y - a.p.y) * Math.sin(a.h);
    if (length < 0) return { kind: 'refused', reason: 'behind' };
    parts.push({ length, curvature: 0 });
  }
  if (parts.some(part => Math.abs(part.curvature) * opts.minRadius > 1)) return { kind: 'refused', reason: 'tight' };
  return { kind: 'line', fit: { start: { x: ways[0].p.x, y: ways[0].p.y, heading: ways[0].h }, parts } };
}

/** Where run `r` starts: where the circle into it touches, or the foot of its first click. */
function runStart(r: Run, clicks: readonly Click[]): Point {
  return r.into?.touch ?? foot(r.line, clicks[r.a]).at;
}

/** Where run `r` ends: where the circle out of it touches, or the foot of its last click. */
function runEnd(r: Run, clicks: readonly Click[]): Point {
  return r.out?.touch ?? foot(r.line, clicks[r.b]).at;
}

/**
 * The circle through free clicks `far` then `near` that meets `line`
 * between the foot of `near` and the foot of `second`, the run's second
 * click, or null (`joinCircle`).
 */
function join(line: Straight, far: Point, near: Point, second: Point, opts: FitOptions): Join | null {
  const c = joinCircle(line, far, near, foot(line, near).s, foot(line, second).s, opts.minRadius);
  return c && { touch: c.touch, near: c.hv, far: c.hu };
}

/**
 * The headings at free clicks `i` to `j`, with run `before` ending just
 * before them and run `after` starting just after them, if any. Next to a
 * run, the circle that meets it sets the heading of the click next to it
 * and, with four clicks or more, of the one beyond.
 */
function freeHeadings(clicks: readonly Click[], i: number, j: number, before?: Run, after?: Run): number[] {
  const free = clicks.slice(i, j + 1);
  const m = free.length;
  if (m === 1) {
    const hs: number[] = [];
    if (before) hs.push(2 * chord(runEnd(before, clicks), free[0]) - before.line.heading);
    if (after) hs.push(2 * chord(free[0], runStart(after, clicks)) - after.line.heading);
    return [hs.length === 1 ? hs[0] : hs[0] + wrapAngle(hs[1] - hs[0]) / 2];
  }
  const fixed: (number | null)[] = new Array(m).fill(null);
  if (before?.out) {
    fixed[0] = before.out.near;
    if (m >= 4) fixed[1] = before.out.far;
  }
  if (after?.into) {
    fixed[m - 1] = after.into.near;
    if (m >= 4) fixed[m - 2] = after.into.far;
  }
  return headings(free, fixed);
}
