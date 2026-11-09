import { describe, expect, it } from 'vitest';
import type { Sensor } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import { MARGIN_GAUGES, covers, occupancy } from '../src/occupancy.js';

/**
 * L1. The contract SPEC § Occupancy Output writes once, pinned in the one place
 * that implements it — which is the reason the function is total: were it not,
 * the live view and the diagnostics view would each build unknown-maps of their
 * own and these assertions would only cover one of them.
 */

const FRAME = { width: 1920, height: 1080 };

/** DPT 20: a car is ~41.8 px wide, so a centreline sensor sits ~21 px inside. */
const DPT = 20;

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

    expect(states.get('a')).toEqual({ state: 'occupied', confidence: car.confidence, detection: car });
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
    expect(states.get('a')).toEqual({
      state: 'occupied',
      confidence: faint.confidence,
      detection: faint,
    });
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

    expect(states.get('a')).toEqual({
      state: 'occupied',
      confidence: underPredicted.confidence,
      detection: underPredicted,
    });
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
    expect(state?.state === 'occupied' && state.detection?.width).toBe(25);
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

    expect(states.get('a')).toEqual({
      state: 'occupied',
      confidence: strong.confidence,
      detection: strong,
    });
  });
});

describe('couplers', () => {
  it('leave no gap between abutting cars', () => {
    // Two cars sharing an endpoint at x = 1110. Either side of the coupling is
    // now inside *both* boxes, because each one is lengthened by 2 G past its
    // own end (#337) — so the shared endpoint needed no special case before the
    // margin and needs none now. Confidences tie here and the scan keeps the
    // first box it found, which is the left one for both sensors; the
    // highest-confidence rule is exercised where they differ.
    const left = detection({ centre: { x: 960, y: 540 }, length: 300 });
    const right = detection({ centre: { x: 1260, y: 540 }, length: 300 });
    const sensors = [sensor('just-left', 1109.9, 540), sensor('just-right', 1110.1, 540)];

    const states = occupancy({ detections: [left, right], sensors, dpt: DPT, frame: FRAME });
    expect(states.get('just-left')).toEqual({
      state: 'occupied',
      confidence: left.confidence,
      detection: left,
    });
    expect(states.get('just-right')).toEqual({
      state: 'occupied',
      confidence: left.confidence,
      detection: left,
    });
  });
});

describe('the margin', () => {
  // 2 G at each end along the long axis (ADR 0023). At DPT 20 one gauge is 20
  // px, so the margin is 40 px and a 300 px box is tested as 380 px long.
  const car = detection({ centre: { x: 960, y: 540 }, length: 300 });

  it('reaches 2 G past each end, and no further', () => {
    // Ends at 810 and 1110. 1.9 G past either one is occupied; 2.1 G is clear.
    const sensors = [
      sensor('right-inside', 1148, 540),
      sensor('right-outside', 1152, 540),
      sensor('left-inside', 772, 540),
      sensor('left-outside', 768, 540),
    ];
    const states = occupancy({ detections: [car], sensors, dpt: DPT, frame: FRAME });

    expect(states.get('right-inside')).toMatchObject({ state: 'occupied' });
    expect(states.get('left-inside')).toMatchObject({ state: 'occupied' });
    expect(states.get('right-outside')).toEqual({ state: 'clear' });
    expect(states.get('left-outside')).toEqual({ state: 'clear' });
  });

  it('closes a 3 G gap between uncoupled cars and leaves a 5 G one open', () => {
    // A miss costs a collision, so a car within 2 G of a sensor counts. Two
    // margins meet across any gap under 4 G: at 3 G the middle of the gap is
    // 1.5 G from each end and reads occupied. SPEC's sentence about a real gap
    // reading clear therefore holds for gaps over 4 G, and 5 G is one of those.
    const closed = occupancy({
      detections: [
        detection({ centre: { x: 800, y: 540 }, length: 300 }), // ends at 950
        detection({ centre: { x: 1160, y: 540 }, length: 300 }), // starts at 1010
      ],
      sensors: [sensor('gap', 980, 540)],
      dpt: DPT,
      frame: FRAME,
    });
    expect(closed.get('gap')).toMatchObject({ state: 'occupied' });

    const open = occupancy({
      detections: [
        detection({ centre: { x: 800, y: 540 }, length: 300 }), // ends at 950
        detection({ centre: { x: 1200, y: 540 }, length: 300 }), // starts at 1050
      ],
      sensors: [sensor('gap', 1000, 540)],
      dpt: DPT,
      frame: FRAME,
    });
    expect(open.get('gap')).toEqual({ state: 'clear' });
  });

  it('does not widen the box across the axis', () => {
    // The margin is along the track only. Across it the derived width already
    // carries ~1.4 m prototype of slack, and lengthening the sides would reach
    // the next track over: 21 px off the centreline, just past the ~20.9 px
    // half-width, still reads clear.
    const states = occupancy({
      detections: [car],
      sensors: [sensor('beside', 960, 561)],
      dpt: DPT,
      frame: FRAME,
    });

    expect(states.get('beside')).toEqual({ state: 'clear' });
  });

  it('is a count of gauges, so its reach in pixels scales with DPT', () => {
    // The number SPEC and ADR 0023 state is 2 *G*, not 40 px: at twice the DPT
    // a gauge is twice as many pixels and the margin reaches twice as far. The
    // offsets come from `MARGIN_GAUGES` rather than from a literal, so a test
    // that still passed after the constant moved would have to be wrong twice.
    const coarse = 40;
    const end = car.centre.x + car.length / 2;
    const reach = MARGIN_GAUGES * coarse;
    const states = occupancy({
      detections: [car],
      sensors: [
        sensor('inside', end + reach * 0.95, 540),
        sensor('outside', end + reach * 1.05, 540),
      ],
      dpt: coarse,
      frame: FRAME,
    });

    expect(states.get('inside')).toMatchObject({ state: 'occupied' });
    expect(states.get('outside')).toEqual({ state: 'clear' });
    // And at DPT 20 that same point past the end is well clear, which is what
    // makes the reach the DPT's and not the box's.
    const fine = occupancy({
      detections: [car],
      sensors: [sensor('inside', end + reach * 0.95, 540)],
      dpt: DPT,
      frame: FRAME,
    });
    expect(fine.get('inside')).toEqual({ state: 'clear' });
  });
});

