import type { Centerline, Point } from '@rails49/r49';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import { pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import {
  extendTrack,
  hitTrack,
  insertNode,
  reverseNodes,
  HEADING_HANDLE_SCREEN_PX,
  STRAIGHT_SNAP_SCREEN_PX,
} from './track.js';
import type { Track, TrackHit, TrackNode, TrackStep } from './track.js';

/** Why the track tool refused a click (#284). */
export const TURN_TOO_SHARP = 'One segment turns at most 90°. Place a node before the turn gets that sharp.';

/** What the track tool's pointer is on: a heading handle, a node or a line. */
export function trackHitAt(tracks: readonly Track[], at: Point, scale: number): TrackHit | null {
  return hitTrack(tracks, at, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale, HEADING_HANDLE_SCREEN_PX * scale);
}

/**
 * The track tool's click with no chain live (#284). An end node continues its
 * line, a click on a line inserts a node there, and a middle node or a
 * heading handle does nothing. Anywhere else a chain starts, even on a sensor:
 * sensors sit on the track being laid.
 */
export const trackTool: ChainTool = (ctx, at, scale) => {
  const lines = centerlines(ctx);
  const hit = trackHitAt(lines, at, scale);
  switch (hit?.kind) {
    case 'heading':
      return { kind: 'edit', run: async () => NONE };
    case 'curve':
      return { kind: 'edit', run: () => insert(ctx, hit.line, hit.segment, hit.t) };
    case 'node': {
      const nodes = lines[hit.line].nodes;
      if (hit.node !== 0 && hit.node !== nodes.length - 1) return { kind: 'edit', run: async () => NONE };
      const { x, y } = nodes[hit.node];
      return { kind: 'chain', chain: new TrackChain(ctx, { x, y }, hit.line, hit.node === 0) };
    }
  }
  return { kind: 'chain', chain: new TrackChain(ctx, pixel(at), null, false) };
};

/**
 * A chain of track: one centerline, laid a node per click. Its nodes are in
 * `layout.centerlines`; the chain keeps which line it writes and how many
 * nodes that line had when it began.
 */
export class TrackChain implements Chain {
  readonly tool = 'track';
  private readonly _ctx: ChainContext;
  private readonly _start: Point;
  /** The line's index, or null before the second click writes it. */
  private _index: number | null;
  /** Whether the chain runs against the stored order: it continues the line from its first node. */
  private _reversed: boolean;
  /** How many nodes the line had when the chain began. */
  private _base: number;

  constructor(ctx: ChainContext, start: Point, index: number | null, reversed: boolean) {
    this._ctx = ctx;
    this._start = start;
    this._index = index;
    this._reversed = reversed;
    this._base = index === null ? 0 : centerlines(ctx)[index].nodes.length;
  }

  view(): ChainView {
    const nodes = this._nodes();
    const last = nodes[nodes.length - 1];
    return {
      tool: 'track',
      end: last ? { x: last.x, y: last.y } : this._start,
      start: this._start,
      nodes,
    };
  }

  atStart(): boolean {
    return this._nodes().length <= this._base;
  }

  /** What a click at `at` would add. */
  preview(at: Point, scale: number): TrackStep {
    return extendTrack(
      this._start,
      this._nodes(),
      at,
      STRAIGHT_SNAP_SCREEN_PX * scale,
      DEFAULT_GRAB_RADIUS_SCREEN_PX * scale
    );
  }

  /** The second click writes a new centerline; each later one replaces its nodes. */
  async extend(at: Point, scale: number): Promise<ClickResult> {
    const step = this.preview(pixel(at), scale);
    if (step.kind !== 'node') {
      return step.kind === 'too-sharp' ? { kind: 'notice', message: TURN_TOO_SHARP } : NONE;
    }
    const lines = [...centerlines(this._ctx)];
    const index = this._index ?? lines.length;
    lines[index] = { nodes: this._reversed ? reverseNodes(step.nodes) : [...step.nodes] };
    const label = this._index === null ? 'place centerline' : 'extend centerline';
    this._index = index;
    await this._ctx.record(label, { kind: 'layout' }, () => this._ctx.writeLayout({ centerlines: lines }));
    return NONE;
  }

  /** A chain whose line an undo removed goes back to its start. Track outlives an image change. */
  settle(): boolean {
    if (this._index !== null && !centerlines(this._ctx)[this._index]) {
      this._index = null;
      this._reversed = false;
      this._base = 0;
    }
    return true;
  }

  private _nodes(): readonly TrackNode[] {
    const line = this._index === null ? undefined : centerlines(this._ctx)[this._index];
    const nodes = line?.nodes ?? [];
    return this._reversed ? reverseNodes(nodes) : nodes;
  }
}

/** Writes a node on line `line` at `t` along `segment`. */
async function insert(ctx: ChainContext, line: number, segment: number, t: number): Promise<ClickResult> {
  const lines = [...centerlines(ctx)];
  lines[line] = { nodes: insertNode(lines[line].nodes, segment, t) };
  await ctx.record('insert centerline node', { kind: 'layout' }, () =>
    ctx.writeLayout({ centerlines: lines })
  );
  return NONE;
}

function centerlines(ctx: ChainContext): readonly Centerline[] {
  return ctx.manifest().layout.centerlines ?? [];
}
