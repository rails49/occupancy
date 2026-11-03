import type { Click, Point } from '@rails49/r49';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import { pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import { hitClick, hitTrack, nearestGap } from './track.js';
import type { ClickHit, Track, TrackHit } from './track.js';
import { TRACK_FIT, buildLine, fitNodes, fitOptions } from './trackFit.js';
import type { FitOptions, Refusal } from './trackFit.js';

/** The line under the track tool's pointer, or null. */
export function trackHitAt(tracks: readonly Track[], at: Point, scale: number): TrackHit | null {
  return hitTrack(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/** The click under the track tool's pointer, or null. */
export function clickHitAt(tracks: readonly Track[], at: Point, scale: number): ClickHit | null {
  return hitClick(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale);
}

/**
 * `clicks` with the nodes of their line (`buildLine`), or why the rule
 * refuses them. One click has no nodes.
 */
export function lineOf(clicks: readonly Click[], opts: FitOptions): Track | Refusal {
  if (clicks.length < 2) return { nodes: [], clicks: [...clicks] };
  const built = buildLine(clicks, opts);
  return built.kind === 'line' ? { nodes: fitNodes(built.fit), clicks: [...clicks] } : built.reason;
}

/**
 * A line of `clicks` and the nodes of their line: an edit with no chain
 * live. Null, and the edit is refused with the rule's reason, when the rule
 * refuses the clicks.
 */
export function refitLine(ctx: ChainContext, clicks: readonly Click[]): Track | null {
  const line = lineOf(clicks, fitOptions(ctx.scene().dpt!));
  if (typeof line === 'string') {
    ctx.refuse(line);
    return null;
  }
  return line;
}

/** `clicks` with click `index` moved to `to`, its mark kept. */
export function withClickAt(clicks: readonly Click[], index: number, to: Point): Click[] {
  return clicks.map((p, i) => (i === index ? { ...p, x: to.x, y: to.y } : p));
}

/**
 * `clicks` with a click at `p` inserted into gap `gap`, after click `gap`.
 * The new click takes that click's mark, so a straight gap becomes two.
 */
export function withClickIn(clicks: readonly Click[], gap: number, p: Point): Click[] {
  const click: Click = clicks[gap].straight ? { x: p.x, y: p.y, straight: true } : { x: p.x, y: p.y };
  return [...clicks.slice(0, gap + 1), click, ...clicks.slice(gap + 1)];
}

/**
 * The line within the start distance of `at` that a click there inserts
 * into, and the gap it goes in, or null when no line with clicks is near.
 */
export function insertAt(ctx: ChainContext, at: Point): { line: number; gap: number } | null {
  const lines = tracks(ctx);
  const hit = hitTrack(lines, at, TRACK_FIT.startDistance * ctx.scene().dpt!);
  if (!hit || !lines[hit.line].clicks) return null;
  return { line: hit.line, gap: nearestGap(lines[hit.line], at) };
}

/**
 * `clicks` without click `index`. Its two gaps become one, straight only if
 * both were; with the first or last click goes the one gap it ends.
 */
export function withoutClick(clicks: readonly Click[], index: number): Click[] {
  const out = clicks.filter((_, i) => i !== index);
  if (index > 0) {
    const { x, y } = clicks[index - 1];
    out[index - 1] = clicks[index - 1].straight && clicks[index].straight ? { x, y, straight: true } : { x, y };
  }
  return out;
}

/**
 * The track tool's click with no chain live (#298, #302, #311, #321). A click
 * on a line's first or last click continues the line as a chain from there;
 * on a click between them it does nothing. Within the start distance of a
 * line it inserts a click at the pointer, as one entry; on a line with no
 * clicks it does nothing. Anywhere else a chain starts, even on a sensor.
 */
export const trackTool: ChainTool = (ctx, at, scale) => {
  const lines = tracks(ctx);
  const click = clickHitAt(lines, at, scale);
  if (click) {
    const last = lines[click.line].clicks!.length - 1;
    if (click.index !== 0 && click.index !== last) return { kind: 'edit', run: async () => NONE };
    return { kind: 'chain', chain: TrackChain.continuing(ctx, click.line, click.index === 0) };
  }
  const insert = insertAt(ctx, at);
  if (insert) return { kind: 'edit', run: () => insertClick(ctx, insert.line, insert.gap, pixel(at)) };
  if (hitTrack(lines, at, TRACK_FIT.startDistance * ctx.scene().dpt!)) return { kind: 'edit', run: async () => NONE };
  return { kind: 'chain', chain: TrackChain.starting(ctx, pixel(at)) };
};

/** Inserts a click at `p` into gap `gap` of line `index`, as one entry. One the rule refuses writes nothing. */
async function insertClick(ctx: ChainContext, index: number, gap: number, p: Point): Promise<ClickResult> {
  const lines = [...tracks(ctx)];
  const line = refitLine(ctx, withClickIn(lines[index].clicks!, gap, p));
  if (!line) return NONE;
  lines[index] = line;
  await ctx.record('insert click', { kind: 'layout' }, () => ctx.writeLayout({ tracks: lines }));
  return NONE;
}

/**
 * A chain of track: one track, traced click by click from either end. The
 * line in `layout.tracks` holds the clicks, in stored order, and the nodes of
 * their line; the chain holds the same line, which is what it draws, and
 * takes the stored one whenever it changes under it, as an undo does. Each
 * click, and each move or delete of a click (#303), builds the whole line
 * again from its clicks (`buildLine`), so the line is the same whichever end
 * it was traced from.
 */
export class TrackChain implements Chain {
  readonly tool = 'track';
  private readonly _ctx: ChainContext;
  private readonly _opts: FitOptions;
  /** The line's index, or null before the second click writes it. */
  private _index: number | null;
  /** Whether the chain goes on from the line's first click rather than its last. */
  private readonly _fromFirst: boolean;
  /** Whether the chain continues a line that was there before it. */
  private readonly _continued: boolean;
  private _line: Track;
  /** The line before each entry this chain wrote, oldest first. */
  private _before: Track[] = [];
  /** What the chain draws: the line, with a click where a drag holds it. */
  private _view: Track;

  /** A new line from `start`. */
  static starting(ctx: ChainContext, start: Point): TrackChain {
    return new TrackChain(ctx, { nodes: [], clicks: [start] }, null, false);
  }

  /** Line `index` going on from its last click, or with `fromFirst` its first. */
  static continuing(ctx: ChainContext, index: number, fromFirst: boolean): TrackChain {
    return new TrackChain(ctx, tracks(ctx)[index], index, fromFirst);
  }

  private constructor(ctx: ChainContext, line: Track, index: number | null, fromFirst: boolean) {
    this._ctx = ctx;
    // The track tool is gated on DPT, so a chain only starts with one.
    this._opts = fitOptions(ctx.scene().dpt!);
    this._index = index;
    this._fromFirst = fromFirst;
    this._continued = index !== null;
    this._line = line;
    this._view = line;
  }

  /** The line's index, or null before the second click writes it. */
  get line(): number | null {
    return this._index;
  }

  view(): ChainView {
    return { tool: 'track', end: this._end(), line: this._index, trace: this._view };
  }

  /** Whether every entry this chain wrote, click or edit, has been undone. */
  atStart(): boolean {
    return this._before.length === 0;
  }

  /**
   * Puts a click on the line at the end it goes on from, and writes the
   * line's clicks with the nodes of their line. The second click of a new
   * line writes a new track. A click within the grab radius of that end
   * adds nothing; one the rule refuses writes nothing and says why.
   */
  async extend(at: Point, scale: number): Promise<ClickResult> {
    const p = pixel(at);
    const end = this._end();
    if (Math.hypot(p.x - end.x, p.y - end.y) <= DEFAULT_GRAB_RADIUS_SCREEN_PX * scale) return NONE;
    const clicks = this._line.clicks!;
    await this._write(this._index === null ? 'place track' : 'extend track', this._fromFirst ? [p, ...clicks] : [...clicks, p]);
    return NONE;
  }

  /** Draws click `index` at `to` while a drag holds it, and the line as it is; null puts the click back. */
  hold(index: number, to: Point | null) {
    this._view = to ? { ...this._line, clicks: withClickAt(this._line.clicks!, index, to) } : this._line;
  }

  /** Moves click `index` to `to`, and builds the line again from its clicks. A move the rule refuses writes nothing. */
  async move(index: number, to: Point) {
    await this._write('move click', withClickAt(this._line.clicks!, index, to));
  }

  /** Deletes click `index` the same way. */
  async remove(index: number) {
    await this._write('delete click', withoutClick(this._line.clicks!, index));
  }

  /** The click the chain goes on from. */
  private _end(): Point {
    const clicks = this._line.clicks!;
    return this._fromFirst ? clicks[0] : clicks[clicks.length - 1];
  }

  /**
   * Builds the line of `clicks`, keeping the line as it was for an undo, and
   * writes it as one entry. The second click of a new line writes a new
   * track. Clicks the rule refuses write nothing, and the hint says why.
   */
  private async _write(label: string, clicks: readonly Click[]) {
    const line = lineOf(clicks, this._opts);
    if (typeof line === 'string') {
      this._ctx.refuse(line);
      return;
    }
    this._before.push(this._line);
    this._line = line;
    this._view = line;
    const lines = [...tracks(this._ctx)];
    const index = this._index ?? lines.length;
    lines[index] = line;
    this._index = index;
    await this._ctx.record(label, { kind: 'layout' }, () => this._ctx.writeLayout({ tracks: lines }));
  }

  /**
   * Takes the stored line when it differs from the chain's. A new line an
   * undo removed takes the chain back to its first click; a continued line
   * that is gone ends the chain. Track outlives an image change.
   */
  settle(): boolean {
    let line = this._index === null ? undefined : tracks(this._ctx)[this._index];
    if (!line) {
      if (this._continued) return false;
      this._index = null;
      line = { nodes: [], clicks: this._line.clicks!.slice(0, 1) };
    }
    if (sameClicks(line.clicks!, this._line.clicks!)) return true;
    const before = this._before.pop();
    if (!before || !sameClicks(line.clicks!, before.clicks!)) this._before = [];
    this._line = line;
    this._view = line;
    return true;
  }
}

/** Whether two click lists hold the same clicks with the same marks. */
function sameClicks(a: readonly Click[], b: readonly Click[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && !p.straight === !b[i].straight);
}

function tracks(ctx: ChainContext): readonly Track[] {
  return ctx.manifest().layout.tracks ?? [];
}
