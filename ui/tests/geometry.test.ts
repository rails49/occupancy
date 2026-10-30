import { describe, it, expect } from 'vitest';
import type { ReferencePoint, CarLabel, Sensor } from '@rails49/r49';
import {
  coupledEnds,
  samePoint,
  carWidthPx,
  carCorners,
  carCovering,
  carUnderPointer,
  clampToViewport,
  couplerPoints,
  dragHandles,
  dragTo,
  estimateLabelWidthPx,
  hitTest,
  isClick,
  isCoincident,
  overlayFit,
  placeLabel,
  sensorDiameterPx,
  SYMBOL_SIZE_SCREEN_PX,
  trackWidthPx,
  boundsOfPoints,
  capZoomRect,
  clampZoomRect,
  panZoomRect,
  rectBetween,
  revealZoom,
  zoomRectFromDrag,
  zoomTransform,
  MAX_ZOOM_SCREEN_PX_PER_FRAME_PX,
  CAR_AREA_MARGIN_G,
  NO_TRACK_G,
  PATCH_ACROSS_G,
  PATCH_ALONG_G,
  inCarArea,
  nearestCenterline,
  patchCorners,
  secondCenterlineReachPx,
  sensorTrack,
} from '../src/geometry.js';
import type { Centerline, HitScene, HitTolerance, Rect } from '../src/geometry.js';

function car(id: string, p0: { x: number; y: number }, p1: { x: number; y: number }): CarLabel {
  return { id, class: 'stock', p0, p1, provenance: 'human' };
}

function sensor(id: string, x: number, y: number): Sensor {
  return { id, x, y };
}

function calibrationPoint(x: number, y: number): ReferencePoint {
  return { px: { x, y }, world: { x: 0, y: 0, z: 0 } };
}

const emptyScene: HitScene = { cars: [], sensors: [], calibrationPoints: [], dpt: null };

/** 10 image pixels of grab radius: 5 screen px at 2 image px per screen px. */
const tolerance: HitTolerance = { screenPx: 5, imagePxPerScreenPx: 2 };

describe('trackWidthPx', () => {
  it('is DPT itself, because DPT is the gauge in image pixels', () => {
    // `getDPT` returns px_per_mm * gauge_mm, so the number already *is* the
    // track measured in the image's pixels. The function names the identity.
    for (const dpt of [1, 18.4, 20, 137]) {
      expect(trackWidthPx(dpt)).to.equal(dpt);
    }
  });

  it('is what a car width is 2.09 of', () => {
    // A sensor is one of these across and a car is 2.09, so the two are
    // comparable on the photograph — which is the point of drawing either at a
    // world size rather than a screen one.
    expect(carWidthPx(20) / trackWidthPx(20)).to.be.closeTo(2.0906, 1e-4);
  });
});

describe('carWidthPx', () => {
  it('is DPT x STANDARD_WIDTH / STANDARD_GAUGE', () => {
    // Written out: a 3000 mm standard width over `@rails49/r49`'s 1435 mm
    // standard gauge.
    expect(carWidthPx(20)).to.be.closeTo((20 * 3000) / 1435, 1e-9);
  });

  it('is 2.09 track widths at any DPT, so no scale enters the arithmetic', () => {
    // The scale ratio cancels out of `DPT * standard_width / standard_gauge`,
    // which is why the editor never looks a scale up. Same multiple at every DPT.
    for (const dpt of [1, 18.4, 20, 137]) {
      expect(carWidthPx(dpt) / dpt).to.be.closeTo(2.0906, 1e-4);
    }
  });

  it('is zero at zero DPT rather than throwing', () => {
    expect(carWidthPx(0)).to.equal(0);
  });
});

describe('carCorners', () => {
  const dpt = 20;
  const half = carWidthPx(dpt) / 2;

  it('offsets a horizontal span perpendicular to its axis', () => {
    const corners = carCorners({ x: 100, y: 50 }, { x: 300, y: 50 }, dpt);
    expect(corners).to.deep.equal([
      { x: 100, y: 50 - half },
      { x: 300, y: 50 - half },
      { x: 300, y: 50 + half },
      { x: 100, y: 50 + half },
    ]);
  });

  it('offsets a vertical span perpendicular to its axis', () => {
    const [a, b, c, d] = carCorners({ x: 40, y: 10 }, { x: 40, y: 90 }, dpt);
    expect(a.x).to.be.closeTo(40 + half, 1e-9);
    expect(a.y).to.be.closeTo(10, 1e-9);
    expect(b.x).to.be.closeTo(40 + half, 1e-9);
    expect(b.y).to.be.closeTo(90, 1e-9);
    expect(c.x).to.be.closeTo(40 - half, 1e-9);
    expect(d.x).to.be.closeTo(40 - half, 1e-9);
  });

  it('keeps the rectangle the derived width wide however the span is angled', () => {
    const [a, , , d] = carCorners({ x: 0, y: 0 }, { x: 120, y: 120 }, dpt);
    const width = Math.hypot(a.x - d.x, a.y - d.y);
    expect(width).to.be.closeTo(carWidthPx(dpt), 1e-9);
  });

  it('keeps the long sides parallel to the span', () => {
    const p0 = { x: 30, y: 70 };
    const p1 = { x: 210, y: 10 };
    const [a, b] = carCorners(p0, p1, dpt);
    // Cross product of the span and the long side is zero when they are parallel.
    const cross = (p1.x - p0.x) * (b.y - a.y) - (p1.y - p0.y) * (b.x - a.x);
    expect(cross).to.be.closeTo(0, 1e-9);
  });

  it('collapses to the point itself when the span has no length', () => {
    // The first click of a chain has no second point yet, so the direction is
    // undefined. Collapsing is honest; picking an arbitrary axis is not.
    const corners = carCorners({ x: 5, y: 6 }, { x: 5, y: 6 }, dpt);
    expect(corners).to.deep.equal([
      { x: 5, y: 6 },
      { x: 5, y: 6 },
      { x: 5, y: 6 },
      { x: 5, y: 6 },
    ]);
  });
});

describe('carCovering', () => {
  const dpt = 20;
  const half = carWidthPx(dpt) / 2;

  /** The scene as the car tool sees it: some cars, and a DPT to size them by. */
  function carScene(cars: CarLabel[], sceneDpt: number | null = dpt): HitScene {
    return { ...emptyScene, cars, dpt: sceneDpt };
  }

  it('finds nothing when no car is labelled', () => {
    expect(carCovering(carScene([]), { x: 10, y: 10 })).to.equal(null);
  });

  it('finds nothing with no DPT, where there is no rectangle to be inside of', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carCovering(carScene([a], null), { x: 200, y: 50 })).to.equal(null);
  });

  it('finds the car whose rectangle the point is inside', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carCovering(carScene([a]), { x: 200, y: 50 })).to.equal(a);
  });

  it('finds nothing beside a car, past half its width', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carCovering(carScene([a]), { x: 200, y: 50 + half + 1 })).to.equal(null);
  });

  it('finds nothing beyond a car end, however close to its axis', () => {
    // The rectangle is capped at the two ends: a click just past the coupler of
    // the last car in a train starts the next car, which is the whole point of
    // being able to keep labelling a consist.
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carCovering(carScene([a]), { x: 301, y: 50 })).to.equal(null);
  });

  it('counts a point exactly on the long edge as inside', () => {
    // Boundary is inside: the refusal errs towards refusing, the same direction
    // the width itself errs in. The car runs along y = 0 so that the edge is at
    // `half` exactly — `50 + half` then measured back from 50 is not.
    const a = car('a', { x: 100, y: 0 }, { x: 300, y: 0 });
    expect(carCovering(carScene([a]), { x: 200, y: half })).to.equal(a);
    expect(carCovering(carScene([a]), { x: 200, y: -half })).to.equal(a);
  });

  it('counts a point exactly on the end cap as inside', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carCovering(carScene([a]), { x: 300, y: 50 })).to.equal(a);
  });

  it('follows a diagonal span rather than its bounding box', () => {
    // The corner of the axis-aligned bounding box of a 45-degree car is far
    // outside the car itself — the case a naive min/max test gets wrong.
    const a = car('a', { x: 0, y: 0 }, { x: 200, y: 200 });
    expect(carCovering(carScene([a]), { x: 100, y: 100 })).to.equal(a);
    expect(carCovering(carScene([a]), { x: 200, y: 0 })).to.equal(null);
  });

  it('measures a diagonal car across its own axis', () => {
    const a = car('a', { x: 0, y: 0 }, { x: 200, y: 200 });
    // Perpendicular to a 45-degree span, at just under and just over half width.
    const step = (half - 0.5) / Math.SQRT2;
    expect(carCovering(carScene([a]), { x: 100 + step, y: 100 - step })).to.equal(a);
    const past = (half + 0.5) / Math.SQRT2;
    expect(carCovering(carScene([a]), { x: 100 + past, y: 100 - past })).to.equal(null);
  });

  it('returns the first car in scene order where two overlap', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    const b = car('b', { x: 200, y: 20 }, { x: 200, y: 80 });
    expect(carCovering(carScene([a, b]), { x: 200, y: 50 })).to.equal(a);
  });

  it('covers only its own pixel when a car has no length', () => {
    // The editor refuses to author one, so it can only arrive from outside; a
    // span with no axis has no rectangle to be inside of.
    const a = car('a', { x: 5, y: 6 }, { x: 5, y: 6 });
    expect(carCovering(carScene([a]), { x: 5, y: 6 })).to.equal(a);
    expect(carCovering(carScene([a]), { x: 6, y: 6 })).to.equal(null);
  });
});

