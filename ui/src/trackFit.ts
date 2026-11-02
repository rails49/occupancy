import type { Point } from '@rails49/r49';
import { wrapAngle } from './track.js';
import type { TrackNode } from './track.js';

/**
 * Fit straights and circular arcs, tangent where they meet, to clicks along
 * the middle of a track (#298). Pure; `trackTrace.ts` drives it.
 *
 * A fit is a start pose and a length and a curvature per part (curvature 0
 * is a straight); tangency holds by construction. The start pose is free
 * (the line's start) or fixed (a committed join).
 *
 * Parts are chosen by dynamic programming over the points (squared error
 * over σ² plus ln n per parameter, docs/research/track-fitting-methods.md),
 * chained part by part, refit jointly by Levenberg-Marquardt within bounds,
 * split once where points are out of tolerance, then merged or straightened
 * while that lowers the cost. A line still out of tolerance after the split
 * is returned as it is, so points nothing fits cost two segmentations, a
 * small refit per part and at most two whole refits of at most 100 steps.
 * Each join's position uncertainty comes from the inverse of the normal
 * matrix the refit forms.
 *
 * A run may leave out one interior point that no straight or arc through
 * its neighbours reaches (an outlier). Such a point is reported and never
 * deleted. A run's first and last point are always fitted through, so the
 * line's ends are too; two bad clicks in a row split the part.
 */

/** The fit's constants, in gauges (`maxSweep` in radians). `traceOptions` converts them through DPT. */
export const TRACK_FIT = {
  /** Largest distance a click may lie from the line. */
  tolerance: 0.25,
  /** Expected click noise. Sets the cost of a part and scales the uncertainties. */
  noise: 0.075,
  /** A join whose position σ is under this is committed. */
  commitSigma: 0.25,
  /** Longest σ bar drawn at a join. */
  barCap: 4,
  minLength: 1,
  minRadius: 10,
  maxSweep: Math.PI,
} as const;

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

export interface Bounds {
  /** Shortest part, px. */
  readonly minLength: number;
  /** Tightest arc, px. */
  readonly minRadius: number;
  /** Largest turn of one arc, rad. */
  readonly maxSweep: number;
}

export interface FitOptions {
  /** Largest distance a point may lie from the line, px. */
  readonly tolerance: number;
  /** Expected click noise, px. Sets the cost of a part and scales the uncertainties. */
  readonly noise: number;
  readonly bounds: Bounds;
}

/** A pose on the line with its position uncertainty: σ along the long axis (ux, uy). */
export interface Join {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly sigma: number;
  readonly ux: number;
  readonly uy: number;
}

