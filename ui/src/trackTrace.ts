import type { Point } from '@rails49/r49';

/**
 * One track traced click by click (#298). While tracing, the prefix is
 * committed and never moves; only the tail is fitted, from the last
 * committed join, and joins are committed in order, each once it is
 * established (its margin is at least `commitMargin`) and it and every live
 * join before it have σ under `commitSigma`. Editing
 * a committed click uncommits every part from the one before it to the end,
 * and the tail is traced again from there.
 * Finishing fits the whole line from its clicks at once, and every later
 * edit does the same, so a finished line depends on its clicks alone. Pure.
 */
import {
  TRACK_FIT,
  fitTrack,
  fitWindow,
  nearestParts,
  poses,
  positionsAlong,
  type Fit,
  type FitOptions,
  type FitResult,
  type Join,
  type Part,
  type Pose,
} from './trackFit.js';

export interface TraceOptions extends FitOptions {
  /** A join whose σ is under this, px, and whose margin is at or over `commitMargin`, is committed. */
  readonly commitSigma: number;
  /** The least margin a join commits with, in the fit's penalised cost. */
  readonly commitMargin: number;
  /** A join whose σ, px, is at or past this is a guess: its parts are not drawn and never commit. */
  readonly barCap: number;
}

/** `TRACK_FIT` in image pixels, for a layout whose DPT (a gauge in pixels) is `dpt`. */
export function traceOptions(dpt: number): TraceOptions {
  const g = TRACK_FIT;
  return {
    tolerance: g.tolerance * dpt,
    noise: g.noise * dpt,
    reach: g.reach * dpt,
    commitSigma: g.commitSigma * dpt,
    commitMargin: g.commitMargin,
    barCap: g.barCap * dpt,
    bounds: { minLength: g.minLength * dpt, minRadius: g.minRadius * dpt, maxSweep: g.maxSweep },
  };
}

/** What a trace draws: its clicks, the committed line, the live tail and the clicks to flag. */
export interface TraceView {
  readonly clicks: readonly Point[];
  /** Null while nothing is committed. */
  readonly committed: Fit | null;
  /** The tail; its first join is the last committed one once something is committed. */
  readonly live: FitResult | null;
  /** Indices of the clicks the fit leaves out, or that lie past the tolerance from the tail. */
  readonly flagged: readonly number[];
}

/** A bar across the track at a join, end to end. */
export interface Bar {
  readonly from: Point;
  readonly to: Point;
}

/**
 * What the live tail `live` draws (#298): each part both of whose joins have σ
 * under `cap`, as a fit of its own, and a bar across each join where two
 * parts meet and one of them is drawn, perpendicular to the track and
 * half-length σ.
 */
export function tailMarks(live: FitResult | null, cap: number): { parts: Fit[]; bars: Bar[] } {
  if (!live) return { parts: [], bars: [] };
  const { joins } = live;
  const m = live.fit.parts.length;
  const starts = poses(live.fit);
  const drawn = live.fit.parts.map((_, i) => joins[i].sigma < cap && joins[i + 1].sigma < cap);
  const parts = live.fit.parts.flatMap((part, i) => (drawn[i] ? [{ start: starts[i], parts: [part] }] : []));
  const bars = joins.slice(1, m).flatMap((j, k) => {
    if (!drawn[k] && !drawn[k + 1]) return [];
    const dx = -j.sigma * Math.sin(j.heading);
    const dy = j.sigma * Math.cos(j.heading);
    return [{ from: { x: j.x - dx, y: j.y - dy }, to: { x: j.x + dx, y: j.y + dy } }];
  });
  return { parts, bars };
}

export class Trace {
  /** Every click, in track order. */
  clicks: Point[] = [];
  /** `clicks[firstLive..]` are fitted; the ones before belong to committed parts. */
  firstLive = 0;
  /** Start of the committed prefix; null while nothing is committed. */
  origin: Pose | null = null;
  committed: Part[] = [];
  /** The pose at the start of each committed part, then the live start; each with the σ it was committed at. */
  committedJoins: Join[] = [];
  /** The tail, from the live start; null once finished. */
  live: FitResult | null = null;
  finished = false;
  /** The whole-line fit of a finished line, with a residual for every click. */
  whole: FitResult | null = null;

  /** A trace of `clicks`, added one by one. */
  static replay(clicks: readonly Point[], opts: TraceOptions): Trace {
    const t = new Trace();
    for (const p of clicks) t.add(p, opts);
    return t;
  }

  /** A finished line of `clicks`, fitted whole at once. */
  static finished(clicks: readonly Point[], opts: TraceOptions): Trace {
    const t = new Trace();
    t.clicks = [...clicks];
    t.finish(opts);
    return t;
  }

  /** A copy that later changes to this trace leave as it is. */
  clone(): Trace {
    return Object.assign(new Trace(), structuredClone({ ...this }));
  }