describe('hitTest', () => {
  it('finds nothing in an empty scene', () => {
    expect(hitTest(emptyScene, { x: 0, y: 0 }, tolerance)).to.equal(null);
  });

  describe('car endpoints', () => {
    const scene: HitScene = {
      ...emptyScene,
      cars: [car('c1', { x: 100, y: 100 }, { x: 200, y: 100 })],
    };

    it('hits p0 within the tolerance', () => {
      const hit = hitTest(scene, { x: 104, y: 100 }, tolerance);
      expect(hit).to.deep.equal({ kind: 'car-endpoint', ends: [{ id: 'c1', end: 'p0' }] });
    });

    it('hits p1 within the tolerance', () => {
      const hit = hitTest(scene, { x: 200, y: 106 }, tolerance);
      expect(hit).to.deep.equal({ kind: 'car-endpoint', ends: [{ id: 'c1', end: 'p1' }] });
    });

    it('misses just outside the tolerance', () => {
      expect(hitTest(scene, { x: 111, y: 100 }, tolerance)).to.equal(null);
    });

    it('does not hit the middle of the span — only its ends are handles', () => {
      expect(hitTest(scene, { x: 150, y: 100 }, tolerance)).to.equal(null);
    });

    it('takes the nearer of two endpoints in range', () => {
      const crowded: HitScene = {
        ...emptyScene,
        cars: [car('c1', { x: 100, y: 100 }, { x: 106, y: 100 })],
      };
      const hit = hitTest(crowded, { x: 105, y: 100 }, tolerance);
      expect(hit).to.deep.equal({ kind: 'car-endpoint', ends: [{ id: 'c1', end: 'p1' }] });
    });
  });

  describe('couplers', () => {
    // A coupling is not stored: it is two car endpoints at exactly the same
    // pixel, which chaining and the shared handle both guarantee.
    const scene: HitScene = {
      ...emptyScene,
      cars: [
        car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
        car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }),
      ],
    };

    it('reports both ends as one coupler', () => {
      const hit = hitTest(scene, { x: 202, y: 101 }, tolerance);
      expect(hit).to.deep.equal({
        kind: 'coupler',
        ends: [
          { id: 'c1', end: 'p1' },
          { id: 'c2', end: 'p0' },
        ],
      });
    });

    it('reports every end of a three-way coincidence', () => {
      const yard: HitScene = {
        ...scene,
        cars: [...scene.cars, car('c3', { x: 200, y: 100 }, { x: 200, y: 400 })],
      };
      const hit = hitTest(yard, { x: 200, y: 100 }, tolerance);
      expect(hit).to.deep.equal({
        kind: 'coupler',
        ends: [
          { id: 'c1', end: 'p1' },
          { id: 'c2', end: 'p0' },
          { id: 'c3', end: 'p0' },
        ],
      });
    });

    it('keeps endpoints that are merely near each other separate', () => {
      // Coincidence is exact. Two cars parked a pixel apart are two cars, and
      // fusing them under a tolerance would move geometry the user never joined.
      const nearly: HitScene = {
        ...emptyScene,
        cars: [
          car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
          car('c2', { x: 201, y: 100 }, { x: 300, y: 100 }),
        ],
      };
      const hit = hitTest(nearly, { x: 200, y: 100 }, tolerance);
      expect(hit).to.deep.equal({ kind: 'car-endpoint', ends: [{ id: 'c1', end: 'p1' }] });
    });
  });

  describe('sensors and calibration points', () => {
    const scene: HitScene = {
      cars: [car('c1', { x: 100, y: 100 }, { x: 200, y: 100 })],
      sensors: [sensor('s1', 400, 400)],
      calibrationPoints: [calibrationPoint(0, 0), calibrationPoint(600, 600)],
      // No DPT: sensors then grab at the pointer radius, like everything else.
      dpt: null,
    };

    it('hits a sensor by its id', () => {
      expect(hitTest(scene, { x: 403, y: 400 }, tolerance)).to.deep.equal({
        kind: 'sensor',
        id: 's1',
      });
    });

    it('hits a calibration point by its index', () => {
      expect(hitTest(scene, { x: 600, y: 604 }, tolerance)).to.deep.equal({
        kind: 'calibration',
        index: 1,
      });
    });

    it('takes the nearest object regardless of kind', () => {
      const overlapping: HitScene = {
        cars: [car('c1', { x: 500, y: 500 }, { x: 600, y: 500 })],
        sensors: [sensor('s1', 506, 500)],
        calibrationPoints: [calibrationPoint(502, 500)],
        // No DPT: sensors then grab at the pointer radius, like everything else.
        dpt: null,
      };
      expect(hitTest(overlapping, { x: 503, y: 500 }, tolerance)).to.deep.equal({
        kind: 'calibration',
        index: 0,
      });
    });
  });

  describe('tolerance', () => {
    // A calibration point, because it is grabbed at the pointer's radius and
    // nothing else — a sensor's reach also answers to the size it is drawn at.
    const scene: HitScene = { ...emptyScene, calibrationPoints: [calibrationPoint(100, 100)] };

    it('is measured in screen pixels, so a zoomed-out view grabs a wider area', () => {
      const zoomedOut: HitTolerance = { screenPx: 5, imagePxPerScreenPx: 8 };
      // 40 image px of reach at this zoom, 10 at the default.
      expect(hitTest(scene, { x: 130, y: 100 }, zoomedOut)).to.deep.equal({
        kind: 'calibration',
        index: 0,
      });
      expect(hitTest(scene, { x: 130, y: 100 }, tolerance)).to.equal(null);
    });

    it('hits exactly on the tolerance boundary', () => {
      expect(hitTest(scene, { x: 110, y: 100 }, tolerance)).to.deep.equal({
        kind: 'calibration',
        index: 0,
      });
    });
  });

  describe('a sensor is grabbable across the symbol it is drawn as', () => {
    // A symbol visibly larger than its own hit area reads as a bug the first
    // time a click on it misses, so the reach follows what is on screen.
    const at = (dpt: number | null): HitScene => ({
      ...emptyScene,
      sensors: [sensor('s1', 100, 100)],
      dpt,
    });

    it('grabs anywhere inside a sensor wider than the pointer radius', () => {
      // DPT 120: the diamond is 120 image px across, so its half-diagonal is 60
      // — far beyond the 10 image px the pointer alone reaches here.
      const hit = hitTest(at(120), { x: 150, y: 100 }, tolerance);
      expect(hit).to.deep.equal({ kind: 'sensor', id: 's1' });
    });

    it('stops at the symbol\'s edge rather than reaching past it', () => {
      expect(hitTest(at(120), { x: 161, y: 100 }, tolerance)).to.equal(null);
    });

    it('never grabs at less than the pointer radius, however small the track', () => {
      // At DPT 4 the diamond is 4 px across; a fingertip is still a fingertip,
      // so the sensor stays as easy to hit as anything else on the image.
      const hit = hitTest(at(4), { x: 108, y: 100 }, tolerance);
      expect(hit).to.deep.equal({ kind: 'sensor', id: 's1' });
    });

    it('follows the fallback size when no DPT resolves', () => {
      // Drawn at the screen-constant size, so grabbable across that instead.
      expect(hitTest(at(null), { x: 130, y: 100 }, tolerance)).to.deep.equal({
        kind: 'sensor',
        id: 's1',
      });
    });

    it('still loses to a nearer object, so aiming at one beats being big', () => {
      const crowded: HitScene = {
        ...emptyScene,
        sensors: [sensor('s1', 100, 100)],
        calibrationPoints: [calibrationPoint(140, 100)],
        dpt: 120,
      };
      // Inside the sensor's reach, but the calibration point is nearer.
      expect(hitTest(crowded, { x: 138, y: 100 }, tolerance)).to.deep.equal({
        kind: 'calibration',
        index: 0,
      });
    });
  });

  describe('the kinds it looks for', () => {
    // The context menu asks about the point-like objects only, and reads cars
    // by area instead (#45).
    const pointLike = ['sensor', 'calibration'] as const;

    it('finds nothing of a kind it was not asked for', () => {
      const scene: HitScene = {
        ...emptyScene,
        cars: [car('c1', { x: 100, y: 100 }, { x: 200, y: 100 })],
      };
      expect(hitTest(scene, { x: 100, y: 100 }, tolerance, pointLike)).to.equal(null);
      expect(hitTest(scene, { x: 100, y: 100 }, tolerance)).to.deep.equal({
        kind: 'car-endpoint',
        ends: [{ id: 'c1', end: 'p0' }],
      });
    });

    it('narrows the search, not the answer — the excluded kind stops winning', () => {
      // The reason this is a parameter rather than a filter on the result: a
      // sensor a few pixels behind a car end loses nearest-wins, so a caller
      // that dropped the car end from the answer would find nothing where the
      // user can plainly see a sensor.
      const scene: HitScene = {
        ...emptyScene,
        cars: [car('c1', { x: 100, y: 100 }, { x: 200, y: 100 })],
        sensors: [sensor('s1', 108, 100)],
      };
      expect(hitTest(scene, { x: 100, y: 100 }, tolerance)).to.deep.equal({
        kind: 'car-endpoint',
        ends: [{ id: 'c1', end: 'p0' }],
      });
      expect(hitTest(scene, { x: 100, y: 100 }, tolerance, pointLike)).to.deep.equal({
        kind: 'sensor',
        id: 's1',
      });
    });

    it('derives no coupler when car ends are not looked for', () => {
      const scene: HitScene = {
        ...emptyScene,
        cars: [
          car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
          car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }),
        ],
      };
      expect(hitTest(scene, { x: 200, y: 100 }, tolerance, pointLike)).to.equal(null);
    });
  });
});