export interface FitResult {
  readonly fit: Fit;
  /** Signed distance of each point from the line, px. */
  readonly residuals: readonly number[];
  /** Index of the part nearest each point. */
  readonly partOf: readonly number[];
  /** Largest distance of a point the fit kept. */
  readonly worst: number;
  readonly rms: number;
  /** The pose at the start of each part, then at the line's end. */
  readonly joins: readonly Join[];
  /** Indices of points the fit left out as outliers; their residuals are still reported. */
  readonly outliers: readonly number[];
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

/** The pose at the start of each part, and one more at the end of the line. */
export function poses(fit: Fit): Pose[] {
  const out: Pose[] = [fit.start];
  for (const part of fit.parts) out.push(advance(out[out.length - 1], part.length, part.curvature));
  return out;
}

interface Projection {
  s: number;
  /** Distance, negative to the right. */
  d: number;
  /** The nearest point. */
  x: number;
  y: number;
}

/** Nearest point on a part from `start`, its arc length `s` held in [lo, hi]. */
function project(q: Point, start: Pose, k: number, lo: number, hi: number): Projection {
  let s: number;
  if (Math.abs(k) < 1e-12) {
    s = (q.x - start.x) * Math.cos(start.heading) + (q.y - start.y) * Math.sin(start.heading);
  } else {
    const cx = start.x - Math.sin(start.heading) / k;
    const cy = start.y + Math.cos(start.heading) / k;
    const phi0 = Math.atan2(start.y - cy, start.x - cx);
    const mid = (lo + hi) / 2;
    s = mid + wrapAngle(Math.atan2(q.y - cy, q.x - cx) - (phi0 + k * mid)) / k;
  }
  s = Math.min(hi, Math.max(lo, s));
  const f = advance(start, s, k);
  const vx = q.x - f.x;
  const vy = q.y - f.y;
  // The whole distance, signed by side: past a part's end it is not all across the track.
  const dist = Math.hypot(vx, vy);
  return { s, d: Math.cos(f.heading) * vy - Math.sin(f.heading) * vx < 0 ? -dist : dist, x: f.x, y: f.y };
}

interface Evaluation {
  d: number[];
  s: number[];
  part: number[];
  /** What each point's nearest point lies on: a part, or the line extended, -1 before it and m past it. */
  on: number[];
  /** How far along that part, or along the line extended. */
  u: number[];
  /** Each point's nearest point. */
  x: number[];
  y: number[];
  total: number;
}

/**
 * Each point's signed distance and arc length. The first point is matched on
 * the first part and the last on the last, so a line that closes on itself
 * keeps its ends apart; only they may fall on the line extended straight
 * past its ends. Every other point must be matched by the line itself.
 */
function evaluate(fit: Fit, points: readonly Point[]): Evaluation {
  const ps = poses(fit);
  const m = fit.parts.length;
  const offsets = [0];
  for (const p of fit.parts) offsets.push(offsets[offsets.length - 1] + p.length);
  const total = offsets[m];
  const mids = fit.parts.map((p, i) => advance(ps[i], p.length / 2, p.curvature));
  const out: Evaluation = { d: [], s: [], part: [], on: [], u: [], x: [], y: [], total };
  let hint = 0;
  for (const [k, q] of points.entries()) {
    const first = k === 0;
    const last = k === points.length - 1;
    let best: Projection = first ? project(q, ps[0], 0, -Infinity, 0) : { s: 0, d: Infinity, x: 0, y: 0 };
    let bestPart = first ? -1 : m;
    let u = 0;
    const from = last && !first ? m - 1 : 0;
    const to = first && !last ? 1 : m;
    // The part the point before matched goes first; a part whose midpoint is further than the
    // best distance so far plus half its length cannot be nearer, and is skipped.
    const h = Math.min(to - 1, Math.max(from, hint));
    for (let j = from - 1; j < to; j++) {
      const i = j < from ? h : j;
      if (j === h) continue;
      const part = fit.parts[i];
      const reach = Math.abs(best.d) + part.length / 2;
      if ((q.x - mids[i].x) ** 2 + (q.y - mids[i].y) ** 2 > reach * reach) continue;
      const pr = project(q, ps[i], part.curvature, 0, part.length);
      // Equal distances go to the lower part, as a scan in order would.
      if (Math.abs(pr.d) < Math.abs(best.d) || (Math.abs(pr.d) === Math.abs(best.d) && i < bestPart)) {
        best = { ...pr, s: offsets[i] + pr.s };
        bestPart = i;
        u = pr.s;
      }
    }
    let on = bestPart;
    if (on < 0) u = best.s;
    bestPart = Math.max(0, Math.min(m - 1, bestPart));
    if (last) {
      const end = project(q, ps[m], 0, 0, Infinity);
      if (Math.abs(end.d) < Math.abs(best.d)) {
        best = { ...end, s: total + end.s };
        bestPart = m - 1;
        on = m;
        u = end.s;
      }
    }
    hint = bestPart;
    out.d.push(best.d);
    out.s.push(best.s);
    out.part.push(bestPart);
    out.on.push(on);
    out.u.push(u);
    out.x.push(best.x);
    out.y.push(best.y);
  }
  return out;
}

/** Index of the part nearest each point. */
export function nearestParts(fit: Fit, points: readonly Point[]): number[] {
  return evaluate(fit, points).part;
}

/** Arc length along the line of the nearest point to each point. */
export function positionsAlong(fit: Fit, points: readonly Point[]): number[] {
  return evaluate(fit, points).s;
}

/** Huber: a residual past `c` counts linearly, so one bad click cannot bend the line. */
function robust(r: number, c: number): number {
  const a = Math.abs(r);
  return a <= c ? r : Math.sign(r) * Math.sqrt(c * (2 * a - c));
}

/**
 * Residuals: each distance, then how far the line's ends miss the first point
 * (a free start only) and the last.
 */
function residuals(fit: Fit, points: readonly Point[], start: Pose | null, opts: FitOptions): number[] {
  const e = evaluate(fit, points);
  const c = 2 * opts.noise;
  const out = e.d.map(d => robust(d, c));
  if (!start) out.push(e.s[0]);
  out.push(e.s[e.s.length - 1] - e.total);
  return out;
}

/** What the refit may change: the start pose when free (`start` null), each length, and each arc's curvature. */
interface Model {
  readonly start: Pose | null;
  readonly free: readonly boolean[];
  readonly bounds: Bounds;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Lengths and curvatures are mapped so the bounds hold for every parameter value. */
function pack(fit: Fit, m: Model): number[] {
  const v = m.start ? [] : [fit.start.x, fit.start.y, fit.start.heading];
  fit.parts.forEach((p, i) => {
    v.push(Math.sqrt(Math.max(0, p.length - m.bounds.minLength)));
    if (m.free[i]) v.push(Math.atanh(clamp(p.curvature * m.bounds.minRadius, -0.999, 0.999)));
  });
  return v;
}

function unpack(v: readonly number[], m: Model): Fit {
  let j = m.start ? 0 : 3;
  const start = m.start ?? { x: v[0], y: v[1], heading: v[2] };
  const parts = m.free.map(f => {
    const length = m.bounds.minLength + v[j++] ** 2;
    let curvature = f ? Math.tanh(v[j++]) / m.bounds.minRadius : 0;
    if (Math.abs(curvature) * length > m.bounds.maxSweep) {
      curvature = (Math.sign(curvature) * m.bounds.maxSweep) / length;
    }
    return { length, curvature };
  });
  return { start, parts };
}

function steps(m: Model): number[] {
  const h = m.start ? [] : [1e-3, 1e-3, 1e-6];
  for (const f of m.free) {
    h.push(1e-3);
    if (f) h.push(1e-4);
  }
  return h;
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

function inverse(a: number[][]): number[][] {
  const n = a.length;
  const cols = Array.from({ length: n }, (_, j) => solve(a, a.map((_, i) => (i === j ? 1 : 0))));
  return Array.from({ length: n }, (_, i) => cols.map(col => col[i]));
}

const sumSq = (r: readonly number[]) => r.reduce((s, x) => s + x * x, 0);

/** One column per parameter: the change of `f` per unit step, by forward differences. */
function jacobian(v: readonly number[], h: readonly number[], r0: readonly number[], f: (v: readonly number[]) => number[]): number[][] {
  return v.map((_, j) => {
    const w = [...v];
    w[j] += h[j];
    return f(w).map((x, i) => (x - r0[i]) / h[j]);
  });
}

/**
 * How the point `u` along an arc from a pose at heading 0 moves per unit of
 * curvature `k`: along the heading, then to its left.
 */
function bend(u: number, k: number): [number, number] {
  const x = k * u;
  if (Math.abs(x) < 1e-2) return [(-u * u * u * k) / 3, (u * u) / 2 - (u * u * x * x) / 8];
  return [(x * Math.cos(x) - Math.sin(x)) / (k * k), (x * Math.sin(x) - 1 + Math.cos(x)) / (k * k)];
}

/**
 * The residuals' Jacobian, one column per packed parameter. A change of the
 * line moves each point's nearest point on it, and the distance changes by
 * that move toward the point. The end residuals are differenced.
 */
function residualJacobian(v: readonly number[], m: Model, points: readonly Point[], opts: FitOptions): number[][] {
  const fit = unpack(v, m);
  const parts = fit.parts;
  const n = parts.length;
  const ps = poses(fit);
  const e = evaluate(fit, points);
  const c = 2 * opts.noise;
  const off = m.start ? 0 : 3;
  // Each part's packed columns, and how its length and curvature move with them.
  const lengthAt: number[] = [];
  const curveAt: number[] = [];
  const dLength: number[] = [];
  const dCurve: number[] = [];
  /** Curvature per unit of length, where the sweep bound holds the curvature. */
  const held: number[] = [];
  let j = off;
  for (let i = 0; i < n; i++) {
    const vl = v[j];
    lengthAt.push(j++);
    dLength.push(2 * vl);
    held.push(0);
    if (m.free[i]) {
      const t = Math.tanh(v[j]);
      curveAt.push(j++);
      const k = t / m.bounds.minRadius;
      if (Math.abs(k) * parts[i].length > m.bounds.maxSweep) {
        dCurve.push(0);
        held[i] = -parts[i].curvature / parts[i].length;
      } else dCurve.push((1 - t * t) / m.bounds.minRadius);
    } else {
      curveAt.push(-1);
      dCurve.push(0);
    }
  }
  // Where each part ends, and how that end moves per unit of the part's curvature.
  const ends = parts.map((p, i) => {
    const h = ps[i].heading;
    const [a, b] = bend(p.length, p.curvature);
    return { x: a * Math.cos(h) - b * Math.sin(h), y: a * Math.sin(h) + b * Math.cos(h) };
  });
  const cols = v.map(() => new Array<number>(points.length).fill(0));
  for (const [k, q] of points.entries()) {
    const d = e.d[k];
    const fx = e.x[k];
    const fy = e.y[k];
    const on = e.on[k];
    // The unit vector toward the point, signed as the distance: the left normal when the point is on the line.
    let gx: number;
    let gy: number;
    if (Math.abs(d) > 1e-9) {
      gx = (q.x - fx) / d;
      gy = (q.y - fy) / d;
    } else {
      const p = Math.max(0, Math.min(n - 1, on));
      const h = on >= n ? ps[n].heading : ps[p].heading + (on < 0 ? 0 : parts[p].curvature * e.u[k]);
      gx = -Math.sin(h);
      gy = Math.cos(h);
    }
    const w = Math.abs(d) <= c ? -1 : -Math.sqrt(c / (2 * Math.abs(d) - c));
    /** The residual's change for a move (mx, my) of the nearest point. */
    const by = (mx: number, my: number) => w * (gx * mx + gy * my);
    /** The residual's change for a turn about (ox, oy). */
    const turn = (ox: number, oy: number) => by(-(fy - oy), fx - ox);
    if (!m.start) {
      cols[0][k] = by(1, 0);
      cols[1][k] = by(0, 1);
      cols[2][k] = turn(ps[0].x, ps[0].y);
    }
    const upstream = Math.min(on, n);
    for (let i = 0; i < upstream; i++) {
      const end = ps[i + 1];
      const spin = turn(end.x, end.y);
      const dl = by(Math.cos(end.heading), Math.sin(end.heading)) + parts[i].curvature * spin;
      const dk = by(ends[i].x, ends[i].y) + parts[i].length * spin;
      cols[lengthAt[i]][k] = (dl + held[i] * dk) * dLength[i];
      if (curveAt[i] >= 0) cols[curveAt[i]][k] = dk * dCurve[i];
    }
    if (on >= 0 && on < n) {
      const p = parts[on];
      const u = e.u[k];
      const h0 = ps[on].heading;
      const [a, b] = bend(u, p.curvature);
      const dk = by(a * Math.cos(h0) - b * Math.sin(h0), a * Math.sin(h0) + b * Math.cos(h0));
      // Only a point past the part's end follows its length.
      const h = h0 + p.curvature * u;
      const dl = u >= p.length ? by(Math.cos(h), Math.sin(h)) : 0;
      cols[lengthAt[on]][k] = (dl + held[on] * dk) * dLength[on];
      if (curveAt[on] >= 0) cols[curveAt[on]][k] = dk * dCurve[on];
    }
  }
  // The end residuals depend on the first and last points alone.
  const few = points.length === 1 ? points : [points[0], points[points.length - 1]];
  const endsOf = (w: readonly number[]) => residuals(unpack(w, m), few, m.start, opts).slice(few.length);
  const r0 = endsOf(v);
  const h = steps(m);
  return cols.map((col, i) => {
    const w = [...v];
    w[i] += h[i];
    return [...col, ...endsOf(w).map((x, r) => (x - r0[r]) / h[i])];
  });
}

/** JᵀJ from the columns of J, with a small ridge. */
function normal(jac: number[][]): number[][] {
  const n = jac.length;
  const a = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const ci = jac[i];
      const cj = jac[j];
      let s = 0;
      for (let k = 0; k < ci.length; k++) s += ci[k] * cj[k];
      a[i][j] = s;
      a[j][i] = s;
    }
    a[i][i] += 1e-9;
  }
  return a;
}

/** Levenberg-Marquardt from `start`. */
function refit(start: Fit, points: readonly Point[], m: Model, opts: FitOptions): Fit {
  const f = (v: readonly number[]) => residuals(unpack(v, m), points, m.start, opts);
  let v = pack(start, m);
  let r = f(v);
  let cost = sumSq(r);
  let lambda = 1e-3;
  for (let iter = 0; iter < 100; iter++) {
    const jac = residualJacobian(v, m, points, opts);
    const a = normal(jac);
    const g = jac.map(col => col.reduce((s, x, k) => s + x * r[k], 0));
    let improved = false;
    while (lambda < 1e10) {
      const damped = a.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) : x)));
      const delta = solve(damped, g.map(x => -x));
      const w = v.map((x, i) => x + delta[i]);
      const rw = f(w);
      const cw = sumSq(rw);
      if (cw < cost) {
        const gain = cost - cw;
        v = w;
        r = rw;
        cost = cw;
        lambda = Math.max(1e-9, lambda / 3);
        improved = gain > 1e-6 * (cost + 1e-9);
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return unpack(v, m);
}