describe('the occupancy test', () => {
  const car = detection({ centre: { x: 500, y: 250 }, length: 200, width: 42, angle: 0 });

  it('contains a point inside the box', () => {
    expect(covers(car, 42, 0, { x: 500, y: 250 })).toBe(true);
    expect(covers(car, 42, 0, { x: 599, y: 270 })).toBe(true);
  });

  it('excludes a point past either half-extent', () => {
    expect(covers(car, 42, 0, { x: 601, y: 250 })).toBe(false);
    expect(covers(car, 42, 0, { x: 500, y: 272 })).toBe(false);
  });

  it('is strict: a point exactly on the boundary is not contained', () => {
    // No epsilon on top of the margin, per SPEC — that would be a second
    // tolerance nothing measured. The boundary tested is the lengthened one, so
    // here, with the margin zero, it is the raw box's own end.
    expect(covers(car, 42, 0, { x: 600, y: 250 })).toBe(false);
    expect(covers(car, 42, 0, { x: 500, y: 271 })).toBe(false);
  });

  it('lengthens the box by the margin at both ends', () => {
    // 40 px of margin on a box ending at 600 and 400: 639 is inside, 640 is the
    // lengthened boundary and strictly outside, 641 is past it. The same either
    // side.
    expect(covers(car, 42, 40, { x: 639, y: 250 })).toBe(true);
    expect(covers(car, 42, 40, { x: 640, y: 250 })).toBe(false);
    expect(covers(car, 42, 40, { x: 641, y: 250 })).toBe(false);
    expect(covers(car, 42, 40, { x: 361, y: 250 })).toBe(true);
    expect(covers(car, 42, 40, { x: 359, y: 250 })).toBe(false);
  });

  it('leaves the across-axis extent alone', () => {
    // The margin is along the long axis only; the half-width is still the
    // width it was handed, margin or no margin.
    expect(covers(car, 42, 40, { x: 500, y: 272 })).toBe(false);
  });

  it("uses the width it is handed, not the detection's own", () => {
    // The whole point of the normalization: an under-predicted width must not
    // shrink the box L1 tests against.
    const narrow = detection({ centre: { x: 500, y: 250 }, length: 200, width: 10, angle: 0 });
    expect(covers(narrow, 10, 0, { x: 500, y: 265 })).toBe(false);
    expect(covers(narrow, 42, 0, { x: 500, y: 265 })).toBe(true);
  });

  it('rotates with the box, margin included', () => {
    const diagonal = detection({
      centre: { x: 0, y: 0 },
      length: 200,
      width: 20,
      angle: Math.PI / 4,
    });

    // 50 px along the long axis is inside; 50 px across it is not.
    const along = { x: 50 / Math.SQRT2, y: 50 / Math.SQRT2 };
    const across = { x: -50 / Math.SQRT2, y: 50 / Math.SQRT2 };
    expect(covers(diagonal, 20, 0, along)).toBe(true);
    expect(covers(diagonal, 20, 0, across)).toBe(false);

    // 120 px along it is past the end, and inside once 40 px of margin is added.
    const past = { x: 120 / Math.SQRT2, y: 120 / Math.SQRT2 };
    expect(covers(diagonal, 20, 0, past)).toBe(false);
    expect(covers(diagonal, 20, 40, past)).toBe(true);
  });
});