describe('carUnderPointer', () => {
  const dpt = 20;
  const half = carWidthPx(dpt) / 2;
  /** The tolerance's reach in image pixels — 10, and less than `half` here. */
  const reach = tolerance.screenPx * tolerance.imagePxPerScreenPx;

  function carScene(cars: CarLabel[], sceneDpt: number | null = dpt): HitScene {
    return { ...emptyScene, cars, dpt: sceneDpt };
  }

  it('finds nothing on empty image', () => {
    expect(carUnderPointer(carScene([]), { x: 10, y: 10 }, tolerance)).to.equal(null);
  });

  it('finds the car whose body the pointer is inside', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carUnderPointer(carScene([a]), { x: 200, y: 50 }, tolerance)).to.equal(a);
  });

  it('is the drawn rectangle wherever that is wider than a fingertip', () => {
    // The floor must not shrink a car to the grab radius: what is drawn is what
    // the gesture names.
    const a = car('a', { x: 100, y: 0 }, { x: 300, y: 0 });
    expect(half).to.be.greaterThan(reach);
    expect(carUnderPointer(carScene([a]), { x: 200, y: half }, tolerance)).to.equal(a);
    expect(carUnderPointer(carScene([a]), { x: 200, y: half + 1 }, tolerance)).to.equal(null);
  });

  it('finds nothing beyond a car end, however close to its axis', () => {
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    expect(carUnderPointer(carScene([a]), { x: 301, y: 50 }, tolerance)).to.equal(null);
  });

  it('measures a diagonal car across its own axis', () => {
    const a = car('a', { x: 0, y: 0 }, { x: 200, y: 200 });
    const step = (half - 0.5) / Math.SQRT2;
    expect(carUnderPointer(carScene([a]), { x: 100 + step, y: 100 - step }, tolerance)).to.equal(a);
    const past = (half + 0.5) / Math.SQRT2;
    expect(carUnderPointer(carScene([a]), { x: 100 + past, y: 100 - past }, tolerance)).to.equal(
      null
    );
  });

  it('falls back to a fat chord when no DPT resolves a width', () => {
    // The regression this floor exists to close: `renderCar` still draws the
    // chord and its handles with no DPT, because an authored car must stay
    // visible after a calibration point is deleted — so a car with no rectangle
    // would otherwise be one you can see and cannot delete.
    const a = car('a', { x: 100, y: 0 }, { x: 300, y: 0 });
    expect(carUnderPointer(carScene([a], null), { x: 200, y: reach }, tolerance)).to.equal(a);
    expect(carUnderPointer(carScene([a], null), { x: 200, y: reach + 1 }, tolerance)).to.equal(null);
  });

  it('widens with the zoom, because a fingertip is a screen size', () => {
    const a = car('a', { x: 100, y: 0 }, { x: 300, y: 0 });
    const zoomedOut: HitTolerance = { screenPx: 5, imagePxPerScreenPx: 8 };
    // 40 image px of reach, past the 20.9 the rectangle itself is.
    expect(carUnderPointer(carScene([a]), { x: 200, y: 40 }, zoomedOut)).to.equal(a);
    expect(carUnderPointer(carScene([a]), { x: 200, y: 40 }, tolerance)).to.equal(null);
  });

  it('takes the first car in scene order at the seam of a coupling', () => {
    // Coupled rectangles abut rather than overlap, so the ambiguity is one
    // zero-area line — nothing a user can aim at on purpose.
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    const b = car('b', { x: 300, y: 50 }, { x: 500, y: 50 });
    expect(carUnderPointer(carScene([a, b]), { x: 300, y: 50 }, tolerance)).to.equal(a);
    // Either side of the seam is unambiguous, which is the whole point.
    expect(carUnderPointer(carScene([a, b]), { x: 290, y: 50 }, tolerance)).to.equal(a);
    expect(carUnderPointer(carScene([a, b]), { x: 310, y: 50 }, tolerance)).to.equal(b);
  });

  it('takes the first car in scene order where two overlap', () => {
    // Permitted by the format: an archive that already contains overlapping
    // cars opens and edits unchanged.
    const a = car('a', { x: 100, y: 50 }, { x: 300, y: 50 });
    const b = car('b', { x: 200, y: 20 }, { x: 200, y: 80 });
    expect(carUnderPointer(carScene([a, b]), { x: 200, y: 50 }, tolerance)).to.equal(a);
  });

  it('reaches a car with no length, which has no rectangle at all', () => {
    // The editor refuses to author one, so it can only arrive from outside —
    // and it is drawn, so it must be nameable.
    const a = car('a', { x: 5, y: 6 }, { x: 5, y: 6 });
    expect(carUnderPointer(carScene([a]), { x: 5 + half, y: 6 }, tolerance)).to.equal(a);
    expect(carUnderPointer(carScene([a]), { x: 5 + half + 1, y: 6 }, tolerance)).to.equal(null);
  });
});

describe('sensorDiameterPx', () => {
  it('is one track width when the layout is calibrated', () => {
    expect(sensorDiameterPx(24, 2)).to.equal(trackWidthPx(24));
  });

  it('falls back to the screen-constant size with no DPT', () => {
    // An archive can carry sensors and no calibration; the symbol must not
    // vanish at a size nothing can compute.
    expect(sensorDiameterPx(null, 2)).to.equal(SYMBOL_SIZE_SCREEN_PX * 2);
    expect(sensorDiameterPx(null, 0.5)).to.equal(SYMBOL_SIZE_SCREEN_PX * 0.5);
  });

  it('ignores the zoom once a DPT exists, because the size is a world one', () => {
    expect(sensorDiameterPx(24, 8)).to.equal(sensorDiameterPx(24, 0.25));
  });
});