/**
 * Each pose's position covariance: σ²(JᵀJ)⁻¹, pushed through the chain to
 * the pose, reduced to its long axis. A fixed start has none.
 */
function joinsOf(fit: Fit, points: readonly Point[], m: Model, opts: FitOptions): Join[] {
  const v = pack(fit, m);
  const h = steps(m);
  const base = unpack(v, m);
  const cov = inverse(normal(residualJacobian(v, m, points, opts)));
  const flat = (ps: Pose[]) => ps.flatMap(p => [p.x, p.y]);
  const p0 = poses(base);
  const pj = jacobian(v, h, flat(p0), w => flat(poses(unpack(w, m))));
  const n = v.length;
  return p0.map((p, q) => {
    const rows = [2 * q, 2 * q + 1];
    const c = rows.map(ri =>
      rows.map(rj => {
        let s = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += pj[i][ri] * cov[i][j] * pj[j][rj];
        return s * opts.noise ** 2;
      })
    );
    const tr = c[0][0] + c[1][1];
    const det = c[0][0] * c[1][1] - c[0][1] * c[1][0];
    const lmax = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    let ux = c[0][1];
    let uy = lmax - c[0][0];
    if (Math.hypot(ux, uy) < 1e-12) {
      ux = lmax - c[1][1];
      uy = c[1][0];
    }
    const len = Math.hypot(ux, uy);
    return {
      ...p,
      sigma: Math.sqrt(Math.max(0, lmax)),
      ux: len > 1e-12 ? ux / len : 1,
      uy: len > 1e-12 ? uy / len : 0,
    };
  });
}

