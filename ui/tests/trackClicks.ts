/**
 * Synthetic clicks for the line rule's tests (#300): points laid along a
 * known chain of straights and arcs, with a little seeded noise, so the
 * expected parts are known.
 */
import type { Point } from '@rails49/r49';

/** Gauge in image pixels, the user's photos' DPT. */
export const G = 32.5;

/** A straight `length` gauges long, or an arc of `radius` gauges turning `turn` degrees, positive left. */
export type Piece = { straight: number } | { radius: number; turn: number };

interface Lay {
  /** Gauges between clicks. */
  spacing?: number;
  /** Click noise σ, gauges, clipped at 2σ. */
  noise?: number;
  seed?: number;
}

/** A seeded pseudo-random number in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The true centerline point `s` gauges along the pieces, in pixels, from (400, 300) heading 0.3 rad. */
export function along(pieces: readonly Piece[], s: number): Point {
  let x = 400 / G;
  let y = 300 / G;
  let heading = 0.3;
  let left = s;
  for (const piece of pieces) {
    const length = 'straight' in piece ? piece.straight : (piece.radius * Math.abs(piece.turn) * Math.PI) / 180;
    const step = Math.min(left, length);
    if ('straight' in piece) {
      x += step * Math.cos(heading);
      y += step * Math.sin(heading);
    } else {
      const k = Math.sign(piece.turn) / piece.radius;
      const h = heading + k * step;
      x += (Math.sin(h) - Math.sin(heading)) / k;
      y -= (Math.cos(h) - Math.cos(heading)) / k;
      heading = h;
    }
    left -= step;
    if (left <= 0) break;
  }
  return { x: x * G, y: y * G };
}

/** Total length of the pieces, gauges. */
export function lengthOf(pieces: readonly Piece[]): number {
  return pieces.reduce(
    (sum, p) => sum + ('straight' in p ? p.straight : (p.radius * Math.abs(p.turn) * Math.PI) / 180),
    0
  );
}

/** Where the curvature changes, and about every `spacing` gauges between. */
export function positionsAlong(pieces: readonly Piece[], spacing = 10): number[] {
  const out = [0];
  let from = 0;
  for (const piece of pieces) {
    const length = 'straight' in piece ? piece.straight : (piece.radius * Math.abs(piece.turn) * Math.PI) / 180;
    const n = Math.max(1, Math.round(length / spacing));
    for (let i = 1; i <= n; i++) out.push(from + (length * i) / n);
    from += length;
  }
  return out;
}

/** A click at each of `positions`, gauges along the pieces. */
export function clicksAt(pieces: readonly Piece[], positions: readonly number[], { noise = 0.075, seed = 1 }: Lay = {}): Point[] {
  const rand = random(seed);
  const jitter = () => {
    const g = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return Math.max(-2, Math.min(2, g)) * noise * G;
  };
  return positions.map(s => {
    const p = along(pieces, s);
    return { x: p.x + jitter(), y: p.y + jitter() };
  });
}

/** Clicks every `spacing` gauges from one end to the other, both ends included. */
export function clicksAlong(pieces: readonly Piece[], { spacing = 3, ...lay }: Lay = {}): Point[] {
  const total = lengthOf(pieces);
  const n = Math.round(total / spacing);
  return clicksAt(
    pieces,
    Array.from({ length: n + 1 }, (_, i) => (total * i) / n),
    lay
  );
}

/** `p` laid at `G` scaled to `dpt` pixels a gauge, in whole pixels. */
function atDpt(p: Point, dpt: number): Point {
  const k = dpt / G;
  return { x: Math.round(p.x * k), y: Math.round(p.y * k) };
}

/** Clicks where the curvature of `pieces` changes and about every 10 G between, with no noise, at `dpt` in whole pixels. */
export function laidAlong(pieces: readonly Piece[], dpt = G): Point[] {
  return clicksAt(pieces, positionsAlong(pieces), { noise: 0 }).map(p => atDpt(p, dpt));
}

/**
 * For a line along a straight of 20 G into an arc: the fourth click 4 G
 * across, 10 G on from the straight's end, on an arc of 13 G. Between the
 * third and fifth clicks the line then needs an arc tighter than 10 G, so
 * moving the fourth click here is refused.
 */
export function tooTight(dpt = G): Point {
  return atDpt(along([{ straight: 20 }, { radius: 13, turn: 90 }], 30), dpt);
}

/**
 * A straight of 20 G into a 12 G arc, clicked every 5 G along the arc.
 * Without the click where the curve starts, the third, the line turns from
 * the straight into the arc within one gap and needs an arc tighter than
 * 10 G, so deleting the third click is refused.
 */
export function tightClicks(dpt = G): Point[] {
  return clicksAt([{ straight: 20 }, { radius: 12, turn: 120 }], [0, 10, 20, 25, 30, 35, 40], { noise: 0 }).map(p => atDpt(p, dpt));
}

/** `p` moved `gauges` to the left of the direction from `before` to `after`. */
export function offLine(p: Point, before: Point, after: Point, gauges: number): Point {
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const len = Math.hypot(dx, dy);
  return { x: p.x - (dy / len) * gauges * G, y: p.y + (dx / len) * gauges * G };
}
