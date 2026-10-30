import { describe, expect, it } from 'vitest';
import type { Sensor } from '@rails49/r49';
import { carWidthPx } from '@rails49/detector';
import type { Detection } from '@rails49/detector';
import { MARGIN_G, covers, occupancy } from '../src/occupancy.js';

/**
 * L1. The contract SPEC § Occupancy Output writes once, pinned in the one place
 * that implements it — which is the reason the function is total: were it not,
 * the live view and the diagnostics view would each build unknown-maps of their
 * own and these assertions would only cover one of them.
 */

const FRAME = { width: 1920, height: 1080 };

/** DPT 20: a car is ~41.8 px wide, so a centreline sensor sits ~21 px inside. */
const DPT = 20;

/** 1 G is `dpt` pixels, so ADR 0023's 2 G margin is 40 px at each end here. */
const MARGIN_PX = MARGIN_G * DPT;

/**
 * For the `covers` cases that are about the oriented box alone. The margin is
 * a separate argument precisely so the box geometry can still be asserted
 * without it.
 */
const NO_MARGIN = 0;

function detection(fields: Partial<Detection>): Detection {
  return {
    centre: { x: 960, y: 540 },
    length: 300,
    width: 42,
    angle: 0,
    class: 'stock',
    confidence: 0.9,
    ...fields,
  };
}

function sensor(id: string, x: number, y: number): Sensor {
  return { id, x, y };
}

describe('the vocabulary', () => {
  const sensors = [sensor('a', 960, 540), sensor('b', 100, 100)];

  it('answers every sensor, always', () => {
    const states = occupancy({ detections: [detection({})], sensors, dpt: DPT, frame: FRAME });
    expect([...states.keys()]).toEqual(['a', 'b']);
  });

  it('reports occupied when a box covers the point, and says which box', () => {
    const car = detection({});
    const states = occupancy({ detections: [car], sensors, dpt: DPT, frame: FRAME });

    expect(states.get('a')).toEqual({ state: 'occupied', detection: car });
  });

  it('reports clear when nothing covers it, with no confidence attached', () => {
    // `clear` is the absence of evidence and nothing scored it — 0.0 would read
    // as "definitely not occupied" and 1.0 as "definitely clear", and both claim
    // a measurement that was never made.
    const states = occupancy({ detections: [detection({})], sensors, dpt: DPT, frame: FRAME });
    expect(states.get('b')).toEqual({ state: 'clear' });
  });

  it('reports clear for a frame with no detections at all', () => {
    const states = occupancy({ detections: [], sensors, dpt: DPT, frame: FRAME });
    expect(states.get('a')).toEqual({ state: 'clear' });
  });
});

describe('unknown', () => {
  const sensors = [sensor('a', 960, 540)];

  it('is not a confidence outcome — a low-confidence box still occupies', () => {
    // Every case where the model did look and saw something resolves to
    // occupied. The threshold was applied during decoding; there is no unsure
    // band below it.
    const faint = detection({ confidence: 0.26 });
    const states = occupancy({ detections: [faint], sensors, dpt: DPT, frame: FRAME });
    expect(states.get('a')).toEqual({ state: 'occupied', detection: faint });
  });

  it('says no-model when no detector is loaded', () => {
    // Distinct from an empty detection list: "I was unable to look", not "I
    // looked and saw nothing".
    const states = occupancy({ detections: null, sensors, dpt: DPT, frame: FRAME });
    expect(states.get('a')).toEqual({ state: 'unknown', reason: 'no-model' });
  });

  it('says no-calibration when DPT is unresolved', () => {
    // Without DPT there is no width constant, so there is no box to test.
    const states = occupancy({ detections: [detection({})], sensors, dpt: null, frame: FRAME });
    expect(states.get('a')).toEqual({ state: 'unknown', reason: 'no-calibration' });
  });

  it('says outside-frame for a sensor the camera cannot see', () => {
    const offscreen = [sensor('left', -1, 540), sensor('below', 960, 1081)];
    const states = occupancy({
      detections: [detection({})],
      sensors: offscreen,
      dpt: DPT,
      frame: FRAME,
    });

    expect(states.get('left')).toEqual({ state: 'unknown', reason: 'outside-frame' });
    expect(states.get('below')).toEqual({ state: 'unknown', reason: 'outside-frame' });
  });

  it('prefers the whole-system cause over the per-sensor one', () => {
    // A sensor off the edge of a layout with no model is unanswerable twice
    // over; no-model is the one that tells a human what to fix.
    const states = occupancy({
      detections: null,
      sensors: [sensor('left', -1, 540)],
      dpt: null,
      frame: FRAME,
    });
    expect(states.get('left')).toEqual({ state: 'unknown', reason: 'no-model' });
  });

  it('says drift when the camera has moved, model and calibration or not', () => {
    // The refusal (#94): drift outranks every other reason because the others
    // say a measurement could not be made and this one says a measurement could,
    // and would be wrong. Build the model and calibrate the layout and a drifted
    // camera is still drifted.
    const sensors = [sensor('a', 960, 540)];
    expect(
      occupancy({ detections: [detection({})], sensors, dpt: DPT, frame: FRAME, drifted: true }).get('a'),
    ).toEqual({ state: 'unknown', reason: 'drift' });
    expect(
      occupancy({ detections: null, sensors, dpt: null, frame: FRAME, drifted: true }).get('a'),
    ).toEqual({ state: 'unknown', reason: 'drift' });
  });

  it('treats a caller that passes no drift flag as not asserting anything', () => {
    // Every caller before #94 omitted it, and none of them was claiming the
    // camera was steady — so the default cannot be a refusal.
    const sensors = [sensor('a', 960, 540)];
    const withoutFlag = occupancy({ detections: [detection({})], sensors, dpt: DPT, frame: FRAME });
    const withFalse = occupancy({
      detections: [detection({})],
      sensors,
      dpt: DPT,
      frame: FRAME,
      drifted: false,
    });
    expect(withoutFlag.get('a')).toEqual(withFalse.get('a'));
    expect(withoutFlag.get('a')).toMatchObject({ state: 'occupied' });
  });
});