interface LineFit {
  sse: number;
  worst: number;
  /** Signed distance of each point. */
  ds: number[];
  /** Unit direction, oriented first point to last. */
  ux: number;
  uy: number;
  cx: number;
  cy: number;
}

function fitLine(points: readonly Point[]): LineFit {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(angle);
  let uy = Math.sin(angle);
  const a = points[0];
  const b = points[n - 1];
  if ((b.x - a.x) * ux + (b.y - a.y) * uy < 0) {
    ux = -ux;
    uy = -uy;
  }
  let sse = 0;
  let worst = 0;
  const ds: number[] = [];
  for (const p of points) {
    const d = (p.y - my) * ux - (p.x - mx) * uy;
    ds.push(d);
    sse += d * d;
    worst = Math.max(worst, Math.abs(d));
  }
  return { sse, worst, ds, ux, uy, cx: mx, cy: my };
}

interface CircleFit {
  sse: number;
  worst: number;
  ds: number[];
  cx: number;
  cy: number;
  /** Signed curvature for travel from the first point to the last. */
  k: number;
  /** How far the points turn around the centre, first to last, rad. */
  sweep: number;
}

/** Kåsa's algebraic circle fit, then the geometric error of that circle. */
function fitCircle(points: readonly Point[]): CircleFit | null {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suz = 0;
  let svz = 0;
  let sz = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.y - my;
    const z = u * u + v * v;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suz += u * z;
    svz += v * z;
    sz += z;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9 * (suu + svv) ** 2) return null;
  const d = (-suz * svv + svz * suv) / det;
  const e = (-svz * suu + suz * suv) / det;
  const f = -sz / n;
  const r2 = (d * d + e * e) / 4 - f;
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);
  const cx = mx - d / 2;
  const cy = my - e / 2;
  let sse = 0;
  let worst = 0;
  const ds: number[] = [];
  for (const p of points) {
    const dd = Math.hypot(p.x - cx, p.y - cy) - r;
    ds.push(dd);
    sse += dd * dd;
    worst = Math.max(worst, Math.abs(dd));
  }
  // The way the points travel around the centre; the chord's side flips past 180°.
  let turn = 0;
  for (let i = 1; i < n; i++) {
    const ax = points[i - 1].x - cx;
    const ay = points[i - 1].y - cy;
    const bx = points[i].x - cx;
    const by = points[i].y - cy;
    turn += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return { sse, worst, ds, cx, cy, k: Math.sign(turn) / r, sweep: Math.abs(turn) };
}

