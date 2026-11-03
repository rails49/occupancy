import type { Point } from '@rails49/r49';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX, samePoint } from './geometry.js';
import { pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import { hitClick, hitTrack, wrapAngle } from './track.js';
import type { ClickHit, Track, TrackHit, TrackNode } from './track.js';
import { TRACK_FIT, fitNodes } from './trackFit.js';
import type { Step } from './trackFit.js';
import { Trace, traceOptions } from './trackTrace.js';
import type { TraceOptions } from './trackTrace.js';

/** The line under the track tool's pointer, or null. */
export function trackHitAt(tracks: readonly Track[], at: Point, scale: number): TrackHit | null {
  return hitTrack(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/** The click under the track tool's pointer, or null. */
export function clickHitAt(tracks: readonly Track[], at: Point, scale: number): ClickHit | null {
  return hitClick(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/**
 * A line of `clicks` and the nodes of their line, in stored order: an edit
 * with no chain live. Null, and the edit is refused, when a click of the
 * rebuilt line would add nothing or need an arc tighter than the minimum
 * (`Trace.rebuilt`).
 */
export function refitLine(ctx: ChainContext, clicks: readonly Point[]): Track | null {
  const t = Trace.rebuilt(clicks, traceOptions(ctx.scene().dpt!));
  if (!t) {
    ctx.refuse();
    return null;
  }
  return { nodes: fitNodes(t.fit()!), clicks: t.clicks };
}

/**
 * The track tool's click with no chain live (#298, #302, #311). A click on a
 * line's first or last click continues the line as a chain from there; on a
 * click between them, or within the start distance of any line, it does
 * nothing. Anywhere else a chain starts, even on a sensor.
 */
export const trackTool: ChainTool = (ctx, at, scale) => {
  const lines = tracks(ctx);
  const click = clickHitAt(lines, at, scale);
  if (click) {
    const last = lines[click.line].clicks!.length - 1;
    if (click.index !== 0 && click.index !== last) return { kind: 'edit', run: async () => NONE };
    return { kind: 'chain', chain: TrackChain.continuing(ctx, click.line, click.index === 0) };
  }
  if (hitTrack(lines, at, TRACK_FIT.startDistance * ctx.scene().dpt!)) return { kind: 'edit', run: async () => NONE };
  return { kind: 'chain', chain: TrackChain.starting(ctx, pixel(at)) };
};

/**
 * A chain of track: one track, traced click by click. The line in
 * `layout.tracks` holds the clicks and the nodes of the line as drawn;
 * the chain holds the trace, which is what it draws, and replays it from the
 * stored clicks whenever they change under it, as an undo does. The trace before
 * each entry it writes, a click or a move or delete of a click (#303), is
 * kept, so an undo takes it back rather than replaying every click. A chain
 * continued from a line's first click traces its clicks backwards and writes
 * them back in stored order.
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
  private _view: Track;

  /** A new line from `start`. */
  static starting(ctx: ChainContext, start: Point): TrackChain {
    return new TrackChain(ctx, [start], null, false);
  }

  /** Line `index` going on from its last click, or with `fromFirst` its first. */
  static continuing(ctx: ChainContext, index: number, fromFirst: boolean): TrackChain {
    return new TrackChain(ctx, tracks(ctx)[index].clicks!, index, fromFirst);
  }

  private constructor(ctx: ChainContext, clicks: readonly Point[], index: number | null, reversed: boolean) {
    this._ctx = ctx;
    // The track tool is gated on DPT, so a chain only starts with one.
    this._opts = traceOptions(ctx.scene().dpt!);
    this._index = index;
    this._reversed = reversed;
    this._base = index === null ? 0 : clicks.length;
    this._trace = Trace.replay(this._order(clicks), this._opts);
    this._view = drawn(this._trace);
  }

  /** The line's index, or null before the second click writes it. */
  get line(): number | null {
    return this._index;
  }

  view(): ChainView {
    const clicks = this._view.clicks!;
    return { tool: 'track', end: clicks[clicks.length - 1], line: this._index, trace: this._view };
  }

  /** Whether every entry this chain wrote, click or edit, has been undone. */
  atStart(): boolean {
    return this._before.length === 0;
  }

  /**
   * Puts a click on the end of the trace and writes the line's clicks with
   * the nodes of their line. The second click of a new line writes a new
   * track. A click that adds nothing, or is refused, writes nothing.
   */
  async extend(at: Point, scale: number): Promise<ClickResult> {
    const p = pixel(at);
    const last = this._trace.clicks[this._trace.clicks.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) <= DEFAULT_GRAB_RADIUS_SCREEN_PX * scale) return NONE;
    await this._write(this._index === null ? 'place track' : 'extend track', t => t.add(p, this._opts));
    return NONE;
  }

  /**
   * Draws click `index`, in stored order, at `to` while a drag holds it, and
   * the trace as it is; null puts the click back.
   */
  hold(index: number, to: Point | null) {
    const clicks = [...this._trace.clicks];
    if (to) clicks[this._traced(index)] = to;
    this._view = { ...this._view, clicks };
  }

  /**
   * Moves click `index`, in stored order, to `to`, and builds the line again
   * from its clicks (`Trace.move`). A move the line refuses writes nothing.
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
   * line's clicks with the nodes of the line as drawn, as one entry. The
   * second click of a new line writes a new track. A change the trace
   * does not take writes nothing; one it refuses says so.
   */
  private async _write(label: string, change: (trace: Trace) => Step['kind']) {
    const before = this._trace.clone();
    const step = change(this._trace);
    if (step === 'refused') this._ctx.refuse();
    if (step !== 'added') return;
    this._before.push(before);
    this._view = drawn(this._trace);
    const lines = [...tracks(this._ctx)];
    const index = this._index ?? lines.length;
    lines[index] = this._stored();
    this._index = index;
    await this._ctx.record(label, { kind: 'layout' }, () => this._ctx.writeLayout({ tracks: lines }));
  }

  /** The line as drawn, clicks and nodes in stored order: a reversed chain turns the nodes round. */
  private _stored(): Track {
    const nodes = fitNodes(this._trace.fit()!);
    return { nodes: this._reversed ? turned(nodes) : nodes, clicks: this._order(this._trace.clicks) };
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
    const line = this._index === null ? undefined : tracks(this._ctx)[this._index];
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
    this._view = drawn(this._trace);
    return true;
  }

  /** Stored clicks in trace order, or trace clicks in stored order: the same flip both ways. */
  private _order(clicks: readonly Point[]): Point[] {
    return this._reversed ? [...clicks].reverse() : [...clicks];
  }
}

/** The line a trace draws: its clicks, and the nodes of their line once there are two. */
function drawn(trace: Trace): Track {
  const fit = trace.fit();
  return { nodes: fit ? fitNodes(fit) : [], clicks: [...trace.clicks] };
}

/** `nodes` run the other way: last first, each heading turned round. */
function turned(nodes: readonly TrackNode[]): TrackNode[] {
  return [...nodes].reverse().map(n => ({ ...n, heading: wrapAngle(n.heading + Math.PI) }));
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length === b.length && a.every((p, i) => samePoint(p, b[i]));
}

function tracks(ctx: ChainContext): readonly Track[] {
  return ctx.manifest().layout.tracks ?? [];
}
