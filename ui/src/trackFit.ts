import type { Point } from '@rails49/r49';
import { wrapAngle } from './track.js';
import type { TrackNode } from './track.js';

/**
 * Straights and circular arcs, tangent where they meet, traced along the
 * middle of a track by the projection rule (#311). Pure; `trackTrace.ts`
 * drives it.
 *
 * A line is a start pose and a length and a curvature per part (curvature 0
 * is a straight); tangency holds by construction. `extend` takes the line
 * of the clicks so far and one more click: the first clicks set the first
 * part's position, direction and curvature; after that a click within the
 * tolerance of the projection, the current part carried on past its last
 * click, continues the part, which is refit over its clicks, and a click
 * beyond it starts a new part at the join, which the click bends.
 */

/** The rule's constants, in gauges. `traceOptions` converts them through DPT. */
export const TRACK_FIT = {
  /** How far a click may lie from the projection and still continue its part. */
  tolerance: 0.5,
  /** Tightest arc track comes in. */
  minRadius: 15,
  /** How far a click must be from every centerline to start a line. */
  startDistance: 1,
} as const;

export interface FitOptions {
  /** How far a click may lie from the projection and still continue its part, px. */
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

/** A line and which clicks each part owns. */
export interface Line {
  readonly fit: Fit;
  /** Index of the first click of each part; a part's clicks run to the next part's first. */
  readonly firstClick: readonly number[];
}

/** What a click does to the line: goes on it, adds nothing, or is refused. */
export type Step =
  | { readonly kind: 'added'; readonly line: Line }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'refused' };

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

/** `q` in the frame of `p`: along its heading, and across to its left. */
function frame(p: Pose, q: Point): [number, number] {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  return [dx * Math.cos(p.heading) + dy * Math.sin(p.heading), dy * Math.cos(p.heading) - dx * Math.sin(p.heading)];
}

/**
 * Arc length to the foot of `q` on the straight or circle of curvature `k`
 * from `p`, carried on without limit; on a circle, within half a turn of
 * `near`.
 */
function foot(p: Pose, k: number, q: Point, near: number): number {
  if (Math.abs(k) < 1e-12) return frame(p, q)[0];
  const cx = p.x - Math.sin(p.heading) / k;
  const cy = p.y + Math.cos(p.heading) / k;
  const phi0 = Math.atan2(p.y - cy, p.x - cx);
  return near + wrapAngle(Math.atan2(q.y - cy, q.x - cx) - (phi0 + k * near)) / k;
}

/** The circle through three points: its curvature for travel from the first to the last, and the heading at the first. */
function through(a: Point, b: Point, c: Point): { curvature: number; heading: number } {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const cx = c.x - a.x;
  const cy = c.y - a.y;
  const d = 2 * (bx * cy - by * cx);
  const chord = Math.atan2(cy, cx);
  if (Math.abs(d) < 1e-9 * (bx * bx + by * by + cx * cx + cy * cy)) return { curvature: 0, heading: chord };
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / d;
  const uy = (bx * c2 - cx * b2) / d;
  const r = Math.hypot(ux, uy);
  const left = d > 0 ? 1 : -1;
  // The tangent at `a` is the radius from the centre (ux, uy) turned a quarter against the travel.
  return { curvature: left / r, heading: Math.atan2(-uy, -ux) + (left * Math.PI) / 2 };
}

/** Signed distance of `q` from the straight or circle of curvature `k` from `p`, carried on without limit. */
function offset(p: Pose, k: number, q: Point): number {
  const [a, b] = frame(p, q);
  return (k * (a * a + b * b) - 2 * b) / (1 + Math.hypot(k * a, 1 - k * b));
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const pivot = m[c][c] || 1e-30;
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / pivot;
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];
    for (let k = r + 1; k < n; k++) sum -= m[r][k] * x[k];
    x[r] = sum / (m[r][r] || 1e-30);
  }
  return x;
}

const sumSq = (r: readonly number[]) => r.reduce((s, x) => s + x * x, 0);

/** Levenberg-Marquardt from `v0`: the least squares of `residuals` over one or two parameters. */
function leastSquares(v0: readonly number[], residuals: (v: readonly number[]) => number[]): number[] {
  const h = 1e-6;
  let v = [...v0];
  let r = residuals(v);
  let cost = sumSq(r);
  let lambda = 1e-3;
  for (let iter = 0; iter < 100; iter++) {
    const jac = v.map((x, i) => {
      const w = [...v];
      w[i] = x + h;
      return residuals(w).map((y, k) => (y - r[k]) / h);
    });
    const a = jac.map(ci => jac.map(cj => ci.reduce((s, x, k) => s + x * cj[k], 0)));
    const g = jac.map(col => col.reduce((s, x, k) => s + x * r[k], 0));
    let improved = false;
    while (lambda < 1e10) {
      const damped = a.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-12 : x)));
      const delta = solve(damped, g.map(x => -x));
      const w = v.map((x, i) => x + delta[i]);
      const rw = residuals(w);
      const cw = sumSq(rw);
      if (cw < cost) {
        improved = cost - cw > 1e-9 * (cost + 1e-9);
        v = w;
        r = rw;
        cost = cw;
        lambda = Math.max(1e-9, lambda / 3);
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return v;
}

