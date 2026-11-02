/**
 * Synthetic clicks for the fit and trace tests (#300): points laid along a
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

/** Ten parts, 330 G: clicked every 2 G, 166 clicks. */
export const TEN_PARTS: readonly Piece[] = [
  { straight: 35 },
  { radius: 20, turn: 90 },
  { straight: 30 },
  { radius: 30, turn: -60 },
  { straight: 40 },
  { radius: 40, turn: 45 },
  { radius: 15, turn: -120 },
  { straight: 35 },
  { radius: 25, turn: 72 },
  { straight: 33 },
];

/** Total length of the pieces, gauges. */
export function lengthOf(pieces: readonly Piece[]): number {
  return pieces.reduce(
    (sum, p) => sum + ('straight' in p ? p.straight : (p.radius * Math.abs(p.turn) * Math.PI) / 180),
    0
  );
}

/** Where the curvature changes, and about every `spacing` gauges between: the clicks the projection rule expects. */
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

/** `p` moved `gauges` to the left of the direction from `before` to `after`. */
export function offLine(p: Point, before: Point, after: Point, gauges: number): Point {
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const len = Math.hypot(dx, dy);
  return { x: p.x - (dy / len) * gauges * G, y: p.y + (dx / len) * gauges * G };
}