/** Arc length along the points, point to point. */
function chords(points: readonly Point[]): number[] {
  const s = [0];
  for (let i = 1; i < points.length; i++) {
    s.push(s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return s;
}

/** Start pose on a group's line or circle, at its first point, heading toward its last. */
function startPose(points: readonly Point[], line: LineFit, circle: CircleFit | null): Pose {
  const p = points[0];
  if (!circle) {
    const t = (p.x - line.cx) * line.ux + (p.y - line.cy) * line.uy;
    return { x: line.cx + t * line.ux, y: line.cy + t * line.uy, heading: Math.atan2(line.uy, line.ux) };
  }
  const r = 1 / Math.abs(circle.k);
  const len = Math.hypot(p.x - circle.cx, p.y - circle.cy);
  const x = circle.cx + (r * (p.x - circle.cx)) / len;
  const y = circle.cy + (r * (p.y - circle.cy)) / len;
  // The centre sits to the left of the heading at distance 1/k.
  const heading = Math.atan2(-circle.k * (circle.cx - x), circle.k * (circle.cy - y));
  return { x, y, heading };
}

interface Group {
  from: number;
  to: number;
  arc: boolean;
  /** Index of the one interior point this run leaves out, or -1. */
  drop: number;
}

/**
 * The index in 2..n-3 of the largest residual: two points on each side, so
 * a bad point next to a run's end is never mistaken for its neighbour.
 */
function worstInterior(ds: readonly number[]): number {
  let j = 2;
  for (let i = 3; i < ds.length - 2; i++) if (Math.abs(ds[i]) > Math.abs(ds[j])) j = i;
  return j;
}

interface RunCost {
  cost: number;
  /** Index within the run of the one interior point left out, or -1. */
  drop: number;
}

/**
 * The cost of a straight, or an arc, through every point of a run; Infinity
 * when it does not fit. A run pays for its own fit's parameters (a line has
 * two, a circle three) and for where it starts. When `lenient`, a point out
 * of tolerance costs as much as one at the tolerance instead of ruling the
 * run out.
 */
function plainCost(run: readonly Point[], arc: boolean, opts: FitOptions, perParam: number, lenient: boolean): number {
  // Three points fit any circle, which says nothing about the track.
  const fit = !arc ? fitLine(run) : run.length < 4 ? null : fitCircle(run);
  if (!fit) return Infinity;
  if ('k' in fit && (Math.abs(fit.k) * opts.bounds.minRadius > 1 || fit.sweep > opts.bounds.maxSweep)) return Infinity;
  if (!lenient && fit.worst > opts.tolerance) return Infinity;
  const t2 = opts.tolerance ** 2;
  const sse = fit.ds.reduce((sum, d) => sum + Math.min(d * d, t2), 0);
  return sse / opts.noise ** 2 + (arc ? 4 : 3) * perParam;
}

/**
 * The cost of a straight, or an arc, through a run. When it does not reach
 * every point, the interior point furthest from the line, or from the circle
 * (they differ when the circle bends toward the outlier), is left out at the
 * price of one more parameter, and the rest must then fit as they are.
 */
function runCost(run: readonly Point[], arc: boolean, opts: FitOptions, perParam: number, lenient: boolean): RunCost {
  const plain = { cost: plainCost(run, arc, opts, perParam, lenient), drop: -1 };
  if (plain.cost < Infinity || run.length < 5) return plain;
  const circle = fitCircle(run);
  let best = plain;
  for (const j of new Set([worstInterior(fitLine(run).ds), ...(circle ? [worstInterior(circle.ds)] : [])])) {
    const cost = plainCost([...run.slice(0, j), ...run.slice(j + 1)], arc, opts, perParam, lenient) + perParam;
    if (cost < best.cost) best = { cost, drop: j };
  }
  return best;
}

/**
 * Groups of three or more points, each a straight or an arc, at the least
 * total cost. Two straights never follow each other: tangent, they would be
 * one straight. When no groups fit within the tolerance, the groups are
 * chosen again with `lenient` costs.
 */
function segment(points: readonly Point[], opts: FitOptions, lenient = false): Group[] {
  const n = points.length;
  const perParam = Math.log(n);
  // The cheapest groups for points[0..to), ending in a straight [0] or an arc [1].
  const best = Array.from({ length: n + 1 }, () => [Infinity, Infinity]);
  const choice = Array.from({ length: n + 1 }, (): (Group | null)[] => [null, null]);
  best[0] = [0, 0];
  // Two points fit any straight exactly, which says nothing about the track.
  for (let to = 3; to <= n; to++) {
    // Runs grow back from `to`. Once one of six or more points fits neither a straight nor an
    // arc, a longer one would not either, and the search stops; lenient costs rule nothing out.
    for (let from = to - 3; from >= 0; from--) {
      const run = points.slice(from, to);
      let fits = lenient || run.length < 6;
      for (const arc of [false, true]) {
        const before = arc || from === 0 ? Math.min(...best[from]) : best[from][1];
        if (before === Infinity && fits) continue;
        const r = runCost(run, arc, opts, perParam, lenient);
        fits ||= r.cost < Infinity;
        const c = before + r.cost;
        const k = arc ? 1 : 0;
        // Ties go to the longer run, as a search from the front would.
        if (c <= best[to][k] && c < Infinity) {
          best[to][k] = c;
          choice[to][k] = { from, to, arc, drop: r.drop < 0 ? -1 : from + r.drop };
        }
      }
      if (!fits) break;
    }
  }
  if (Math.min(...best[n]) === Infinity) {
    // Under three points, one straight.
    return !lenient && n >= 3 ? segment(points, opts, true) : [{ from: 0, to: n, arc: false, drop: -1 }];
  }
  const groups: Group[] = [];
  let k = best[n][0] <= best[n][1] ? 0 : 1;
  for (let at = n; at > 0; ) {
    const g = choice[at][k] as Group;
    groups.unshift(g);
    at = g.from;
    // The group before a straight is an arc; before an arc, the cheaper.
    k = !g.arc ? 1 : best[at][0] <= best[at][1] ? 0 : 1;
  }
  return groups;
}

/**
 * A first G1 line, from `start` when it is fixed. Each part starts from its
 * group's independent fit and is then refit, with the part before it, to
 * their groups' points from where the line before them ends, so the line
 * follows the points however many parts it has.
 */
function chain(points: readonly Point[], groups: readonly Group[], start: Pose | null, opts: FitOptions): Fit {
  const off = start ? 1 : 0;
  const s = chords(start ? [start, ...points] : points);
  const parts: Part[] = groups.map((g, i) => {
    const lo = i === 0 ? 0 : (s[groups[i - 1].to - 1 + off] + s[g.from + off]) / 2;
    const hi = i === groups.length - 1 ? s[s.length - 1] : (s[g.to - 1 + off] + s[g.to + off]) / 2;
    const run = points.slice(g.from, g.to);
    const circle = g.arc ? fitCircle(run) : null;
    return { length: Math.max(1, hi - lo), curvature: circle ? circle.k : 0 };
  });
  const first = points.slice(groups[0].from, groups[0].to);
  const origin = start ?? startPose(first, fitLine(first), groups[0].arc ? fitCircle(first) : null);
  for (let i = 0; i < parts.length; i++) {
    const a = Math.max(0, i - 1);
    const from = poses({ start: origin, parts: parts.slice(0, a) })[a];
    // A fixed start may point a little off the points, so every part may bend, as in the refit after.
    const m: Model = { start: from, free: groups.slice(a, i + 1).map(g => g.arc || start !== null), bounds: opts.bounds };
    const fitted = refit({ start: from, parts: parts.slice(a, i + 1) }, points.slice(groups[a].from, groups[i].to), m, opts);
    parts.splice(a, fitted.parts.length, ...fitted.parts);
  }
  return { start: origin, parts };
}

const freeOf = (fit: Fit) => fit.parts.map(p => p.curvature !== 0);

function result(fit: Fit, points: readonly Point[], start: Pose | null, opts: FitOptions, outliers: readonly number[] = []): FitResult {
  const e = evaluate(fit, points);
  const out = new Set(outliers);
  const kept = e.d.filter((_, i) => !out.has(i));
  const worst = Math.max(...kept.map(Math.abs));
  const rms = Math.sqrt(sumSq(kept) / kept.length);
  const m: Model = { start, free: freeOf(fit), bounds: opts.bounds };
  const inliers = out.size ? points.filter((_, i) => !out.has(i)) : points;
  return { fit, residuals: e.d, partOf: e.part, worst, rms, joins: joinsOf(fit, inliers, m, opts), outliers };
}

/** Split part `i` into two halves of the same curvature. */
function halve(fit: Fit, i: number): Fit {
  const p = fit.parts[i];
  const half = { length: p.length / 2, curvature: p.curvature };
  return { ...fit, parts: [...fit.parts.slice(0, i), half, half, ...fit.parts.slice(i + 1)] };
}

/** Halve the part holding the most points beyond the tolerance, and refit. */
function split(res: FitResult, points: readonly Point[], start: Pose | null, opts: FitOptions): FitResult {
  const outside = new Array<number>(res.fit.parts.length).fill(0);
  res.residuals.forEach((d, i) => {
    if (Math.abs(d) > opts.tolerance) outside[res.partOf[i]]++;
  });
  const worstPart = outside.indexOf(Math.max(...outside));
  const halved = halve(res.fit, worstPart);
  // A straight that cannot reach the points has to bend.
  const free = halved.parts.map((p, i) => p.curvature !== 0 || i === worstPart || i === worstPart + 1);
  return result(refit(halved, points, { start, free, bounds: opts.bounds }, opts), points, start, opts);
}

/** The cost of a fitted line: squared error over σ² plus ln n per parameter. */
function penalised(res: FitResult, opts: FitOptions): number {
  const params = res.fit.parts.reduce((sum, p) => sum + (p.curvature !== 0 ? 2 : 1), 0);
  return sumSq(res.residuals) / opts.noise ** 2 + Math.log(res.residuals.length) * params;
}

/** Consecutive straights made one. */
function joinStraights(parts: readonly Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.curvature === 0 && p.curvature === 0) out[out.length - 1] = { length: last.length + p.length, curvature: 0 };
    else out.push(p);
  }
  return out;
}

