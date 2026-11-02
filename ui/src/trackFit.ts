import type { Point } from '@rails49/r49';
import { wrapAngle } from './track.js';
import type { TrackNode } from './track.js';

/**
 * Fit straights and circular arcs, tangent where they meet, to clicks along
 * the middle of a track (#298, #307). Pure; `trackTrace.ts` drives it.
 *
 * A fit is a start pose and a length and a curvature per part (curvature 0
 * is a straight); tangency holds by construction. The line is a function of
 * its clicks in order: `extend` takes the clicks with one more on the end
 * and solves the window, the last two parts, from where they are, by
 * Levenberg-Marquardt within the radius bound. A click in the window still
 * past the tolerance splits its part at that click; two parts of the window
 * that can be one within the tolerance are one. Nothing before the window
 * moves. `fitTrack` folds `extend` over every click.
 */

/** The fit's constants, in gauges. `traceOptions` converts them through DPT. */
export const TRACK_FIT = {
  /** Largest distance a click may lie from the line. */
  tolerance: 0.25,
  /** Tightest arc track comes in. */
  minRadius: 10,
} as const;

export interface FitOptions {
  /** Largest distance a click may lie from the line, px. */
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

/** A fitted line and which clicks each part owns. */
export interface Line {
  readonly fit: Fit;
  /** Index of the first click of each part; a part's clicks run to the next part's first. */
  readonly firstClick: readonly number[];
}

/** A part shorter than this cannot be told from none; a solver floor, not a fact about track. */
const MIN_LENGTH = 1;

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

/** Signed distance of each point from the line, px. */
export function distances(fit: Fit, points: readonly Point[]): number[] {
  return evaluate(fit, points).d;
}

/** Index of the part nearest each point. */
export function nearestParts(fit: Fit, points: readonly Point[]): number[] {
  return evaluate(fit, points).part;
}

/**
 * Residuals: each distance, then how far the line's ends miss the first point
 * (a free start only) and the last.
 */
function residuals(fit: Fit, points: readonly Point[], start: Pose | null): number[] {
  const e = evaluate(fit, points);
  const out = [...e.d];
  if (!start) out.push(e.s[0]);
  out.push(e.s[e.s.length - 1] - e.total);
  return out;
}

/** What the solve may change: the start pose when free (`start` null), each length and each curvature. */
interface Model {
  readonly start: Pose | null;
  readonly parts: number;
  readonly minRadius: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Lengths and curvatures are mapped so the bounds hold for every parameter value. */
function pack(fit: Fit, m: Model): number[] {
  const v = m.start ? [] : [fit.start.x, fit.start.y, fit.start.heading];
  for (const p of fit.parts) {
    v.push(Math.sqrt(Math.max(0, p.length - MIN_LENGTH)));
    v.push(Math.atanh(clamp(p.curvature * m.minRadius, -0.999, 0.999)));
  }
  return v;
}

function unpack(v: readonly number[], m: Model): Fit {
  let j = m.start ? 0 : 3;
  const start = m.start ?? { x: v[0], y: v[1], heading: v[2] };
  const parts: Part[] = [];
  for (let i = 0; i < m.parts; i++) {
    const length = MIN_LENGTH + v[j++] ** 2;
    const curvature = Math.tanh(v[j++]) / m.minRadius;
    parts.push({ length, curvature });
  }
  return { start, parts };
}

function steps(m: Model): number[] {
  const h = m.start ? [] : [1e-3, 1e-3, 1e-6];
  for (let i = 0; i < m.parts; i++) h.push(1e-3, 1e-4);
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

const sumSq = (r: readonly number[]) => r.reduce((s, x) => s + x * x, 0);

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
function residualJacobian(v: readonly number[], m: Model, points: readonly Point[]): number[][] {
  const fit = unpack(v, m);
  const parts = fit.parts;
  const n = parts.length;
  const ps = poses(fit);
  const e = evaluate(fit, points);
  const off = m.start ? 0 : 3;
  // Each part's packed columns, and how its length and curvature move with them.
  const lengthAt: number[] = [];
  const curveAt: number[] = [];
  const dLength: number[] = [];
  const dCurve: number[] = [];
  let j = off;
  for (let i = 0; i < n; i++) {
    lengthAt.push(j);
    dLength.push(2 * v[j++]);
    const t = Math.tanh(v[j]);
    curveAt.push(j++);
    dCurve.push((1 - t * t) / m.minRadius);
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
    /** The residual's change for a move (mx, my) of the nearest point. */
    const by = (mx: number, my: number) => -(gx * mx + gy * my);
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
      cols[lengthAt[i]][k] = dl * dLength[i];
      cols[curveAt[i]][k] = dk * dCurve[i];
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
      cols[lengthAt[on]][k] = dl * dLength[on];
      cols[curveAt[on]][k] = dk * dCurve[on];
    }
  }
  // The end residuals depend on the first and last points alone.
  const few = points.length === 1 ? points : [points[0], points[points.length - 1]];
  const endsOf = (w: readonly number[]) => residuals(unpack(w, m), few, m.start).slice(few.length);
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

/** Levenberg-Marquardt from `start`: the least squares of `points` over the model's parameters. */
function refit(start: Fit, points: readonly Point[], m: Model): Fit {
  const f = (v: readonly number[]) => residuals(unpack(v, m), points, m.start);
  let v = pack(start, m);
  let r = f(v);
  let cost = sumSq(r);
  let lambda = 1e-3;
  for (let iter = 0; iter < 100; iter++) {
    const jac = residualJacobian(v, m, points);
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

/** Kåsa's algebraic circle fit: the signed curvature for travel from the first point to the last, or null. */
function circleCurvature(points: readonly Point[]): number | null {
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
  const cx = mx - d / 2;
  const cy = my - e / 2;
  let turn = 0;
  for (let i = 1; i < n; i++) {
    const ax = points[i - 1].x - cx;
    const ay = points[i - 1].y - cy;
    const bx = points[i].x - cx;
    const by = points[i].y - cy;
    turn += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return Math.sign(turn) / Math.sqrt(r2);
}

/** Curvature of the circle tangent at `p` through `q`. */
function tangentCurvature(p: Pose, q: Point): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const r2 = dx * dx + dy * dy;
  if (r2 < 1e-12) return 0;
  return (2 * (Math.cos(p.heading) * dy - Math.sin(p.heading) * dx)) / r2;
}

/** The window: parts `from` on, and the clicks they own. */
class Window {
  parts: Part[];
  first: number[];
  start: Pose;
  readonly from: number;
  readonly clicks: readonly Point[];
  readonly opts: FitOptions;

  constructor(line: Line, from: number, clicks: readonly Point[], opts: FitOptions) {
    this.from = from;
    this.clicks = clicks;
    this.opts = opts;
    this.parts = [...line.fit.parts];
    this.first = [...line.firstClick];
    this.start = line.fit.start;
  }

  private points(): Point[] {
    return this.clicks.slice(this.first[this.from]);
  }

  private sub(): Fit {
    return { start: poses({ start: this.start, parts: this.parts.slice(0, this.from) })[this.from], parts: this.parts.slice(this.from) };
  }

  /** Least squares of the window's parts to its clicks, from where they are. */
  solve() {
    const sub = this.sub();
    const m: Model = { start: this.from === 0 ? null : sub.start, parts: sub.parts.length, minRadius: this.opts.minRadius };
    const fitted = refit(sub, this.points(), m);
    this.parts.splice(this.from, fitted.parts.length, ...fitted.parts);
    if (this.from === 0) this.start = fitted.start;
  }

  evaluate(): Evaluation {
    return evaluate(this.sub(), this.points());
  }

  /** The window's click farthest from the line, as a click index, with its distance. */
  private worst(e: Evaluation): { click: number; distance: number } {
    let j = 0;
    for (let i = 1; i < e.d.length; i++) if (Math.abs(e.d[i]) > Math.abs(e.d[j])) j = i;
    return { click: this.first[this.from] + j, distance: Math.abs(e.d[j]) };
  }

  /**
   * Curvatures the second half of part `q`, from click `j` on, may start
   * from: a circle through its clicks, the circle tangent at the cut through
   * its last click, and its parent's. Each is kept inside 0.9 of the floor:
   * the bound is a tanh, and a guess at it has no gradient to move with.
   */
  private guesses(q: number, j: number, u: number): number[] {
    const part = this.parts[q];
    const to = this.first[q + 1] ?? this.clicks.length;
    const cut = advance(poses({ start: this.start, parts: this.parts })[q], u, part.curvature);
    const kMax = 0.9 / this.opts.minRadius;
    const all = [circleCurvature(this.clicks.slice(j, to)), tangentCurvature(cut, this.clicks[to - 1]), part.curvature];
    const ks = all.filter((k): k is number => k !== null).map((k) => clamp(k, -kMax, kMax));
    return ks.filter((k, i) => ks.indexOf(k) === i);
  }

  /** Where part `q` is cut for click `j` to start its second half, or null if it cannot be. */
  private cut(q: number, j: number, e: Evaluation): number | null {
    const part = this.parts[q];
    if (j <= this.first[q] || part.length < 2 * MIN_LENGTH) return null;
    const k = j - this.first[this.from];
    return clamp(e.part[k] === q - this.from ? e.u[k] : part.length / 2, MIN_LENGTH, part.length - MIN_LENGTH);
  }

  /** Split part `q` at `u` along it; click `j` starts the second half, bending at `curvature`. */
  private split(q: number, j: number, u: number, curvature: number) {
    const part = this.parts[q];
    this.parts.splice(q, 1, { length: u, curvature: part.curvature }, { length: part.length - u, curvature });
    this.first.splice(q + 1, 0, j);
  }

  /**
   * Split where a click is still past the tolerance, until every click is
   * within it. A split is solved from each guess and the best kept; one
   * that leaves its click out is undone and ends the splitting: the click
   * stays red.
   */
  splitWhileOut() {
    for (;;) {
      const e = this.evaluate();
      const { click, distance } = this.worst(e);
      if (distance <= this.opts.tolerance) return;
      const q = this.from + e.part[click - this.first[this.from]];
      // At a part's first click the part before it is the one that misses, and it splits at its last click.
      let at = { q, j: click, u: this.cut(q, click, e) };
      if (at.u === null && q > this.from) at = { q: q - 1, j: click - 1, u: this.cut(q - 1, click - 1, e) };
      if (at.u === null) return;
      const before = { parts: this.parts, first: this.first, start: this.start };
      let best: { parts: Part[]; first: number[]; start: Pose; d: number } | null = null;
      for (const k of this.guesses(at.q, at.j, at.u)) {
        this.parts = [...before.parts];
        this.first = [...before.first];
        this.start = before.start;
        this.split(at.q, at.j, at.u, k);
        this.solve();
        const d = Math.abs(this.evaluate().d[click - this.first[this.from]]);
        if (!best || d < best.d) best = { parts: this.parts, first: this.first, start: this.start, d };
      }
      if (!best || best.d > this.opts.tolerance) {
        this.parts = before.parts;
        this.first = before.first;
        this.start = before.start;
        return;
      }
      this.parts = best.parts;
      this.first = best.first;
      this.start = best.start;
    }
  }

  /** Parts `i` and `i + 1` made one, of their mean curvature. */
  private merged(i: number): Window {
    const w = new Window({ fit: { start: this.start, parts: this.parts }, firstClick: this.first }, this.from, this.clicks, this.opts);
    const a = this.parts[i];
    const b = this.parts[i + 1];
    const length = a.length + b.length;
    w.parts.splice(i, 2, { length, curvature: (a.curvature * a.length + b.curvature * b.length) / length });
    w.first.splice(i + 1, 1);
    return w;
  }

  /** Merge neighbours while the window stays within the tolerance: the fewest parts that reach the clicks. */
  mergeWhileIn() {
    for (let i = this.from; i + 1 < this.parts.length; ) {
      const w = this.merged(i);
      w.solve();
      if (w.worst(w.evaluate()).distance <= this.opts.tolerance) {
        this.parts = w.parts;
        this.first = w.first;
        this.start = w.start;
        i = this.from;
      } else i++;
    }
  }

  line(): Line {
    return { fit: { start: this.start, parts: this.parts }, firstClick: this.first };
  }
}

/**
 * The line of `clicks`, given the line of all but the last. Null with fewer
 * than two clicks; a straight through the first two; after that the last
 * part extends to the new click and the window, the last two parts, is
 * solved, split while a click is out of tolerance and merged while within
 * it.
 */
export function extend(line: Line | null, clicks: readonly Point[], opts: FitOptions): Line | null {
  const n = clicks.length;
  if (n < 2) return null;
  if (!line) {
    const a = clicks[0];
    const b = clicks[n - 1];
    const length = Math.max(MIN_LENGTH, Math.hypot(b.x - a.x, b.y - a.y));
    return { fit: { start: { x: a.x, y: a.y, heading: Math.atan2(b.y - a.y, b.x - a.x) }, parts: [{ length, curvature: 0 }] }, firstClick: [0] };
  }
  const m = line.fit.parts.length;
  const w = new Window(line, Math.max(0, m - 2), clicks, opts);
  const last = w.parts[m - 1];
  const p = clicks[n - 2];
  const q = clicks[n - 1];
  w.parts[m - 1] = { ...last, length: last.length + Math.hypot(q.x - p.x, q.y - p.y) };
  w.solve();
  w.splitWhileOut();
  w.mergeWhileIn();
  return w.line();
}

/** The line of `clicks` in order: `extend` folded over them. */
export function fitTrack(clicks: readonly Point[], opts: FitOptions): Line | null {
  let line: Line | null = null;
  for (let n = 2; n <= clicks.length; n++) line = extend(line, clicks.slice(0, n), opts);
  return line;
}

/**
 * The fit as stored nodes: one per join, heading along the line. An arc that
 * turns more than 90° is split at its midpoint.
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
