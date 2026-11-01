import { make_id } from '@rails49/r49';
import type { CarLabel, Point } from '@rails49/r49';
import { carCovering, hitTest, DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import type { CarEnd } from './geometry.js';
import { grab, pixel, NONE } from './chain.js';
import type { Chain, ChainContext, ChainTool, ChainView, ClickResult } from './chain.js';
import { rootClass } from './vocabulary.js';

/** Node id for the car ids this tool mints; sensor and label ids are separate namespaces. */
const CAR_NODE_ID = 5;

/** Why the car tool refused a click on a coupling (#43). */
export const ALREADY_LABELED =
  'That pixel is already inside a labeled car — a car is labeled once.';

/**
 * The car tool's click with no chain live (#33). A free car end continues a
 * chain from it, a coupling is refused, and a click on a car's body splits it
 * there. Empty image starts a chain. A sensor or reference point under the
 * pointer is the session's.
 */
export const carTool: ChainTool = (ctx, at, scale) => {
  const image = ctx.image();
  if (!image) return null;
  const scene = ctx.scene();
  const hit = hitTest(scene, at, grab(scale));
  switch (hit?.kind) {
    case 'car-endpoint': {
      const end = hit.ends[0];
      const car = scene.cars.find(c => c.id === end.id);
      if (!car) return null;
      return { kind: 'chain', chain: new CarChain(ctx, image.filename, car[end.end], end) };
    }
    case 'coupler':
      return { kind: 'edit', run: async () => ({ kind: 'notice', message: ALREADY_LABELED }) };
    case 'sensor':
    case 'calibration':
      return null;
  }
  const car = carCovering(scene, at);
  if (car) return { kind: 'edit', run: () => splitCar(ctx, image.filename, car.id, at, scale) };
  return { kind: 'chain', chain: new CarChain(ctx, image.filename, pixel(at), null) };
};

/**
 * A chain of cars on one image. Each click writes the car from the last dot
 * to the click, so the coupling it makes is exact by construction. The last
 * dot is the far end of the last car it wrote that is still there, else the
 * car end it continues, else its first click.
 */
class CarChain implements Chain {
  readonly tool = 'car';
  private readonly _ctx: ChainContext;
  private readonly _filename: string;
  private readonly _start: Point;
  private readonly _origin: CarEnd | null;
  private readonly _written: string[] = [];

  constructor(ctx: ChainContext, filename: string, start: Point, origin: CarEnd | null) {
    this._ctx = ctx;
    this._filename = filename;
    this._start = { ...start };
    this._origin = origin;
  }

  view(): ChainView {
    return { tool: 'car', end: this._lastDot() };
  }

  atStart(): boolean {
    return !this._written.some(id => this._car(id));
  }

  async extend(px: Point, scale: number): Promise<ClickResult> {
    const from = this._lastDot();
    const image = this._ctx.manifest().images.find(img => img.filename === this._filename);
    if (!image || near(px, from, DEFAULT_GRAB_RADIUS_SCREEN_PX * scale)) return NONE;

    const car: CarLabel = {
      id: make_id(CAR_NODE_ID),
      class: rootClass(),
      provenance: 'human',
      p0: { ...from },
      p1: { ...px },
    };
    this._written.push(car.id);
    await this._ctx.record('place car', { kind: 'image', filename: image.filename }, () => {
      this._ctx.writeImage(image.filename, { labels: [...image.labels, car] });
    });
    return NONE;
  }

  /** A car chain ends when its image leaves the screen. */
  settle(): boolean {
    return this._ctx.image()?.filename === this._filename;
  }

  private _lastDot(): Point {
    for (const id of [...this._written].reverse()) {
      const car = this._car(id);
      if (car) return car.p1;
    }
    const origin = this._origin && this._car(this._origin.id);
    return origin ? origin[this._origin!.end] : this._start;
  }

  private _car(id: string): CarLabel | undefined {
    const image = this._ctx.manifest().images.find(img => img.filename === this._filename);
    return image?.labels.find(car => car.id === id);
  }
}

/**
 * Splits car `id` in two at the point on its axis nearest `at`, as one entry.
 * The second half gets a new id and keeps everything else. A split within the
 * grab radius of either end does nothing.
 */
async function splitCar(
  ctx: ChainContext,
  filename: string,
  id: string,
  at: Point,
  scale: number
): Promise<ClickResult> {
  const image = ctx.manifest().images.find(img => img.filename === filename);
  const car = image?.labels.find(label => label.id === id);
  if (!image || !car) return NONE;
  const dx = car.p1.x - car.p0.x;
  const dy = car.p1.y - car.p0.y;
  const t = ((at.x - car.p0.x) * dx + (at.y - car.p0.y) * dy) / (dx * dx + dy * dy);
  const mid = pixel({ x: car.p0.x + t * dx, y: car.p0.y + t * dy });
  const reach = DEFAULT_GRAB_RADIUS_SCREEN_PX * scale;
  if (!Number.isFinite(t) || near(mid, car.p0, reach) || near(mid, car.p1, reach)) return NONE;

  const labels = image.labels.flatMap(label =>
    label.id === id ? [{ ...label, p1: mid }, { ...label, id: make_id(CAR_NODE_ID), p0: mid }] : [label]
  );
  await ctx.record('split car', { kind: 'image', filename }, () => ctx.writeImage(filename, { labels }));
  return NONE;
}

function near(a: Point, b: Point, reach: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= reach;
}
