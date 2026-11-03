import { wrapAngle } from '@rails49/r49';
import type { Click, Point, TrackNode } from '@rails49/r49';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import { pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainHit, ChainTool, ChainView, ClickResult } from './chain.js';
import { hitClick, hitTrack, nearestGap, squareAt } from './track.js';
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

/** What a click on a line's middle dot does instead (#324). */
export const MIDDLE_CLICK = 'To change this click, drag it or right-click it.';

/** What a click near a line with no clicks does instead (#324). */
export const NO_CLICKS = 'This line has no clicks to change. Right-click it to delete it.';

/** The next gap a click would add, from the end a chain goes on from to the pointer (#324). */
export interface TrackPreview {
  /** The gap as the rule builds it; where the rule refuses, a straight to the pointer. */
  readonly nodes: readonly TrackNode[];
  /** Why the rule refuses a click at the pointer, or null. */
  readonly refusal: Refusal | null;
}

/** What the track tool's pointer is over with no chain live (#324). */
export type TrackHover =
  /** A line's first or last click, which a click continues the line from. */
  | { readonly kind: 'end'; readonly at: Point; readonly square: boolean }
  /** Within the start distance of a line: where a click inserts a click. */
  | { readonly kind: 'insert'; readonly at: Point };

/** A track of a set of clicks, or why the rule refuses them. */
export type Lined = { readonly kind: 'line'; readonly track: Track } | { readonly kind: 'refused'; readonly reason: Refusal };

/**
 * `clicks` with the nodes of their line (`buildLine`), or why the rule
 * refuses them. One click has no nodes.
 */
export function lineOf(clicks: readonly Click[], opts: FitOptions): Lined {
  if (clicks.length < 2) return { kind: 'line', track: { nodes: [], clicks: [...clicks] } };
  const built = buildLine(clicks, opts);
  return built.kind === 'line' ? { kind: 'line', track: { nodes: fitNodes(built.fit), clicks: [...clicks] } } : built;
}

/**
 * A line of `clicks` and the nodes of their line: an edit with no chain
 * live. Null, and the edit is refused with the rule's reason, when the rule
 * refuses the clicks.
 */
export function refitLine(ctx: ChainContext, clicks: readonly Click[]): Track | null {
  const line = lineOf(clicks, fitOptions(ctx.scene().dpt!));
  if (line.kind === 'line') return line.track;
  ctx.refuse(line.reason);
  return null;
}

/** Writes `track` as line `index`, or as a new line when `index` is the number of lines. */
export function writeTrack(ctx: ChainContext, index: number, track: Track) {
  const lines = [...tracks(ctx)];
  lines[index] = track;
  ctx.writeLayout({ tracks: lines });
}

/**
 * Writes line `index` with `clicks` and the nodes of their line, as one
 * entry `label`. Clicks the rule refuses write nothing, and the hint says why.
 */
export async function recordLine(ctx: ChainContext, label: string, index: number, clicks: readonly Click[]) {
  const line = refitLine(ctx, clicks);
  if (line) await ctx.record(label, { kind: 'layout' }, () => writeTrack(ctx, index, line));
}

/** The click at `p`, starting a straight gap when `straight`. */
export function markedClick(p: Point, straight: boolean | undefined): Click {
  return straight ? { x: p.x, y: p.y, straight: true } : { x: p.x, y: p.y };
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
  return [...clicks.slice(0, gap + 1), markedClick(p, clicks[gap].straight), ...clicks.slice(gap + 1)];
}

/**
 * The line within the start distance of `at` that a click there inserts
 * into, and the gap it goes in, or null when no line is near. A line with
 * no clicks has no gap to insert into.
 */
export function insertAt(ctx: ChainContext, at: Point): { line: number; gap: number | null } | null {
  const lines = tracks(ctx);
  const hit = hitTrack(lines, at, TRACK_FIT.startDistance * ctx.scene().dpt!);
  if (!hit) return null;
  return { line: hit.line, gap: lines[hit.line].clicks ? nearestGap(lines[hit.line], at) : null };
}

/**
 * `clicks` without click `index`. Its two gaps become one, straight only if
 * both were; with the first or last click goes the one gap it ends.
 */
export function withoutClick(clicks: readonly Click[], index: number): Click[] {
  const out = clicks.filter((_, i) => i !== index);
  if (index > 0) out[index - 1] = markedClick(clicks[index - 1], clicks[index - 1].straight && clicks[index].straight);
  return out;
}

