import type { Centerline, Point } from '@rails49/r49';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import { pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import { hitTrack } from './track.js';
import type { Track, TrackHit } from './track.js';
import { fitNodes } from './trackFit.js';
import { Trace, traceOptions } from './trackTrace.js';
import type { TraceOptions, TraceView } from './trackTrace.js';

/** The line under the track tool's pointer, or null. */
export function trackHitAt(tracks: readonly Track[], at: Point, scale: number): TrackHit | null {
  return hitTrack(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/**
 * The track tool's click with no chain live (#298). A click on a line does
 * nothing; anywhere else a chain starts, even on a sensor: sensors sit on the
 * track being laid.
 */
export const trackTool: ChainTool = (ctx, at, scale) => {
  if (trackHitAt(centerlines(ctx), at, scale)) return { kind: 'edit', run: async () => NONE };
  return { kind: 'chain', chain: new TrackChain(ctx, pixel(at)) };
};

/**
 * A chain of track: one centerline, traced click by click. The line in
 * `layout.centerlines` holds the clicks and the nodes of the whole-line fit;
 * the chain holds the trace, which is what it draws, and replays it from the
 * stored clicks whenever they change under it, as an undo does. The trace
 * before each click is kept, so an undo takes it back rather than replaying
 * every click.
 */
export class TrackChain implements Chain {
  readonly tool = 'track';
  private readonly _ctx: ChainContext;
  private readonly _opts: TraceOptions;
  /** The line's index, or null before the second click writes it. */
  private _index: number | null = null;
  private _trace: Trace;
  /** The trace before each click this chain added, oldest first. */
  private _before: Trace[] = [];
  private _view: TraceView;

  constructor(ctx: ChainContext, start: Point) {
    this._ctx = ctx;
    // The track tool is gated on DPT, so a chain only starts with one.
    this._opts = traceOptions(ctx.scene().dpt!);
    this._trace = Trace.replay([start], this._opts);
    this._view = this._trace.view(this._opts);
  }

  view(): ChainView {
    const clicks = this._view.clicks;
    return { tool: 'track', end: clicks[clicks.length - 1], line: this._index, trace: this._view };
  }

  atStart(): boolean {
    return this._index === null;
  }

  /**
   * Adds a click to the trace and writes the line's clicks with the nodes of
   * their whole-line fit. The second click writes a new centerline.
   */
  async extend(at: Point, scale: number): Promise<ClickResult> {
    const p = pixel(at);
    const last = this._trace.clicks[this._trace.clicks.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) <= DEFAULT_GRAB_RADIUS_SCREEN_PX * scale) return NONE;
    this._before.push(copy(this._trace));
    this._trace.add(p, this._opts);
    this._view = this._trace.view(this._opts);
    const clicks = [...this._trace.clicks];
    const whole = this._trace.lineFit(this._opts)!;
    const lines = [...centerlines(this._ctx)];
    const index = this._index ?? lines.length;
    lines[index] = { nodes: fitNodes(whole.fit), clicks };
    const label = this._index === null ? 'place centerline' : 'extend centerline';
    this._index = index;
    await this._ctx.record(label, { kind: 'layout' }, () => this._ctx.writeLayout({ centerlines: lines }));
    return NONE;
  }

  /**
   * Replays the trace when the stored clicks differ from it. A line an undo
   * removed takes the chain back to its first click. Track outlives an image
   * change.
   */
  settle(): boolean {
    const line = this._index === null ? undefined : centerlines(this._ctx)[this._index];
    if (!line) this._index = null;
    const clicks = line?.clicks ?? this._trace.clicks.slice(0, 1);
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
