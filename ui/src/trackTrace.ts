import type { Point } from '@rails49/r49';

/**
 * One track traced click by click (#311): the clicks in track order and the
 * line `extend` builds over them, click by click. A click goes on the end of
 * the line, adds nothing, or is refused; a move or delete builds the line
 * again from its clicks, the way it was built, so the line is a function of
 * its clicks alone. Pure.
 */
import { TRACK_FIT, ahead, extend, type Ahead, type Fit, type FitOptions, type Line, type Step } from './trackFit.js';

export type TraceOptions = FitOptions;

/** `TRACK_FIT`'s tolerance and minimum radius in image pixels, for a layout whose DPT (a gauge in pixels) is `dpt`. */
export function traceOptions(dpt: number): TraceOptions {
  return { tolerance: TRACK_FIT.tolerance * dpt, minRadius: TRACK_FIT.minRadius * dpt };
}

/** What a trace draws: its clicks, which of them start a part, the line, and where it goes on from. */
export interface TraceView {
  readonly clicks: readonly Point[];
  /** Index of the first click of each part after the first: the clicks drawn marked. */
  readonly partStarts: readonly number[];
  /** Null before the second click. */
  readonly fit: Fit | null;
  /** The end of the line and the current part's curvature, where the projection and the tangent start; null before the second click. */
  readonly ahead: Ahead | null;
}

export class Trace {
  /** Every click on the line, in track order. */
  clicks: Point[] = [];
  /** The line of the clicks; null before the second. */
  line: Line | null = null;

  /** A trace of `clicks`, added one by one; a click that adds nothing or is refused is left out. */
  static replay(clicks: readonly Point[], opts: TraceOptions): Trace {
    const t = new Trace();
    for (const p of clicks) t.add(p, opts);
    return t;
  }

  /**
   * A trace of `clicks` when the replay keeps every one; null when a click
   * then adds nothing or is refused.
   */
  static rebuilt(clicks: readonly Point[], opts: TraceOptions): Trace | null {
    const t = Trace.replay(clicks, opts);
    return t.clicks.length === clicks.length ? t : null;
  }

  /** A copy that later changes to this trace leave as it is. */
  clone(): Trace {
    return Object.assign(new Trace(), structuredClone({ ...this }));
  }

  fit(): Fit | null {
    return this.line?.fit ?? null;
  }

  view(): TraceView {
    return {
      clicks: [...this.clicks],
      partStarts: this.line?.firstClick.slice(1) ?? [],
      fit: this.fit(),
      ahead: this.line ? ahead(this.line) : null,
    };
  }

  /** Puts a click on the end of the line, or says why it adds nothing. */
  add(p: Point, opts: TraceOptions): Step['kind'] {
    if (this.clicks.length === 0) {
      this.clicks.push(p);
      return 'added';
    }
    const step = extend(this.line, this.clicks, p, opts);
    if (step.kind === 'added') {
      this.clicks.push(p);
      this.line = step.line;
    }
    return step.kind;
  }

  /**
   * Moves click `i` and builds the line again from the clicks (`rebuilt`):
   * 'added', or 'refused' with nothing changed when a click then does not go
   * on the line.
   */
  move(i: number, p: Point, opts: TraceOptions): Step['kind'] {
    return this._rebuild(this.clicks.map((q, k) => (k === i ? p : q)), opts);
  }

  /** Deletes click `i` the same way. */
  remove(i: number, opts: TraceOptions): Step['kind'] {
    return this._rebuild(this.clicks.filter((_, k) => k !== i), opts);
  }

  private _rebuild(clicks: readonly Point[], opts: TraceOptions): Step['kind'] {
    const t = Trace.rebuilt(clicks, opts);
    if (!t) return 'refused';
    this.clicks = t.clicks;
    this.line = t.line;
    return 'added';
  }
}