/** What the track tool's pointer is on with no chain live. */
type Under =
  /** A line's first or last click. */
  | { readonly kind: 'end'; readonly line: number; readonly index: number }
  /** A click between a line's first and last. */
  | { readonly kind: 'middle' }
  /** Within the start distance of a line, in gap `gap`. */
  | { readonly kind: 'insert'; readonly line: number; readonly gap: number }
  /** Within the start distance of a line with no clicks. */
  | { readonly kind: 'no-clicks' }
  /** Anywhere else. */
  | { readonly kind: 'start' };

function under(ctx: ChainContext, at: Point, scale: number): Under {
  const lines = tracks(ctx);
  const click = clickHitAt(lines, at, scale);
  if (click) {
    const last = lines[click.line].clicks!.length - 1;
    return click.index === 0 || click.index === last ? { kind: 'end', ...click } : { kind: 'middle' };
  }
  const insert = insertAt(ctx, at);
  if (!insert) return { kind: 'start' };
  return insert.gap === null ? { kind: 'no-clicks' } : { kind: 'insert', line: insert.line, gap: insert.gap };
}

/**
 * The track tool's click with no chain live (#298, #302, #311, #321). A click
 * on a line's first or last click continues the line as a chain from there;
 * on a click between them it says what to do instead (#324). Within the
 * start distance of a line it inserts a click at the pointer, as one entry;
 * on a line with no clicks it says what to do instead. Anywhere else a chain
 * starts, even on a sensor.
 */
export const trackTool: ChainTool = (ctx, at, scale) => {
  const hit = under(ctx, at, scale);
  switch (hit.kind) {
    case 'end':
      return { kind: 'chain', chain: TrackChain.continuing(ctx, hit.line, hit.index === 0) };
    case 'middle':
      return notice(ctx, MIDDLE_CLICK);
    case 'no-clicks':
      return notice(ctx, NO_CLICKS);
    case 'start':
      return { kind: 'chain', chain: TrackChain.starting(ctx, pixel(at)) };
    case 'insert': {
      const clicks = tracks(ctx)[hit.line].clicks!;
      return {
        kind: 'edit',
        run: async () => {
          await recordLine(ctx, 'insert click', hit.line, withClickIn(clicks, hit.gap, pixel(at)));
          return NONE;
        },
      };
    }
  }
};

/** An edit that writes nothing and says `message`. */
function notice(ctx: ChainContext, message: string): ChainHit {
  return {
    kind: 'edit',
    run: async () => {
      ctx.notify(message);
      return NONE;
    },
  };
}

/**
 * What a click at `at` would do with no chain live, as `trackTool` decides
 * it: continue a line from an end dot, or insert a click. Null on a middle
 * dot, near a line with no clicks, and where a click starts a line.
 */