describe('dragHandles', () => {
  const scene: HitScene = {
    cars: [
      car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
      car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }),
    ],
    sensors: [sensor('s1', 400, 400)],
    calibrationPoints: [calibrationPoint(10, 20), calibrationPoint(600, 600)],
    // No DPT: sensors then grab at the pointer radius, like everything else.
    dpt: null,
  };

  it('gives a calibration point one handle, anchored where it is now', () => {
    expect(dragHandles({ kind: 'calibration', index: 1 }, scene)).to.deep.equal([
      { ref: { kind: 'calibration', index: 1 }, from: { x: 600, y: 600 } },
    ]);
  });

  it('gives a sensor one handle', () => {
    expect(dragHandles({ kind: 'sensor', id: 's1' }, scene)).to.deep.equal([
      { ref: { kind: 'sensor', id: 's1' }, from: { x: 400, y: 400 } },
    ]);
  });

  it('gives a free car end one handle, at the end that was grabbed', () => {
    const hit = { kind: 'car-endpoint', ends: [{ id: 'c1', end: 'p0' }] } as const;
    expect(dragHandles(hit, scene)).to.deep.equal([
      { ref: { kind: 'car-end', id: 'c1', end: 'p0' }, from: { x: 100, y: 100 } },
    ]);
  });

  it('gives a coupler one handle per end, which is how one entry covers two cars', () => {
    const hit = {
      kind: 'coupler',
      ends: [
        { id: 'c1', end: 'p1' },
        { id: 'c2', end: 'p0' },
      ],
    } as const;
    expect(dragHandles(hit, scene)).to.deep.equal([
      { ref: { kind: 'car-end', id: 'c1', end: 'p1' }, from: { x: 200, y: 100 } },
      { ref: { kind: 'car-end', id: 'c2', end: 'p0' }, from: { x: 200, y: 100 } },
    ]);
  });

  it('drops a handle the scene no longer holds', () => {
    expect(dragHandles({ kind: 'sensor', id: 'gone' }, scene)).to.deep.equal([]);
    expect(dragHandles({ kind: 'calibration', index: 9 }, scene)).to.deep.equal([]);
  });
});

describe('dragTo', () => {
  const handle = { ref: { kind: 'calibration', index: 0 }, from: { x: 100, y: 50 } } as const;

  it('applies the delta to where the handle started, so the grab offset survives', () => {
    // Measured from the press, not snapped to the pointer: grabbing a point
    // three pixels off-center must not teleport it under the cursor.
    expect(dragTo(handle, { x: 40, y: -10 })).to.deep.equal({ x: 140, y: 40 });
  });

  it('rounds, because a dragged handle names a pixel', () => {
    expect(dragTo(handle, { x: 0.4, y: 0.6 })).to.deep.equal({ x: 100, y: 51 });
  });

  it('is the identity at zero delta, so a drag home restores the exact pixel', () => {
    expect(dragTo(handle, { x: 0, y: 0 })).to.deep.equal(handle.from);
  });

  it('keeps a coupler coincident: one delta lands every end on the same pixel', () => {
    const coupler = dragHandles(
      {
        kind: 'coupler',
        ends: [
          { id: 'c1', end: 'p1' },
          { id: 'c2', end: 'p0' },
        ],
      },
      {
        cars: [
          car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
          car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }),
        ],
        sensors: [],
        calibrationPoints: [],
        dpt: null,
      }
    );
    const delta = { x: 17.5, y: -3.2 };
    const moved = coupler.map(h => dragTo(h, delta));
    expect(moved).to.have.length(2);
    // Exact equality, because that is what makes them still a coupling.
    expect(moved[0]).to.deep.equal(moved[1]);
  });
});

describe('isClick', () => {
  const slop: HitTolerance = { screenPx: 5, imagePxPerScreenPx: 1 };

  it('accepts a release on the pixel it was pressed on', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 100, y: 100 }, slop)).to.be.true;
  });

  it('accepts the tremor inside the slop, and the boundary itself', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 103, y: 96 }, slop)).to.be.true;
  });

  it('rejects a release beyond the slop — that is a drag', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 106, y: 100 }, slop)).to.be.false;
  });

  it('measures in screen pixels, so the same swipe is a drag at any zoom', () => {
    const zoomedOut: HitTolerance = { screenPx: 5, imagePxPerScreenPx: 8 };
    // 30 image px is under 4 screen px zoomed out, and 30 screen px at 1:1.
    expect(isClick({ x: 100, y: 100 }, { x: 130, y: 100 }, zoomedOut)).to.be.true;
    expect(isClick({ x: 100, y: 100 }, { x: 130, y: 100 }, slop)).to.be.false;
  });
});

describe('estimateLabelWidthPx', () => {
  it('grows with both the character count and the font size', () => {
    expect(estimateLabelWidthPx('abcd', 10)).to.equal(estimateLabelWidthPx('ab', 10) * 2);
    expect(estimateLabelWidthPx('ab', 20)).to.equal(estimateLabelWidthPx('ab', 10) * 2);
  });

  it('is zero for an empty label', () => {
    expect(estimateLabelWidthPx('', 20)).to.equal(0);
  });

  it('stays within a monospace advance of the truth', () => {
    // The estimate is deliberately not a measurement — jsdom cannot measure —
    // so what is asserted is that it lands in the plausible band for a
    // monospace face, between half and a full em per character.
    const width = estimateLabelWidthPx('0, 250, 0 mm', 16);
    expect(width).to.be.greaterThan(12 * 16 * 0.5);
    expect(width).to.be.lessThan(12 * 16 * 1.0);
  });
});

describe('placeLabel', () => {
  const frame = { width: 1920, height: 1080 };
  const fontSize = 16;
  const offset = 8;
  const text = '0, 250, 0 mm';

  it('draws up and to the right of a point comfortably inside the frame', () => {
    const placed = placeLabel({ x: 500, y: 500 }, text, fontSize, offset, frame);
    expect(placed).to.deep.equal({
      x: 508,
      y: 492,
      textAnchor: 'start',
      dominantBaseline: 'text-after-edge',
    });
  });

  it('flips to the left of a point whose label would run past the right edge', () => {
    const near = { x: frame.width - 20, y: 500 };
    const placed = placeLabel(near, text, fontSize, offset, frame);
    expect(placed.textAnchor).to.equal('end');
    expect(placed.x).to.equal(near.x - offset);
    // Still above: only the axis that overflows flips.
    expect(placed.dominantBaseline).to.equal('text-after-edge');
    expect(placed.y).to.equal(500 - offset);
  });

  it('flips below a point whose label would run past the top edge', () => {
    const placed = placeLabel({ x: 500, y: 10 }, text, fontSize, offset, frame);
    expect(placed.dominantBaseline).to.equal('text-before-edge');
    expect(placed.y).to.equal(10 + offset);
    expect(placed.textAnchor).to.equal('start');
    expect(placed.x).to.equal(508);
  });

  it('flips both axes in the top-right corner', () => {
    const placed = placeLabel({ x: frame.width - 5, y: 5 }, text, fontSize, offset, frame);
    expect(placed.textAnchor).to.equal('end');
    expect(placed.dominantBaseline).to.equal('text-before-edge');
  });

  it('leaves the left and bottom edges alone — the preferred side already fits', () => {
    const placed = placeLabel({ x: 0, y: frame.height }, text, fontSize, offset, frame);
    expect(placed.textAnchor).to.equal('start');
    expect(placed.dominantBaseline).to.equal('text-after-edge');
  });

  it('flips on the estimate, so a longer label flips further from the edge', () => {
    const at = { x: frame.width - 120, y: 500 };
    expect(placeLabel(at, 'x', fontSize, offset, frame).textAnchor).to.equal('start');
    expect(
      placeLabel(at, '-1234.5, -1234.5, -1234.5 mm', fontSize, offset, frame).textAnchor
    ).to.equal('end');
  });

  it('does not flip into an edge that fits the label even less well', () => {
    // A frame narrower than the label overflows either way; flipping there
    // would trade a clipped tail for a clipped head and lose the leading
    // digits, which are the ones that identify the point.
    const narrow = { width: 60, height: 1080 };
    const placed = placeLabel({ x: 50, y: 500 }, text, fontSize, offset, narrow);
    expect(placed.textAnchor).to.equal('start');
  });

  it('is callable for any symbol that carries a label, not just a crosshair', () => {
    // The sensor symbol (#31) sits in the same frame with the same edges and
    // reads the same rule; only its offset differs.
    const placed = placeLabel({ x: 500, y: 500 }, 'siding-3', fontSize, 20, frame);
    expect(placed.x).to.equal(520);
    expect(placed.y).to.equal(480);
  });
});