/**
 * The independent fits overfit, so after the joint refit try each merge of
 * two neighbours and each arc made straight, and keep the cheapest while it
 * lowers the cost and stays within the tolerance.
 */
function simplify(first: FitResult, points: readonly Point[], start: Pose | null, opts: FitOptions): FitResult {
  let res = first;
  let cost = penalised(res, opts);
  for (;;) {
    const parts = res.fit.parts;
    const trials: Part[][] = [];
    for (let i = 0; i + 1 < parts.length; i++) {
      const a = parts[i];
      const b = parts[i + 1];
      const length = a.length + b.length;
      const curvature = (a.curvature * a.length + b.curvature * b.length) / length;
      trials.push([...parts.slice(0, i), { length, curvature }, ...parts.slice(i + 2)]);
    }
    parts.forEach((p, i) => {
      if (p.curvature !== 0) trials.push(joinStraights(parts.map((q, j) => (j === i ? { length: q.length, curvature: 0 } : q))));
    });
    let best: FitResult | null = null;
    let bestCost = cost;
    for (const trial of trials) {
      const fit = { ...res.fit, parts: trial };
      const fitted = result(refit(fit, points, { start, free: freeOf(fit), bounds: opts.bounds }, opts), points, start, opts);
      const c = penalised(fitted, opts);
      if (fitted.worst <= opts.tolerance && c < bestCost) {
        best = fitted;
        bestCost = c;
      }
    }
    if (!best) return res;
    res = best;
    cost = bestCost;
  }
}

