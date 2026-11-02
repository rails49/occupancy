import type { Point } from '@rails49/r49';

/**
 * One track traced click by click (#298, #307): the clicks in track order
 * and the line `fitTrack` folds over them. A click extends the line
 * (`extend`); a move or delete builds it again from the clicks, the way it
 * was built, so the line is a function of its clicks alone. Pure.
 */
import { TRACK_FIT, distances, extend, fitTrack, type Fit, type FitOptions, type Line } from './trackFit.js';

export type TraceOptions = FitOptions;

/** `TRACK_FIT` in image pixels, for a layout whose DPT (a gauge in pixels) is `dpt`. */
export function traceOptions(dpt: number): TraceOptions {
  return { tolerance: TRACK_FIT.tolerance * dpt, minRadius: TRACK_FIT.minRadius * dpt };
}

/** What a trace draws: its clicks, the line and the clicks past the tolerance. */
export interface TraceView {
  readonly clicks: readonly Point[];
  /** Null before the second click. */
  readonly fit: Fit | null;
  /** Indices of the clicks farther than the tolerance from the line: drawn red. */
  readonly red: readonly number[];
}

export class Trace {
  /** Every click, in track order. */
  clicks: Point[] = [];
  /** The line of the clicks; null before the second. */
  line: Line | null = null;

  /** A trace of `clicks`, added one by one. */
  static replay(clicks: readonly Point[], opts: TraceOptions): Trace {
    const t = new Trace();
    for (const p of clicks) t.add(p, opts);
    return t;
  }

  /** A copy that later changes to this trace leave as it is. */
  clone(): Trace {
    return Object.assign(new Trace(), structuredClone({ ...this }));
  }

  fit(): Fit | null {
    return this.line?.fit ?? null;
  }

  view(opts: TraceOptions): TraceView {
    const fit = this.fit();
    const red = fit ? distances(fit, this.clicks).flatMap((d, i) => (Math.abs(d) > opts.tolerance ? [i] : [])) : [];
    return { clicks: [...this.clicks], fit, red };
  }

  /** Appends a click and solves the window at the end of the line. */
  add(p: Point, opts: TraceOptions) {
    this.clicks.push(p);
    this.line = extend(this.line, this.clicks, opts);
  }

  move(i: number, p: Point, opts: TraceOptions) {
    this.clicks[i] = p;
    this.rebuild(opts);
  }

  remove(i: number, opts: TraceOptions) {
    this.clicks.splice(i, 1);
    this.rebuild(opts);
  }

  private rebuild(opts: TraceOptions) {
    this.line = fitTrack(this.clicks, opts);
  }
}