describe('clampToViewport', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 100 };

  it('leaves a box that already fits where it was asked for', () => {
    expect(clampToViewport({ x: 300, y: 200 }, size, viewport, 4)).to.deep.equal({
      x: 300,
      y: 200,
    });
  });

  it('pulls a box back off the right and bottom edges', () => {
    // 1000 - 200 - 4 and 800 - 100 - 4: fully visible, one margin clear.
    expect(clampToViewport({ x: 950, y: 780 }, size, viewport, 4)).to.deep.equal({
      x: 796,
      y: 696,
    });
  });

  it('clamps only the axis that overflows', () => {
    expect(clampToViewport({ x: 950, y: 100 }, size, viewport, 4)).to.deep.equal({
      x: 796,
      y: 100,
    });
  });

  it('keeps the margin on the near edge', () => {
    expect(clampToViewport({ x: 0, y: 0 }, size, viewport, 4)).to.deep.equal({ x: 4, y: 4 });
  });

  it('pins a box bigger than the viewport to the near edge, not off the far one', () => {
    // The head of a menu is the part worth keeping.
    const huge = { width: 2000, height: 1600 };
    expect(clampToViewport({ x: 500, y: 400 }, huge, viewport, 4)).to.deep.equal({ x: 4, y: 4 });
  });

  it('is the identity where nothing has been measured', () => {
    // jsdom: every rect is zero, and the clamp must not move the menu because
    // of it.
    expect(clampToViewport({ x: 120, y: 60 }, { width: 0, height: 0 }, viewport, 4)).to.deep.equal({
      x: 120,
      y: 60,
    });
  });
});

describe('couplerPoints', () => {
  it('finds the pixel two cars share', () => {
    const points = couplerPoints([
      car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
      car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }),
    ]);
    expect(points).to.deep.equal([{ x: 200, y: 100 }]);
  });

  it('reports a three-way coincidence once', () => {
    // One shared handle is drawn per coupling, however many ends meet there.
    const points = couplerPoints([
      car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
      car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }),
      car('c3', { x: 200, y: 100 }, { x: 200, y: 400 }),
    ]);
    expect(points).to.deep.equal([{ x: 200, y: 100 }]);
  });

  it('finds every coupling of a chained train, in scene order', () => {
    const points = couplerPoints([
      car('c1', { x: 0, y: 0 }, { x: 100, y: 0 }),
      car('c2', { x: 100, y: 0 }, { x: 200, y: 0 }),
      car('c3', { x: 200, y: 0 }, { x: 300, y: 0 }),
    ]);
    expect(points).to.deep.equal([
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ]);
  });

  it('ignores ends that are merely near each other', () => {
    // Coincidence is exact, here as in the hit-test: a proximity rule would
    // draw a shared handle over two cars the user placed separately.
    const points = couplerPoints([
      car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
      car('c2', { x: 201, y: 100 }, { x: 300, y: 100 }),
    ]);
    expect(points).to.deep.equal([]);
  });

  it('finds nothing among free cars', () => {
    expect(couplerPoints([car('c1', { x: 0, y: 0 }, { x: 100, y: 0 })])).to.deep.equal([]);
    expect(couplerPoints([])).to.deep.equal([]);
  });
});

describe('isCoincident', () => {
  const couplers = [
    { x: 100, y: 0 },
    { x: 200, y: 0 },
  ];

  it('is exact equality, on both axes', () => {
    expect(isCoincident({ x: 200, y: 0 }, couplers)).toBe(true);
    expect(isCoincident({ x: 200, y: 1 }, couplers)).toBe(false);
    expect(isCoincident({ x: 199, y: 0 }, couplers)).toBe(false);
  });

  it('finds nothing in an empty list', () => {
    expect(isCoincident({ x: 100, y: 0 }, [])).toBe(false);
  });
});

describe('samePoint', () => {
  it('is exact on both axes — the one encoding of the coincidence rule', () => {
    expect(samePoint({ x: 5, y: 6 }, { x: 5, y: 6 })).toBe(true);
    expect(samePoint({ x: 5, y: 6 }, { x: 5, y: 7 })).toBe(false);
    expect(samePoint({ x: 5, y: 6 }, { x: 6, y: 6 })).toBe(false);
  });

  it('compares values, never identity', () => {
    const at = { x: 5, y: 6 };
    expect(samePoint(at, { ...at })).toBe(true);
  });
});

describe('coupledEnds', () => {
  const couplers = [{ x: 200, y: 100 }];

  it('marks the end that sits on a coupling', () => {
    expect(coupledEnds(car('c1', { x: 100, y: 100 }, { x: 200, y: 100 }), couplers)).to.deep.equal({
      p0: false,
      p1: true,
    });
    expect(coupledEnds(car('c2', { x: 200, y: 100 }, { x: 300, y: 100 }), couplers)).to.deep.equal({
      p0: true,
      p1: false,
    });
  });

  it('marks both ends of a middle car', () => {
    const middle = car('c2', { x: 200, y: 100 }, { x: 300, y: 100 });
    expect(coupledEnds(middle, [...couplers, { x: 300, y: 100 }])).to.deep.equal({
      p0: true,
      p1: true,
    });
  });

  it('marks neither for a free car', () => {
    expect(coupledEnds(car('c1', { x: 0, y: 0 }, { x: 100, y: 0 }), couplers)).to.deep.equal({
      p0: false,
      p1: false,
    });
  });
});

describe('overlayFit', () => {
  const frame = { width: 1920, height: 1080 };

  it('is the identity while the media size is unknown', () => {
    // Before an image loads there is nothing to follow, and the overlay draws
    // in the authored frame — which is what it did before this existed.
    expect(overlayFit(null, frame)).to.deep.equal({ sx: 1, sy: 1, aspectMismatch: false });
  });

  it('is the identity for media that is exactly the authored frame', () => {
    expect(overlayFit({ width: 1920, height: 1080 }, frame)).to.deep.equal({
      sx: 1,
      sy: 1,
      aspectMismatch: false,
    });
  });

  it('scales uniformly for a re-encoded image of the same shape', () => {
    // A 4K photo of a 1080p frame is the same view at twice the pixels: every
    // authored coordinate doubles, and nothing is distorted.
    expect(overlayFit({ width: 3840, height: 2160 }, frame)).to.deep.equal({
      sx: 2,
      sy: 2,
      aspectMismatch: false,
    });
  });

  it('maps the frame onto the media by relative position when the shapes differ', () => {
    // 16:9 authored over a 4:3 photograph. No mapping is *correct* — nothing
    // records how the photo was cropped — so the defined answer is that the
    // frame covers the photograph, which is what keeps an authored point on
    // the photograph instead of out on a letterbox bar.
    const fit = overlayFit({ width: 640, height: 480 }, { width: 640, height: 360 });
    expect(fit.sx).to.equal(1);
    expect(fit.sy).to.be.closeTo(480 / 360, 1e-9);
    expect(fit.aspectMismatch).to.be.true;
  });

  it('does not call a rounding difference a mismatch', () => {
    // A resize rounds to whole pixels, and an archive is not inconsistent
    // because one dimension landed a pixel short.
    expect(overlayFit({ width: 1919, height: 1080 }, frame).aspectMismatch).to.be.false;
  });

  it('is the identity for a degenerate media size', () => {
    // `naturalWidth` is 0 until an image decodes, and a zero divisor would put
    // every object at NaN.
    expect(overlayFit({ width: 0, height: 0 }, frame)).to.deep.equal({
      sx: 1,
      sy: 1,
      aspectMismatch: false,
    });
  });
});