  committedFit(): Fit | null {
    return this.origin ? { start: this.origin, parts: this.committed } : null;
  }

  /** The click indices the current fit leaves out. */
  outliers(): number[] {
    if (this.finished) return this.whole ? [...this.whole.outliers] : [];
    return this.live ? this.live.outliers.map(i => i + this.firstLive) : [];
  }

  view(opts: TraceOptions): TraceView {
    const flagged = new Set(this.outliers());
    this.live?.residuals.forEach((d, i) => {
      if (Math.abs(d) > opts.tolerance) flagged.add(i + this.firstLive);
    });
    return {
      clicks: [...this.clicks],
      committed: this.committedFit(),
      live: this.live,
      flagged: [...flagged].sort((a, b) => a - b),
    };
  }

  /** Append while tracing; on a finished line, insert where the click projects onto the line. */
  add(p: Point, opts: TraceOptions) {
    if (this.finished) {
      const fit = this.committedFit();
      let i = this.clicks.length;
      if (fit) {
        const [at] = positionsAlong(fit, [p]);
        i = positionsAlong(fit, this.clicks).findIndex(x => x > at);
        if (i < 0) i = this.clicks.length;
      }
      this.clicks.splice(i, 0, p);
      this.refitWhole(opts);
      return;
    }
    this.clicks.push(p);
    this.refitLive(opts);
    this.commit(opts);
  }

  move(i: number, p: Point, opts: TraceOptions) {
    const part = this.partOfCommitted(i);
    this.clicks[i] = p;
    this.afterEdit(part, opts);
  }

  remove(i: number, opts: TraceOptions) {
    const part = this.partOfCommitted(i);
    this.clicks.splice(i, 1);
    if (part >= 0) this.firstLive--;
    this.afterEdit(part, opts);
  }

  /** Finish the line: fit it whole from its clicks. */
  finish(opts: TraceOptions) {
    this.finished = true;
    this.refitWhole(opts);
  }

  private afterEdit(part: number, opts: TraceOptions) {
    if (this.finished) this.refitWhole(opts);
    else if (part >= 0) this.uncommit(part, opts);
    else {
      this.refitLive(opts);
      this.commit(opts);
    }
  }

  private refitWhole(opts: TraceOptions) {
    const res = fitTrack(this.clicks, opts);
    this.whole = res;
    this.live = null;
    this.firstLive = this.clicks.length;
    if (!res) {
      this.origin = null;
      this.committed = [];
      this.committedJoins = [];
      return;
    }
    this.origin = res.fit.start;
    this.committed = [...res.fit.parts];
    this.committedJoins = [...res.joins];
  }

  private liveStart(): Pose {
    return poses(this.committedFit() as Fit)[this.committed.length];
  }

  private refitLive(opts: TraceOptions) {
    const pts = this.clicks.slice(this.firstLive);
    this.live = fitWindow(pts, this.origin ? this.liveStart() : null, opts);
  }

  /** Commit the live parts up to the last join, in order, whose σ is under the commit σ and whose margin is enough. */
  private commit(opts: TraceOptions) {
    const live = this.live;
    if (!live) return;
    const m = live.fit.parts.length;
    const firm = (j: Join) => j.sigma <= opts.commitSigma && j.margin >= opts.commitMargin;
    let j = 0;
    while (j + 1 < m && firm(live.joins[j + 1])) j++;
    if (j === 0) return;
    if (!this.origin) {
      this.origin = live.fit.start;
      this.committedJoins = [live.joins[0]];
    }
    this.committed.push(...live.fit.parts.slice(0, j));
    this.committedJoins.push(...live.joins.slice(1, j + 1));
    const k = live.partOf.findIndex(p => p >= j);
    this.firstLive += k < 0 ? live.partOf.length : k;
    this.refitLive(opts);
  }

  /** The committed part nearest click `i`, or -1 when the click is live or the line is finished. */
  private partOfCommitted(i: number): number {
    if (this.finished || i >= this.firstLive) return -1;
    const fit = this.committedFit();
    return fit ? nearestParts(fit, [this.clicks[i]])[0] : -1;
  }

  /**
   * Uncommit from the part before `part` to the end. Its start pose stays
   * fixed; the clicks from there on become the live tail and recommit by the
   * usual rule.
   */
  private uncommit(part: number, opts: TraceOptions) {
    const fit = this.committedFit() as Fit;
    const a = Math.max(0, part - 1);
    const owner = nearestParts(fit, this.clicks.slice(0, this.firstLive));
    const first = owner.findIndex(o => o >= a);
    this.firstLive = first < 0 ? this.firstLive : first;
    this.committed = this.committed.slice(0, a);
    this.committedJoins = this.committedJoins.slice(0, a + 1);
    if (a === 0) {
      this.origin = null;
      this.committedJoins = [];
    }
    this.refitLive(opts);
    this.commit(opts);
  }
}
