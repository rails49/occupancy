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

/** Total length of the pieces, gauges. */
export function lengthOf(pieces: readonly Piece[]): number {
  return pieces.reduce(
    (sum, p) => sum + ('straight' in p ? p.straight : (p.radius * Math.abs(p.turn) * Math.PI) / 180),
    0
  );
}

/** Clicks every `spacing` gauges from one end to the other, both ends included. */
export function clicksAlong(pieces: readonly Piece[], { spacing = 3, noise = 0.075, seed = 1 }: Lay = {}): Point[] {
  const total = lengthOf(pieces);
  const n = Math.round(total / spacing);
  const rand = random(seed);
  const jitter = () => {
    const g = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return Math.max(-2, Math.min(2, g)) * noise * G;
  };
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = along(pieces, (total * i) / n);
    return { x: p.x + jitter(), y: p.y + jitter() };
  });
}

/** `p` moved `gauges` to the left of the direction from `before` to `after`. */
export function offLine(p: Point, before: Point, after: Point, gauges: number): Point {
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const len = Math.hypot(dx, dy);
  return { x: p.x - (dy / len) * gauges * G, y: p.y + (dx / len) * gauges * G };
}
