import type { Centerline, Point } from '@rails49/r49';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import { pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import { hitClick, hitTrack } from './track.js';
import type { ClickHit, Track, TrackHit } from './track.js';
import { fitNodes, fitTrack } from './trackFit.js';
import { Trace, traceOptions } from './trackTrace.js';
import type { TraceOptions, TraceView } from './trackTrace.js';

/** The line under the track tool's pointer, or null. */
export function trackHitAt(tracks: readonly Track[], at: Point, scale: number): TrackHit | null {
  return hitTrack(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/** The click under the track tool's pointer, or null. */
export function clickHitAt(tracks: readonly Track[], at: Point, scale: number): ClickHit | null {
  return hitClick(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/** A line with `clicks` and the nodes of their whole-line fit. */
export function refitLine(ctx: ChainContext, clicks: readonly Point[]): Centerline {
  const opts = traceOptions(ctx.scene().dpt!);
  return { nodes: fitNodes(fitTrack(clicks, opts)!.fit), clicks: [...clicks] };
}

/**
 * The track tool's click with no chain live (#298, #302). A click on a line's
 * first or last click continues the line as a chain from there; on a click
 * between them it does nothing. A click on a line adds a click there and
 * refits the line; anywhere else a chain starts, even on a sensor: sensors sit
 * on the track being laid.
 */
export const trackTool: ChainTool = (ctx, at, scale) => {
  const lines = centerlines(ctx);
  const click = clickHitAt(lines, at, scale);
  if (click) {
    const last = lines[click.line].clicks!.length - 1;
    if (click.index !== 0 && click.index !== last) return { kind: 'edit', run: async () => NONE };
    return { kind: 'chain', chain: TrackChain.continuing(ctx, click.line, click.index === 0) };
  }
  const hit = trackHitAt(lines, at, scale);
  if (hit) return { kind: 'edit', run: () => addClick(ctx, hit.line, pixel(at)) };
  return { kind: 'chain', chain: TrackChain.starting(ctx, pixel(at)) };
};

/**
 * Adds a click at `at` to line `index`, in track order by where it projects
 * onto the line fitted to its clicks, and refits the line. A line without
 * clicks cannot be refit, and takes none.
 */
async function addClick(ctx: ChainContext, index: number, at: Point): Promise<ClickResult> {
  const lines = [...centerlines(ctx)];
  const clicks = lines[index].clicks ?? [];
  if (clicks.length < 2) return NONE;
  const opts = traceOptions(ctx.scene().dpt!);
  const trace = new Trace();
  trace.clicks = [...clicks];
  trace.finish(opts);
  trace.add(at, opts);
  lines[index] = { nodes: fitNodes(trace.whole!.fit), clicks: trace.clicks };
  await ctx.record('add click', { kind: 'layout' }, () => ctx.writeLayout({ centerlines: lines }));
  return NONE;
}

/**
 * A chain of track: one centerline, traced click by click. The line in
 * `layout.centerlines` holds the clicks and the nodes of the whole-line fit;
 * the chain holds the trace, which is what it draws, and replays it from the
 * stored clicks whenever they change under it, as an undo does. The trace
 * before each entry it writes, a click or a move or delete of a click (#303),
 * is kept, so an undo takes it back rather than replaying every click. A
 * chain continued from a line's first click traces its clicks backwards and
 * writes them back in stored order.
 */
export class TrackChain implements Chain {
  readonly tool = 'track';
  private readonly _ctx: ChainContext;
  private readonly _opts: TraceOptions;
  /** The line's index, or null before the second click writes it. */
  private _index: number | null;
  /** Whether the trace runs against the stored order. */
  private readonly _reversed: boolean;
  /** How many clicks the line had when the chain began: 0 for a new line. */
  private readonly _base: number;
  private _trace: Trace;
  /** The trace before each entry this chain wrote, oldest first. */
  private _before: Trace[] = [];
  private _view: TraceView;

  /** A new line from `start`. */
  static starting(ctx: ChainContext, start: Point): TrackChain {
    return new TrackChain(ctx, [start], null, false);
  }

  /** Line `index` going on from its last click, or with `fromFirst` its first. */
  static continuing(ctx: ChainContext, index: number, fromFirst: boolean): TrackChain {
    return new TrackChain(ctx, centerlines(ctx)[index].clicks!, index, fromFirst);
  }

  private constructor(ctx: ChainContext, clicks: readonly Point[], index: number | null, reversed: boolean) {
    this._ctx = ctx;
    // The track tool is gated on DPT, so a chain only starts with one.
    this._opts = traceOptions(ctx.scene().dpt!);
    this._index = index;
    this._reversed = reversed;
    this._base = index === null ? 0 : clicks.length;
    this._trace = Trace.replay(this._order(clicks), this._opts);
    this._view = this._trace.view(this._opts);
  }

  /** The line's index, or null before the second click writes it. */
  get line(): number | null {
    return this._index;
  }

  view(): ChainView {
    const clicks = this._view.clicks;
    return { tool: 'track', end: clicks[clicks.length - 1], line: this._index, trace: this._view };
  }

  /** Whether every entry this chain wrote, click or edit, has been undone. */
  atStart(): boolean {
    return this._before.length === 0;
  }

  /**
   * Adds a click to the trace and writes the line's clicks with the nodes of
   * their whole-line fit. The second click of a new line writes a new
   * centerline.
   */
  async extend(at: Point, scale: number): Promise<ClickResult> {
    const p = pixel(at);
    const last = this._trace.clicks[this._trace.clicks.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) <= DEFAULT_GRAB_RADIUS_SCREEN_PX * scale) return NONE;
    await this._write(this._index === null ? 'place centerline' : 'extend centerline', t => t.add(p, this._opts));
    return NONE;
  }

  /**
   * Draws click `index`, in stored order, at `to` while a drag holds it, and
   * the trace as it is; null puts the click back.
   */
  hold(index: number, to: Point | null) {
    const view = this._trace.view(this._opts);
    const clicks = [...view.clicks];
    if (to) clicks[this._traced(index)] = to;
    this._view = { ...view, clicks };
  }

  /**
   * Moves click `index`, in stored order, to `to`. A committed click
   * uncommits the trace back to the part before it (`Trace.move`).
   */
  async move(index: number, to: Point) {
    await this._write('move click', t => t.move(this._traced(index), to, this._opts));
  }

  /** Deletes click `index`, in stored order, the same way. */
  async remove(index: number) {
    await this._write('delete click', t => t.remove(this._traced(index), this._opts));
  }

  /**
   * Changes the trace, keeping it as it was for an undo, and writes the
   * line's clicks with the nodes of their whole-line fit as one entry. The
   * second click of a new line writes a new centerline.
   */
  private async _write(label: string, change: (trace: Trace) => void) {
    this._before.push(copy(this._trace));
    change(this._trace);
    this._view = this._trace.view(this._opts);
    const lines = [...centerlines(this._ctx)];
    const index = this._index ?? lines.length;
    lines[index] = refitLine(this._ctx, this._order(this._trace.clicks));
    this._index = index;
    await this._ctx.record(label, { kind: 'layout' }, () => this._ctx.writeLayout({ centerlines: lines }));
  }

  /** A stored click index as a trace index. */
  private _traced(index: number): number {
    return this._reversed ? this._trace.clicks.length - 1 - index : index;
  }

  /**
   * Replays the trace when the stored clicks differ from it. A new line an
   * undo removed takes the chain back to its first click; a continued line
   * that is gone ends the chain. Track outlives an image change.
   */
  settle(): boolean {
    const line = this._index === null ? undefined : centerlines(this._ctx)[this._index];
    if (!line) {
      if (this._base > 0) return false;
      this._index = null;
    }
    const clicks = line ? this._order(line.clicks ?? []) : this._trace.clicks.slice(0, 1);
    if (samePoints(clicks, this._trace.clicks)) return true;
    const before = this._before.pop();
    if (before && samePoints(clicks, before.clicks)) this._trace = before;
    else {
      this._before = [];
      this._trace = Trace.replay(clicks, this._opts);
    }
    this._view = this._trace.view(this._opts);
    return true;
  }

  /** Stored clicks in trace order, or trace clicks in stored order: the same flip both ways. */
  private _order(clicks: readonly Point[]): Point[] {
    return this._reversed ? [...clicks].reverse() : [...clicks];
  }
}

/** A trace that later clicks on `trace` leave as it is. */
function copy(trace: Trace): Trace {
  return Object.assign(new Trace(), structuredClone({ ...trace }));
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
}

function centerlines(ctx: ChainContext): readonly Centerline[] {
  return ctx.manifest().layout.centerlines ?? [];
}