describe('zoom (#44)', () => {
  const frame = { width: 1000, height: 1000 };
  /** A square viewport, so the letterbox is out of the way unless asked for. */
  const viewport = { width: 800, height: 800 };

  describe('rectBetween', () => {
    it('is the same rectangle whichever corner the drag started from', () => {
      const forwards = rectBetween({ x: 10, y: 20 }, { x: 110, y: 220 });
      const backwards = rectBetween({ x: 110, y: 220 }, { x: 10, y: 20 });
      expect(forwards).to.deep.equal({ x: 10, y: 20, width: 100, height: 200 });
      expect(backwards).to.deep.equal(forwards);
    });
  });

  describe('capZoomRect', () => {
    it('leaves a rect that does not reach the cap alone', () => {
      const rect = { x: 100, y: 100, width: 400, height: 400 };
      expect(capZoomRect(rect, viewport)).to.deep.equal(rect);
    });

    it('grows a tiny rect about its centre to exactly the cap', () => {
      // 800 screen px over 14 px per frame px is 57.14 frame px across.
      const capped = capZoomRect({ x: 500, y: 500, width: 2, height: 2 }, viewport);
      const min = 800 / MAX_ZOOM_SCREEN_PX_PER_FRAME_PX;
      expect(capped.width).to.be.closeTo(min, 1e-9);
      expect(capped.height).to.be.closeTo(min, 1e-9);
      // Centred on what was drawn: the gesture named a place, and the cap
      // changes how much of it is shown, not where.
      expect(capped.x + capped.width / 2).to.be.closeTo(501, 1e-9);
      expect(capped.y + capped.height / 2).to.be.closeTo(501, 1e-9);
    });

    it('keeps the rect square with the cap, so the drawn shape survives', () => {
      const capped = capZoomRect({ x: 0, y: 0, width: 4, height: 2 }, viewport);
      expect(capped.width / capped.height).to.be.closeTo(2, 1e-9);
    });

    it('is governed by the axis that reaches its minimum first', () => {
      // A tall thin rect: the height already fills the viewport, so the zoom it
      // produces is nowhere near the cap and nothing needs growing — the meet
      // rule shows the extra width for free.
      const rect = { x: 0, y: 0, width: 2, height: 800 };
      expect(capZoomRect(rect, viewport)).to.deep.equal(rect);
    });

    it('gives a rect with no area at all the smallest rect the cap allows', () => {
      const capped = capZoomRect({ x: 100, y: 100, width: 0, height: 0 }, viewport);
      const min = 800 / MAX_ZOOM_SCREEN_PX_PER_FRAME_PX;
      expect(capped.width).to.be.closeTo(min, 1e-9);
      expect(capped.x + capped.width / 2).to.be.closeTo(100, 1e-9);
      expect(Number.isNaN(capped.width)).to.be.false;
    });

    it('caps nothing against an unmeasured viewport', () => {
      // jsdom, or a pane that has never laid out: there is no screen to be too
      // close to, and inventing one would move a rect for no reason.
      const rect = { x: 0, y: 0, width: 1, height: 1 };
      expect(capZoomRect(rect, { width: 0, height: 0 })).to.deep.equal(rect);
    });
  });

  describe('clampZoomRect', () => {
    it('leaves a rect that is already inside alone', () => {
      const rect = { x: 100, y: 100, width: 200, height: 200 };
      expect(clampZoomRect(rect, frame)).to.deep.equal(rect);
    });

    it('pushes a rect back inside the frame, keeping its size', () => {
      expect(clampZoomRect({ x: 900, y: -50, width: 200, height: 200 }, frame)).to.deep.equal({
        x: 800,
        y: 0,
        width: 200,
        height: 200,
      });
    });

    it('centres a rect larger than the frame rather than pinning it to an edge', () => {
      // The same rule clampToViewport applies to the context menu: pinned, not
      // pushed off the opposite side.
      expect(clampZoomRect({ x: 0, y: 0, width: 1200, height: 1200 }, frame)).to.deep.equal({
        x: -100,
        y: -100,
        width: 1200,
        height: 1200,
      });
    });
  });

  describe('zoomRectFromDrag', () => {
    it('is the dragged rectangle when it is neither too small nor off the frame', () => {
      expect(zoomRectFromDrag({ x: 300, y: 200 }, { x: 100, y: 600 }, frame, viewport)).to.deep.equal(
        { x: 100, y: 200, width: 200, height: 400 }
      );
    });

    it('caps an accidental few-pixel drag instead of zooming to 200x', () => {
      const rect = zoomRectFromDrag({ x: 500, y: 500 }, { x: 506, y: 506 }, frame, viewport);
      expect(rect).to.not.be.null;
      expect(rect!.width).to.be.closeTo(800 / MAX_ZOOM_SCREEN_PX_PER_FRAME_PX, 1e-9);
    });

    it('clamps a rect dragged out over the letterbox back onto the frame', () => {
      // The overlay covers the bars, so a drag legitimately reports coordinates
      // outside the image.
      const rect = zoomRectFromDrag({ x: 900, y: 900 }, { x: 1200, y: 1200 }, frame, viewport);
      expect(rect).to.deep.equal({ x: 700, y: 700, width: 300, height: 300 });
    });

    it('is null — the unzoomed view — for a rect covering the whole frame', () => {
      // Fit is the absence of a zoom, not a rect that happens to be the frame.
      expect(zoomRectFromDrag({ x: -50, y: -50 }, { x: 1050, y: 1050 }, frame, viewport)).to.be.null;
    });

    it('is null for a rect that spans the frame on one axis only', () => {
      // A wide, short drag run off both side edges — which a captured pointer
      // over the letterbox bars produces. Meet fits it by its width, which is
      // already the fit scale, and a rect *wider* than the photograph would
      // scale it below fit: less than the unzoomed view, which no drag asked
      // for.
      expect(zoomRectFromDrag({ x: -100, y: 400 }, { x: 1100, y: 500 }, frame, viewport)).to.be.null;
      expect(zoomRectFromDrag({ x: 400, y: -100 }, { x: 500, y: 1100 }, frame, viewport)).to.be.null;
    });
  });

  describe('panZoomRect', () => {
    const rect = { x: 400, y: 400, width: 200, height: 200 };

    it('moves the rect against the pointer, so the photograph follows the finger', () => {
      expect(panZoomRect(rect, { x: 50, y: -30 }, frame)).to.deep.equal({
        x: 350,
        y: 430,
        width: 200,
        height: 200,
      });
    });

    it('clamps at the frame edge rather than letting the image leave the viewport', () => {
      expect(panZoomRect(rect, { x: 1000, y: 0 }, frame).x).to.equal(0);
      expect(panZoomRect(rect, { x: -1000, y: 0 }, frame).x).to.equal(800);
    });

    it('is measured from the rect it is given, not from the last one it produced', () => {
      // Every event of one gesture applies the total travel to the rect the
      // press started on — the same rule dragTo follows, and what keeps a pan
      // from feeding the transform its own output.
      const once = panZoomRect(rect, { x: 100, y: 0 }, frame);
      expect(panZoomRect(rect, { x: 100, y: 0 }, frame)).to.deep.equal(once);
    });
  });

  describe('zoomTransform', () => {
    /** Where a point of the authored frame lands on screen, under `t`. */
    function onScreen(
      t: { scale: number; x: number; y: number },
      media: { width: number; height: number },
      view: { width: number; height: number },
      at: { x: number; y: number }
    ) {
      // The unzoomed mapping first — meet, exactly as the media letterboxes —
      // then the transform above it.
      const fit = Math.min(view.width / media.width, view.height / media.height);
      const boxX = (view.width - media.width * fit) / 2;
      const boxY = (view.height - media.height * fit) / 2;
      return {
        x: t.scale * (boxX + (at.x / frame.width) * media.width * fit) + t.x,
        y: t.scale * (boxY + (at.y / frame.height) * media.height * fit) + t.y,
      };
    }

    it('is the identity when there is no zoom', () => {
      expect(zoomTransform(null, frame, frame, viewport)).to.deep.equal({ scale: 1, x: 0, y: 0 });
    });

    it('is the identity against an unmeasured viewport', () => {
      // jsdom lays nothing out, and a transform derived from a zero box would
      // put the photograph at NaN.
      const rect = { x: 0, y: 0, width: 100, height: 100 };
      expect(zoomTransform(rect, frame, frame, { width: 0, height: 0 })).to.deep.equal({
        scale: 1,
        x: 0,
        y: 0,
      });
    });

    it('puts the rect exactly in the viewport when the two are the same shape', () => {
      const rect = { x: 0, y: 0, width: 500, height: 500 };
      const t = zoomTransform(rect, frame, frame, viewport);
      expect(t.scale).to.be.closeTo(2, 1e-9);
      const topLeft = onScreen(t, frame, viewport, { x: 0, y: 0 });
      const bottomRight = onScreen(t, frame, viewport, { x: 500, y: 500 });
      expect(topLeft.x).to.be.closeTo(0, 1e-9);
      expect(topLeft.y).to.be.closeTo(0, 1e-9);
      expect(bottomRight.x).to.be.closeTo(800, 1e-9);
      expect(bottomRight.y).to.be.closeTo(800, 1e-9);
    });

    it('shows more than the rect on the axis whose aspect differs, never less', () => {
      // The meet rule everything else here uses. A square rect in a 2:1
      // viewport is fitted by its height, and the extra width is shown.
      const view = { width: 800, height: 400 };
      const rect = { x: 0, y: 0, width: 500, height: 500 };
      const t = zoomTransform(rect, frame, frame, view);
      const topLeft = onScreen(t, frame, view, { x: 0, y: 0 });
      const bottomRight = onScreen(t, frame, view, { x: 500, y: 500 });
      // Vertically exact, horizontally centred with room to spare on both
      // sides — the rect is inside the viewport, and then some.
      expect(topLeft.y).to.be.closeTo(0, 1e-9);
      expect(bottomRight.y).to.be.closeTo(400, 1e-9);
      expect(topLeft.x).to.be.greaterThan(0);
      expect(bottomRight.x).to.be.lessThan(800);
      expect(bottomRight.x - topLeft.x).to.be.closeTo(400, 1e-9);
    });

    it('measures the letterbox from the media, not from the authored frame', () => {
      // The media is what object-fit letterboxes, so where the photograph sits
      // in the viewport follows its shape. A 2:1 photo of a square frame is the
      // inconsistent archive overlayFit stretches over — the zoom must land on
      // the photograph either way.
      const media = { width: 1000, height: 500 };
      const view = { width: 800, height: 800 };
      const rect = { x: 0, y: 0, width: 500, height: 500 };
      const t = zoomTransform(rect, media, frame, view);
      const topLeft = onScreen(t, media, view, { x: 0, y: 0 });
      const bottomRight = onScreen(t, media, view, { x: 500, y: 500 });
      expect(topLeft.x).to.be.closeTo(0, 1e-9);
      expect(bottomRight.x).to.be.closeTo(800, 1e-9);
      // The half-height photograph fills half the viewport's height, centred.
      expect(topLeft.y).to.be.closeTo(200, 1e-9);
      expect(bottomRight.y).to.be.closeTo(600, 1e-9);
    });

    it('centres the region wherever on the frame it was drawn', () => {
      const rect = { x: 600, y: 600, width: 200, height: 200 };
      const t = zoomTransform(rect, frame, frame, viewport);
      const centre = onScreen(t, frame, viewport, { x: 700, y: 700 });
      expect(centre.x).to.be.closeTo(400, 1e-9);
      expect(centre.y).to.be.closeTo(400, 1e-9);
    });
  });

  describe('boundsOfPoints', () => {
    it('is null for nothing to bound', () => {
      expect(boundsOfPoints([])).to.be.null;
    });

    it('is a place, not an area, for one point', () => {
      expect(boundsOfPoints([{ x: 5, y: 7 }])).to.deep.equal({ x: 5, y: 7, width: 0, height: 0 });
    });

    it('covers every point', () => {
      expect(
        boundsOfPoints([
          { x: 10, y: 40 },
          { x: 30, y: 20 },
          { x: -5, y: 25 },
        ])
      ).to.deep.equal({ x: -5, y: 20, width: 35, height: 20 });
    });
  });

  describe('revealZoom', () => {
    const zoom: Rect = { x: 400, y: 400, width: 200, height: 200 };

    it('leaves an unzoomed view unzoomed', () => {
      expect(revealZoom(null, { x: 0, y: 0, width: 10, height: 10 }, frame)).to.be.null;
    });

    it('leaves the zoom alone when the entry changed nothing to point at', () => {
      // A completeness toggle or a rename: the history says so by carrying no
      // highlights, and moving the user for it would be a move with no reason.
      expect(revealZoom(zoom, null, frame)).to.deep.equal(zoom);
    });

    it('leaves the zoom alone when what changed is already on screen', () => {
      expect(revealZoom(zoom, { x: 450, y: 450, width: 20, height: 20 }, frame)).to.deep.equal(zoom);
    });

    it('pans at the same zoom level when what changed fits', () => {
      const moved = revealZoom(zoom, { x: 100, y: 100, width: 40, height: 40 }, frame);
      expect(moved).to.deep.equal({ x: 20, y: 20, width: 200, height: 200 });
    });

    it('clamps the pan to the frame, as any other pan is clamped', () => {
      const moved = revealZoom(zoom, { x: 980, y: 10, width: 10, height: 10 }, frame);
      expect(moved).to.deep.equal({ x: 800, y: 0, width: 200, height: 200 });
    });

    it('falls back to the unzoomed view when what changed does not fit', () => {
      // A twelve-car consist undone at once: there is no pan that shows it, so
      // the honest answer is the view that shows everything.
      expect(revealZoom(zoom, { x: 0, y: 0, width: 900, height: 20 }, frame)).to.be.null;
    });
  });
});