/**
 * Fit points that run in order along the track, from a fixed start pose or,
 * with `start` null, a free one. Needs two points when the start is free, one
 * otherwise.
 */
export function fitWindow(points: readonly Point[], start: Pose | null, opts: FitOptions): FitResult | null {
  if (points.length < (start ? 1 : 2)) return null;
  const all = segment(points, opts);
  const outliers = all.map(g => g.drop).filter(d => d >= 0);
  // The rest of the fit sees only the inliers; the groups are renumbered to them.
  const kept = points.map((_, i) => i).filter(i => !outliers.includes(i));
  const inliers = kept.map(i => points[i]);
  const index = new Map(kept.map((i, j) => [i, j]));
  // A run never drops its first point, so every run bound is kept.
  const at = (i: number) => index.get(i) as number;
  const groups = all.map(g => ({ ...g, from: at(g.from), to: g.to === points.length ? inliers.length : at(g.to) }));
  const first = chain(inliers, groups, start, opts);
  // A fixed start may point a little off the points, so every part may bend at first.
  const free = start ? first.parts.map(() => true) : freeOf(first);
  const res = result(refit(first, inliers, { start, free, bounds: opts.bounds }, opts), inliers, start, opts);
  // Out of tolerance, one split, and a line still out of it is returned as it is:
  // two segmentations and at most two refits, whatever the points.
  const within = res.worst <= opts.tolerance ? res : split(res, inliers, start, opts);
  const done = within.worst <= opts.tolerance ? simplify(within, inliers, start, opts) : within;
  if (!outliers.length) return done;
  // A point left out that the line reaches after all is no outlier.
  const d = evaluate(done.fit, points).d;
  return result(done.fit, points, start, opts, outliers.filter(i => Math.abs(d[i]) > opts.tolerance));
}

/** Fit a whole line at once, start free. */
export function fitTrack(points: readonly Point[], opts: FitOptions): FitResult | null {
  return fitWindow(points, null, opts);
}

/**
 * The fit as stored nodes: one per join, heading along the line. An arc that
 * turns more than 90° is split at its midpoint, since a node pair draws an arc
 * as one cubic, which follows it closely only up to 90°.
 */
export function fitNodes(fit: Fit): TrackNode[] {
  const node = (p: Pose): TrackNode => ({ x: p.x, y: p.y, heading: wrapAngle(p.heading) });
  const nodes = [node(fit.start)];
  let pose = fit.start;
  for (const part of fit.parts) {
    if (Math.abs(part.length * part.curvature) > Math.PI / 2) {
      nodes.push(node(advance(pose, part.length / 2, part.curvature)));
    }
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