/**
 * A part refit by least squares over `clicks`, its own with the new one on
 * the end: start fixed, heading free on the first part only, curvature
 * free, length to the foot of the farthest click. Null for a radius under
 * the minimum.
 */
function refit(start: Pose, part: Part, first: boolean, clicks: readonly Point[], opts: FitOptions): { start: Pose; part: Part } | null {
  const scale = opts.minRadius;
  const pose = (v: readonly number[]) => (first ? { ...start, heading: v[0] } : start);
  const curvature = (v: readonly number[]) => v[first ? 1 : 0] / scale;
  const v = leastSquares(first ? [start.heading, part.curvature * scale] : [part.curvature * scale], w =>
    clicks.map(q => offset(pose(w), curvature(w), q))
  );
  const k = curvature(v);
  if (Math.abs(k) > 1 / opts.minRadius) return null;
  const at = pose(v);
  let length = 0;
  let near = 0;
  for (const q of clicks) {
    near = foot(at, k, q, near);
    length = Math.max(length, near);
  }
  return { start: at, part: { length, curvature: k } };
}

/** The clicks of part `i`. */
function clicksOf(line: Line, clicks: readonly Point[], i: number): Point[] {
  return clicks.slice(line.firstClick[i], line.firstClick[i + 1] ?? clicks.length);
}

/** How far each click lies from its part, carried on without limit, px. */
export function distances(line: Line, clicks: readonly Point[]): number[] {
  const ps = poses(line.fit);
  return line.fit.parts.flatMap((part, i) => clicksOf(line, clicks, i).map(q => Math.abs(offset(ps[i], part.curvature, q))));
}

/** The pose at the start of each part, and one more at the end of the line. */
export function poses(fit: Fit): Pose[] {
  const out: Pose[] = [fit.start];
  for (const part of fit.parts) out.push(advance(out[out.length - 1], part.length, part.curvature));
  return out;
}

/** Where the line goes on from: its end, and the curvature of the current part. */
export interface Ahead {
  readonly start: Pose;
  readonly curvature: number;
}

/** The end of the line and the current part's curvature, from which the projection and the tangent run. */
export function ahead(line: Line): Ahead {
  const { parts } = line.fit;
  return { start: poses(line.fit)[parts.length], curvature: parts[parts.length - 1].curvature };
}

/**
 * The line of `clicks` with `p` on the end, given the line of `clicks`
 * (null before the second). Two clicks make a straight.
 */
export function extend(line: Line | null, clicks: readonly Point[], p: Point, opts: FitOptions): Step {
  if (!line) {
    const a = clicks[0];
    const length = Math.hypot(p.x - a.x, p.y - a.y);
    if (length === 0) return { kind: 'ignored' };
    const start = { x: a.x, y: a.y, heading: Math.atan2(p.y - a.y, p.x - a.x) };
    return { kind: 'added', line: { fit: { start, parts: [{ length, curvature: 0 }] }, firstClick: [0] } };
  }
  const { fit, firstClick } = line;
  const parts = fit.parts;
  const m = parts.length;
  const last = parts[m - 1];
  const at = poses(fit)[m - 1];
  const s = foot(at, last.curvature, p, last.length);
  if (s <= last.length + 1e-6) return { kind: 'ignored' };
  if (m === 1 && clicks.length === 2) {
    const { curvature, heading } = through(clicks[0], clicks[1], p);
    if (Math.abs(curvature) > 1 / opts.minRadius) return { kind: 'refused' };
    const start = { ...fit.start, heading };
    const length = foot(start, curvature, p, foot(start, curvature, clicks[1], 0));
    return { kind: 'added', line: { fit: { start, parts: [{ length, curvature }] }, firstClick } };
  }
  if (Math.abs(offset(at, last.curvature, p)) <= opts.tolerance) {
    const own = [...clicksOf(line, clicks, m - 1), p];
    const fitted = refit(at, last, m === 1, own, opts);
    if (!fitted) return { kind: 'refused' };
    const start = m === 1 ? fitted.start : fit.start;
    return { kind: 'added', line: { fit: { start, parts: [...parts.slice(0, m - 1), fitted.part] }, firstClick } };
  }
  // A new part at the join, with the heading there: the one circle through the click.
  const join = advance(at, last.length, last.curvature);
  const [a, b] = frame(join, p);
  const curvature = (2 * b) / (a * a + b * b);
  if (Math.abs(curvature) > 1 / opts.minRadius) return { kind: 'refused' };
  const length = Math.abs(curvature) < 1e-12 ? a : (2 * Math.atan2(b, a)) / curvature;
  return { kind: 'added', line: { fit: { start: fit.start, parts: [...parts, { length, curvature }] }, firstClick: [...firstClick, clicks.length] } };
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