export function trackHover(ctx: ChainContext, at: Point, scale: number): TrackHover | null {
  const hit = under(ctx, at, scale);
  switch (hit.kind) {
    case 'end': {
      const clicks = tracks(ctx)[hit.line].clicks!;
      const p = clicks[hit.index];
      return { kind: 'end', at: { x: p.x, y: p.y }, square: squareAt(clicks, hit.index) };
    }
    case 'insert':
      return { kind: 'insert', at: pixel(at) };
    default:
      return null;
  }
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
  /** Whether a double-click asked for the gap to the next click to be straight. */
  private _straight = false;

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

  /**
   * The line as drawn, in the order it is traced, so the click it goes on
   * from is the last; that click carries the straight mark a double-click
   * asked for.
   */
  view(): ChainView {
    const trace = this._fromFirst ? reversed(this._view) : this._view;
    const clicks = trace.clicks!;
    const shown = this._straight ? { ...trace, clicks: [...clicks.slice(0, -1), markedClick(clicks.at(-1)!, true)] } : trace;
    return { tool: 'track', end: this._end(), line: this._index, trace: shown };
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
    if (this._atEnd(p, scale)) return NONE;
    const label = this._index === null ? 'place track' : 'extend track';
    if (await this._write(label, this._extended(p))) this._straight = false;
    return NONE;
  }

  /**
   * The next gap a click at `at` would add, from the click the chain goes on
   * from, in the order traced: as the rule builds it, or a straight to `at`
   * with the reason where it refuses the click. Null within the grab radius
   * of that click, where a click adds nothing. Writes nothing.
   */
  preview(at: Point, scale: number): TrackPreview | null {
    const p = pixel(at);
    if (this._atEnd(p, scale)) return null;
    const end = this._end();
    const line = lineOf(this._extended(p), this._opts);
    if (line.kind === 'refused') {
      const heading = Math.atan2(p.y - end.y, p.x - end.x);
      return { nodes: [{ x: end.x, y: end.y, heading }, { x: p.x, y: p.y, heading }], refusal: line.reason };
    }
    const nodes = (this._fromFirst ? reversed(line.track) : line.track).nodes;
    const distance = (n: TrackNode) => Math.hypot(n.x - end.x, n.y - end.y);
    const from = nodes.reduce((best, n, i) => (distance(n) < distance(nodes[best]) ? i : best), 0);
    return { nodes: nodes.slice(from), refusal: null };
  }

  /** The line's clicks with `p` at the end the chain goes on from, and a straight asked for marked. */
  private _extended(p: Point): Click[] {
    const clicks = this._line.clicks!;
    if (this._fromFirst) return [markedClick(p, this._straight), ...clicks];
    const marked = this._straight ? [...clicks.slice(0, -1), markedClick(clicks.at(-1)!, true)] : clicks;
    return [...marked, p];
  }

  /**
   * A double-click at `at`, on the click the chain goes on from: the gap to
   * the next click is to be straight. The next click writes the mark with
   * itself as one entry. Elsewhere it does nothing.
   */
  straighten(at: Point, scale: number) {
    if (this._atEnd(pixel(at), scale)) this._straight = true;
  }

  /**
   * Draws click `index` at `to` while a drag holds it, with the line of the
   * moved clicks, or the last line the rule took where it refuses them; null
   * puts the click back. Returns why the rule refuses the click at `to`, or
   * null.
   */
  hold(index: number, to: Point | null): Refusal | null {
    if (!to) {
      this._view = this._line;
      return null;
    }
    const clicks = withClickAt(this._line.clicks!, index, to);
    const line = lineOf(clicks, this._opts);
    this._view = { ...(line.kind === 'line' ? line.track : this._view), clicks };
    return line.kind === 'line' ? null : line.reason;
  }

  /** Moves click `index` to `to`, and builds the line again from its clicks. A move the rule refuses writes nothing. */
  async move(index: number, to: Point) {
    await this._write('move click', withClickAt(this._line.clicks!, index, to));
  }

  /** Deletes click `index` the same way, and drops a straight asked for. */
  async remove(index: number) {
    if (await this._write('delete click', withoutClick(this._line.clicks!, index))) this._straight = false;
  }

  /** The click the chain goes on from. */
  private _end(): Point {
    const clicks = this._line.clicks!;
    return this._fromFirst ? clicks[0] : clicks[clicks.length - 1];
  }

  /** Whether `p` is within the grab radius of the click the chain goes on from. */
  private _atEnd(p: Point, scale: number): boolean {
    const end = this._end();
    return Math.hypot(p.x - end.x, p.y - end.y) <= DEFAULT_GRAB_RADIUS_SCREEN_PX * scale;
  }

  /**
   * Builds the line of `clicks`, keeping the line as it was for an undo, and
   * writes it as one entry. The second click of a new line writes a new
   * track. Clicks the rule refuses write nothing, and the hint says why.
   * Returns whether it wrote.
   */
  private async _write(label: string, clicks: readonly Click[]): Promise<boolean> {
    const built = lineOf(clicks, this._opts);
    if (built.kind === 'refused') {
      this._ctx.refuse(built.reason);
      return false;
    }
    const line = built.track;
    this._before.push(this._line);
    this._line = line;
    this._view = line;
    const index = this._index ?? tracks(this._ctx).length;
    this._index = index;
    await this._ctx.record(label, { kind: 'layout' }, () => writeTrack(this._ctx, index, line));
    return true;
  }

  /**
   * Takes the stored line when it differs from the chain's. A new line an
   * undo removed takes the chain back to its first click; a continued line
   * that is gone ends the chain, and a straight asked for is dropped.
   * Track outlives an image change.
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
    this._straight = false;
    return true;
  }
}

/** `line` the other way round: a gap's mark goes to the click that now starts it. */
function reversed(line: Track): Track {
  const clicks = line.clicks!;
  const n = clicks.length;
  return {
    nodes: line.nodes.map(p => ({ ...p, heading: wrapAngle(p.heading + Math.PI) })).reverse(),
    clicks: clicks.map((_, j) => markedClick(clicks[n - 1 - j], j < n - 1 && clicks[n - 2 - j].straight)),
  };
}

/** Whether two click lists hold the same clicks with the same marks. */
function sameClicks(a: readonly Click[], b: readonly Click[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && !p.straight === !b[i].straight);
}

function tracks(ctx: ChainContext): readonly Track[] {
  return ctx.manifest().layout.tracks ?? [];
}