describe('width normalization', () => {
  const sensors = [sensor('a', 960, 555)];

  it('widens an under-predicted box rather than trusting it', () => {
    // 15 px off the centreline. The DPT-derived half-width is ~20.9 px, so the
    // sensor is covered — but a model that predicted 25 px total width would
    // put its own boundary at 12.5 px and call this clear. Width is a fit to a
    // constant, so its deviation is pure error, and this is the safe direction.
    const underPredicted = detection({ width: 25 });
    const states = occupancy({
      detections: [underPredicted],
      sensors,
      dpt: DPT,
      frame: FRAME,
    });

    expect(states.get('a')).toEqual({ state: 'occupied', detection: underPredicted });
  });

  it('hands back the raw detection, not the normalized box', () => {
    // L0 stays raw: normalization belongs to L1's geometry, not to what the
    // detector reported.
    const states = occupancy({
      detections: [detection({ width: 25 })],
      sensors,
      dpt: DPT,
      frame: FRAME,
    });

    const state = states.get('a');
    expect(state?.state).toBe('occupied');
    expect(state?.state === 'occupied' && state.detection.width).toBe(25);
  });

  it('narrows an over-predicted box too — the constant replaces, not widens', () => {
    // Substitution, not a maximum. A box the model called 200 px wide is a bad
    // box, and honouring it would make one detection occupy sensors on the next
    // track over.
    const overPredicted = detection({ width: 200 });
    const states = occupancy({
      detections: [overPredicted],
      sensors: [sensor('far', 960, 620)],
      dpt: DPT,
      frame: FRAME,
    });

    expect(states.get('far')).toEqual({ state: 'clear' });
  });
});

describe('overlapping boxes', () => {
  it('reports the highest-confidence one, per SPEC', () => {
    const faint = detection({ confidence: 0.3 });
    const strong = detection({ confidence: 0.8 });
    const states = occupancy({
      detections: [faint, strong],
      sensors: [sensor('a', 960, 540)],
      dpt: DPT,
      frame: FRAME,
    });

    expect(states.get('a')).toEqual({ state: 'occupied', detection: strong });
  });
});