/**
 * Centerlines, patch outlines and the two sensor marks (#275).
 *
 * The arithmetic only. Where the points come from is `centerlineSnap.ts`'s, and
 * storing them waits on rails49/r49#52 — which is why these tests build
 * centerlines by hand rather than reading one out of a manifest.
 */

/** DPT 20: a gauge is 20 px, a car 41.8 px wide, a patch 60 × 100 px. */
const CL_DPT = 20;

function centerline(id: string, points: readonly { x: number; y: number }[]): Centerline {
  return { id, points };
}

describe('nearestCenterline', () => {
  const line = centerline('a', [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 300, y: 200 },
  ]);

  it('has no answer with no centerlines', () => {
    expect(nearestCenterline({ x: 0, y: 0 }, [])).to.be.null;
  });

  it('measures to the polyline, not to its points', () => {
    // Midway along the first segment, 10 px off it. The nearer *point* is 50 px
    // away; a sensor there is on the track, and must not read as 50 px off it.
    const hit = nearestCenterline({ x: 150, y: 110 }, [line]);
    expect(hit?.distancePx).to.be.closeTo(10, 1e-9);
    expect(hit?.at).to.deep.equal({ x: 150, y: 100 });
  });

  it('reports the direction of the segment the closest point fell on', () => {
    expect(nearestCenterline({ x: 150, y: 110 }, [line])?.direction).to.deep.equal({ x: 1, y: 0 });
    const onSecond = nearestCenterline({ x: 260, y: 150 }, [line])?.direction;
    expect(onSecond?.x).to.be.closeTo(Math.SQRT1_2, 1e-9);
    expect(onSecond?.y).to.be.closeTo(Math.SQRT1_2, 1e-9);
  });

  it('clamps to the ends rather than running off down the segment line', () => {
    const hit = nearestCenterline({ x: 50, y: 100 }, [line]);
    expect(hit?.at).to.deep.equal({ x: 100, y: 100 });
    expect(hit?.distancePx).to.be.closeTo(50, 1e-9);
  });

  it('picks the nearest of several', () => {
    const far = centerline('b', [
      { x: 100, y: 400 },
      { x: 300, y: 400 },
    ]);
    expect(nearestCenterline({ x: 150, y: 110 }, [far, line])?.id).to.equal('a');
    expect(nearestCenterline({ x: 150, y: 380 }, [far, line])?.id).to.equal('b');
  });

  it('answers a one-point run with no direction, so no patch can be turned to it', () => {
    const stub = centerline('c', [{ x: 10, y: 10 }]);
    const hit = nearestCenterline({ x: 13, y: 14 }, [stub]);
    expect(hit?.distancePx).to.be.closeTo(5, 1e-9);
    expect(hit?.direction).to.deep.equal({ x: 0, y: 0 });
    expect(patchCorners(hit!.at, hit!.direction, CL_DPT)).to.be.null;
  });

  it('ignores a centerline with no points at all', () => {
    expect(nearestCenterline({ x: 0, y: 0 }, [centerline('empty', [])])).to.be.null;
  });
});