describe('couplers', () => {
  it('leave no gap between abutting cars', () => {
    // Two cars sharing an endpoint at x = 1110, so a sensor between coupled
    // cars reads occupied and couplings need never be labeled or detected.
    // That held on strict containment alone — the shared point itself is in
    // neither box, but every point either side of it is in one — and the 2 G
    // margin only makes it more so: now each car reaches 2 G into the other,
    // so the coupler sits inside *both* boxes and which one answers is the
    // highest-confidence rule's business rather than which side of 1110 the
    // sensor fell on.
    const left = detection({ centre: { x: 960, y: 540 }, length: 300, confidence: 0.8 });
    const right = detection({ centre: { x: 1260, y: 540 }, length: 300, confidence: 0.9 });
    const sensors = [sensor('just-left', 1109.9, 540), sensor('just-right', 1110.1, 540)];

    const states = occupancy({ detections: [left, right], sensors, dpt: DPT, frame: FRAME });
    expect(states.get('just-left')).toEqual({ state: 'occupied', detection: right });
    expect(states.get('just-right')).toEqual({ state: 'occupied', detection: right });
  });

  it('leaves a gap wider than two margins reading clear', () => {
    // 950 to 1050: a 5 G gap at DPT 20, so its middle is 2.5 G from either
    // car and past both margins. This is the sentence ADR 0023 rewrote —
    // before the margin *any* real gap read clear, and now only one wider than
    // 4 G does.
    const left = detection({ centre: { x: 800, y: 540 }, length: 300 });
    const right = detection({ centre: { x: 1200, y: 540 }, length: 300 });
    const states = occupancy({
      detections: [left, right],
      sensors: [sensor('gap', 1000, 540)],
      dpt: DPT,
      frame: FRAME,
    });

    expect(states.get('gap')).toEqual({ state: 'clear' });
  });
});

describe('the two-gauge margin', () => {
  // ADR 0023. A car 200 px long on the x axis at DPT 20: its own ends are at
  // 860 and 1060, and the box tested reaches 2 G — 40 px — past each of them.
  const car = detection({ centre: { x: 960, y: 540 }, length: 200, angle: 0 });
  const LEFT_END = 860;
  const RIGHT_END = 1060;

  function readingAt(x: number, y: number, detections = [car]): string | undefined {
    const states = occupancy({
      detections,
      sensors: [sensor('s', x, y)],
      dpt: DPT,
      frame: FRAME,
    });
    return states.get('s')?.state;
  }

  it('reads occupied 1.9 G past an end and clear at 2.1 G, at both ends', () => {
    // The margin is along the track and symmetric: a car has no front, and the
    // reason for it — a miss costs a collision — is the same at either end.
    expect(readingAt(RIGHT_END + 1.9 * DPT, 540)).toBe('occupied');
    expect(readingAt(RIGHT_END + 2.1 * DPT, 540)).toBe('clear');
    expect(readingAt(LEFT_END - 1.9 * DPT, 540)).toBe('occupied');
    expect(readingAt(LEFT_END - 2.1 * DPT, 540)).toBe('clear');
  });

  it('stays strict at the lengthened boundary, as the box itself is', () => {
    // The margin moves the boundary; it does not soften it. Nothing here is a
    // tolerance epsilon — 2 G is a stated distance with a reason behind it.
    expect(readingAt(RIGHT_END + MARGIN_PX, 540)).toBe('clear');
    expect(readingAt(RIGHT_END + MARGIN_PX - 0.1, 540)).toBe('occupied');
  });

  it('scales with DPT rather than being a pixel count', () => {
    // 2 G is a distance on the layout, so the same margin is 80 px at DPT 40.
    const farther = occupancy({
      detections: [car],
      sensors: [sensor('s', RIGHT_END + 70, 540)],
      dpt: 40,
      frame: FRAME,
    });
    expect(farther.get('s')?.state).toBe('occupied');
  });

  it('leaves lateral behaviour alone — the box lengthens, it does not swell', () => {
    // Across the axis the half-width is still `carWidthPx(dpt)/2`, both beside
    // the car and out in the lengthened stretch. A margin that widened the box
    // would occupy sensors on the next track over, which is the error ADR 0005
    // substitutes the constant to avoid overshooting.
    const half = carWidthPx(DPT) / 2;
    expect(readingAt(960, 540 + half - 0.1)).toBe('occupied');
    expect(readingAt(960, 540 + half + 0.1)).toBe('clear');
    expect(readingAt(RIGHT_END + DPT, 540 + half + 0.1)).toBe('clear');
  });

  it('closes a 3 G gap between uncoupled cars', () => {
    // 4 G of margin meets across a 3 G gap, so every point in it is occupied —
    // not only its middle. A car that close to a sensor counts.
    // 950 to 1010 at DPT 20: the left car's margin reaches 990 and the right
    // car's reaches back to 970, so the two overlap and nothing in the gap is
    // clear.
    const left = detection({ centre: { x: 800, y: 540 }, length: 300 });
    const right = detection({ centre: { x: 1160, y: 540 }, length: 300 });
    const gap = [left, right];
    expect(readingAt(955, 540, gap)).toBe('occupied');
    expect(readingAt(980, 540, gap)).toBe('occupied');
    expect(readingAt(1005, 540, gap)).toBe('occupied');
  });

  it('hands back the raw detection out in the margin, not the lengthened box', () => {
    // L0 stays raw. The margin belongs to L1's geometry, exactly as the width
    // substitution does.
    const states = occupancy({
      detections: [car],
      sensors: [sensor('s', RIGHT_END + 1.9 * DPT, 540)],
      dpt: DPT,
      frame: FRAME,
    });
    const state = states.get('s');
    expect(state).toEqual({ state: 'occupied', detection: car });
    expect(state?.state === 'occupied' && state.detection.length).toBe(200);
  });

  it('still prefers the highest-confidence box when two margins overlap', () => {
    // Precedence is unchanged: a detection reaching a sensor only through its
    // margin is a covering detection like any other.
    const faint = detection({ centre: { x: 860, y: 540 }, length: 200, confidence: 0.3 });
    const strong = detection({ centre: { x: 1060, y: 540 }, length: 200, confidence: 0.8 });
    const states = occupancy({
      detections: [faint, strong],
      sensors: [sensor('s', 960, 540)],
      dpt: DPT,
      frame: FRAME,
    });
    expect(states.get('s')).toEqual({ state: 'occupied', detection: strong });
  });
});

describe('the occupancy test', () => {
  const car = detection({ centre: { x: 500, y: 250 }, length: 200, width: 42, angle: 0 });

  it('contains a point inside the box', () => {
    expect(covers(car, 42, NO_MARGIN, { x: 500, y: 250 })).toBe(true);
    expect(covers(car, 42, NO_MARGIN, { x: 599, y: 270 })).toBe(true);
  });

  it('excludes a point past either half-extent', () => {
    expect(covers(car, 42, NO_MARGIN, { x: 601, y: 250 })).toBe(false);
    expect(covers(car, 42, NO_MARGIN, { x: 500, y: 272 })).toBe(false);
  });

  it('is strict: a point exactly on the boundary is not contained', () => {
    // No tolerance epsilon, per SPEC. At a coupler two boxes abut on a shared
    // endpoint, so a point between coupled cars is already strictly inside one
    // of them, and a real gap between uncoupled cars must read clear.
    expect(covers(car, 42, NO_MARGIN, { x: 600, y: 250 })).toBe(false);
    expect(covers(car, 42, NO_MARGIN, { x: 500, y: 271 })).toBe(false);
  });

  it("uses the width it is handed, not the detection's own", () => {
    // The whole point of the normalization: an under-predicted width must not
    // shrink the box L1 tests against.
    const narrow = detection({ centre: { x: 500, y: 250 }, length: 200, width: 10, angle: 0 });
    expect(covers(narrow, 10, NO_MARGIN, { x: 500, y: 265 })).toBe(false);
    expect(covers(narrow, 42, NO_MARGIN, { x: 500, y: 265 })).toBe(true);
  });

  it('rotates with the box', () => {
    const diagonal = detection({
      centre: { x: 0, y: 0 },
      length: 200,
      width: 20,
      angle: Math.PI / 4,
    });

    // 50 px along the long axis is inside; 50 px across it is not.
    const along = { x: 50 / Math.SQRT2, y: 50 / Math.SQRT2 };
    const across = { x: -50 / Math.SQRT2, y: 50 / Math.SQRT2 };
    expect(covers(diagonal, 20, NO_MARGIN, along)).toBe(true);
    expect(covers(diagonal, 20, NO_MARGIN, across)).toBe(false);
  });

  it('adds the margin to the half-length at both ends', () => {
    expect(covers(car, 42, 40, { x: 639, y: 250 })).toBe(true);
    expect(covers(car, 42, 40, { x: 641, y: 250 })).toBe(false);
    expect(covers(car, 42, 40, { x: 361, y: 250 })).toBe(true);
    expect(covers(car, 42, 40, { x: 359, y: 250 })).toBe(false);
  });

  it("lengthens along the box's own axis, not the frame's", () => {
    const diagonal = detection({
      centre: { x: 0, y: 0 },
      length: 200,
      width: 20,
      angle: Math.PI / 4,
    });

    // 139 px out: inside along the long axis once 40 px of margin joins the
    // 100 px half-length, and still outside across it.
    const along = { x: 139 / Math.SQRT2, y: 139 / Math.SQRT2 };
    const across = { x: -139 / Math.SQRT2, y: 139 / Math.SQRT2 };
    expect(covers(diagonal, 20, 40, along)).toBe(true);
    expect(covers(diagonal, 20, 40, across)).toBe(false);
  });

  it('leaves the across half-extent untouched', () => {
    // A margin is a length, not an inflation. 40 px of it must not reach a
    // point 21 px off a 42 px-wide box axis.
    expect(covers(car, 42, 40, { x: 500, y: 272 })).toBe(false);
  });
});