describe('patchCorners', () => {
  it('is PATCH_ALONG_G by PATCH_ACROSS_G gauges, centred on the sensor', () => {
    const corners = patchCorners({ x: 500, y: 300 }, { x: 1, y: 0 }, CL_DPT);
    expect(corners).to.deep.equal([
      { x: 500 - 50, y: 300 - 30 },
      { x: 500 + 50, y: 300 - 30 },
      { x: 500 + 50, y: 300 + 30 },
      { x: 500 - 50, y: 300 + 30 },
    ]);
    expect(PATCH_ALONG_G * CL_DPT).to.equal(100);
    expect(PATCH_ACROSS_G * CL_DPT).to.equal(60);
  });

  it('turns to the direction given and leaves the sensor where it is', () => {
    const at = { x: 500, y: 300 };
    const corners = patchCorners(at, { x: 0, y: 2 }, CL_DPT)!;
    // The same rectangle a quarter turn on: long axis now vertical.
    expect(corners[0]).to.deep.equal({ x: 500 + 30, y: 300 - 50 });
    expect(corners[2]).to.deep.equal({ x: 500 - 30, y: 300 + 50 });
    // Centroid is still the sensor: nothing moved onto the line.
    const cx = corners.reduce((sum, c) => sum + c.x, 0) / 4;
    const cy = corners.reduce((sum, c) => sum + c.y, 0) / 4;
    expect(cx).to.be.closeTo(at.x, 1e-9);
    expect(cy).to.be.closeTo(at.y, 1e-9);
  });

  it('draws nothing for a direction with no length', () => {
    expect(patchCorners({ x: 1, y: 1 }, { x: 0, y: 0 }, CL_DPT)).to.be.null;
  });

  it('winds the same way carCorners does, so a patch and a car cannot disagree', () => {
    const patch = patchCorners({ x: 0, y: 0 }, { x: 1, y: 0 }, CL_DPT)!;
    const car = carCorners({ x: -50, y: 0 }, { x: 50, y: 0 }, CL_DPT);
    // Both start on the p0 side and both put their first corner on the same
    // side of the chord.
    expect(Math.sign(patch[0].y)).to.equal(Math.sign(car[0].y));
  });
});

describe('secondCenterlineReachPx', () => {
  it('is half the patch width plus half a car width', () => {
    expect(secondCenterlineReachPx(CL_DPT)).to.be.closeTo(
      (PATCH_ACROSS_G * CL_DPT) / 2 + carWidthPx(CL_DPT) / 2,
      1e-9
    );
  });

  it('is 2.545 gauges with the placeholder patch, not the brief’s 2.7', () => {
    // 3 G across and a 2.09 G car. The number is derived rather than written
    // down, so it follows PATCH_ACROSS_G when rails49/classifier#4 sets it.
    expect(secondCenterlineReachPx(CL_DPT) / CL_DPT).to.be.closeTo(2.545, 0.002);
  });
});

describe('sensorTrack', () => {
  const upper = centerline('upper', [
    { x: 0, y: 100 },
    { x: 600, y: 100 },
  ]);

  it('marks no track with no centerlines at all', () => {
    const track = sensorTrack({ x: 10, y: 10 }, [], CL_DPT);
    expect(track.nearest).to.be.null;
    expect(track.noTrack).to.be.true;
    expect(track.secondCenterline).to.be.false;
  });

  it('marks no track past half a gauge, and not at half a gauge', () => {
    expect(NO_TRACK_G).to.equal(0.5);
    const edge = NO_TRACK_G * CL_DPT;
    expect(sensorTrack({ x: 300, y: 100 + edge }, [upper], CL_DPT).noTrack).to.be.false;
    expect(sensorTrack({ x: 300, y: 100 + edge + 0.01 }, [upper], CL_DPT).noTrack).to.be.true;
  });

  it('still names what it measured against when it marks no track', () => {
    const track = sensorTrack({ x: 300, y: 400 }, [upper], CL_DPT);
    expect(track.noTrack).to.be.true;
    expect(track.nearest?.id).to.equal('upper');
  });

  it('warns when a second centerline comes within the reach, and not beyond it', () => {
    const reach = secondCenterlineReachPx(CL_DPT);
    const at = { x: 300, y: 100 };
    const inside = centerline('lower', [
      { x: 0, y: 100 + reach },
      { x: 600, y: 100 + reach },
    ]);
    const outside = centerline('lower', [
      { x: 0, y: 100 + reach + 0.01 },
      { x: 600, y: 100 + reach + 0.01 },
    ]);
    expect(sensorTrack(at, [upper, inside], CL_DPT).secondCenterline).to.be.true;
    expect(sensorTrack(at, [upper, outside], CL_DPT).secondCenterline).to.be.false;
  });

  it('measures the reach as a radius, which under-warns along the patch', () => {
    // The gap is a decision, not an oversight. A centerline crossing the
    // patch's long axis 3 G out is past the radius, so no warning — yet a car
    // on it is 2.09 G wide and still reaches inside the 2.5 G-long patch. #275
    // decided the rule as a radius, and widening it to the rectangle would
    // change which sensors get flagged.
    const reach = secondCenterlineReachPx(CL_DPT);
    const beyond = 3 * CL_DPT;
    expect(beyond).to.be.greaterThan(reach);
    // A car centred on that crossing line still reaches inside the patch.
    expect(beyond - carWidthPx(CL_DPT) / 2).to.be.lessThan((PATCH_ALONG_G * CL_DPT) / 2);
    const crossing = centerline('crossing', [
      { x: 300 + beyond, y: 0 },
      { x: 300 + beyond, y: 400 },
    ]);
    expect(sensorTrack({ x: 300, y: 100 }, [upper, crossing], CL_DPT).secondCenterline).to.be.false;
  });

  it('does not warn about the centerline the sensor is on', () => {
    // One centerline is never its own second one, however close the sensor sits.
    expect(sensorTrack({ x: 300, y: 100 }, [upper], CL_DPT).secondCenterline).to.be.false;
  });

  it('warns on the nearer of two parallel tracks a gauge and a half apart', () => {
    // Parallel sidings at 1.5 G: both sensors are on a track and both patches
    // can see the other one.
    const lower = centerline('lower', [
      { x: 0, y: 130 },
      { x: 600, y: 130 },
    ]);
    expect(sensorTrack({ x: 300, y: 100 }, [upper, lower], CL_DPT)).to.include({
      noTrack: false,
      secondCenterline: true,
    });
    expect(sensorTrack({ x: 300, y: 130 }, [upper, lower], CL_DPT)).to.include({
      noTrack: false,
      secondCenterline: true,
    });
  });
});

describe('inCarArea', () => {
  const labeled = car('c0', { x: 100, y: 200 }, { x: 300, y: 200 });

  it('covers the span one car width across, boundary inside', () => {
    const half = carWidthPx(CL_DPT) / 2;
    expect(inCarArea(labeled, { x: 200, y: 200 + half }, CL_DPT)).to.be.true;
    expect(inCarArea(labeled, { x: 200, y: 200 + half + 0.01 }, CL_DPT)).to.be.false;
  });

  it('reaches CAR_AREA_MARGIN_G past each end', () => {
    expect(CAR_AREA_MARGIN_G).to.equal(0.5);
    const margin = CAR_AREA_MARGIN_G * CL_DPT;
    expect(inCarArea(labeled, { x: 100 - margin, y: 200 }, CL_DPT)).to.be.true;
    expect(inCarArea(labeled, { x: 100 - margin - 0.01, y: 200 }, CL_DPT)).to.be.false;
    expect(inCarArea(labeled, { x: 300 + margin, y: 200 }, CL_DPT)).to.be.true;
    expect(inCarArea(labeled, { x: 300 + margin + 0.01, y: 200 }, CL_DPT)).to.be.false;
  });

  it('measures a diagonal car across its own axis', () => {
    const diagonal = car('c1', { x: 0, y: 0 }, { x: 200, y: 200 });
    const half = carWidthPx(CL_DPT) / 2;
    // Across the axis at the midpoint: inside at the half width, outside past it.
    const nx = Math.SQRT1_2;
    expect(inCarArea(diagonal, { x: 100 + nx * half * 0.99, y: 100 - nx * half * 0.99 }, CL_DPT)).to
      .be.true;
    expect(inCarArea(diagonal, { x: 100 + nx * half * 1.2, y: 100 - nx * half * 1.2 }, CL_DPT)).to.be
      .false;
  });

  it('falls back to a radius for a car with no axis', () => {
    const point = car('c2', { x: 50, y: 50 }, { x: 50, y: 50 });
    const half = carWidthPx(CL_DPT) / 2;
    expect(inCarArea(point, { x: 50 + half * 0.99, y: 50 }, CL_DPT)).to.be.true;
    expect(inCarArea(point, { x: 50 + half * 1.01, y: 50 }, CL_DPT)).to.be.false;
  });
});
