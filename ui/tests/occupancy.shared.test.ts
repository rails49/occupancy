import { describe, expect, it } from 'vitest';
import { carWidthPx } from '@rails49/detector';
import type { Detection } from '@rails49/detector';
import type { Sensor } from '@rails49/r49';
import { MARGIN_GAUGES, occupancy } from '../src/occupancy.js';
import type { SensorState } from '../src/occupancy.js';
import shared from './fixtures/l1.json';

/**
 * The L1 cases rails49/occupancy-service shares (#337). Source, commit and
 * format: `fixtures/README.md`.
 *
 * They are here because the page and the service answer the *same question*
 * from the same detections — a controller may read either, and ADR 0023's one
 * margin for both models is worth nothing if the two geometries disagree about
 * where a box ends. `occupancy.test.ts` is this page's own reading of SPEC;
 * these cases are the other implementation's, and a disagreement shows up as a
 * failure here rather than as two pages reporting one layout differently.
 *
 * They cover the geometry of detections only. How the service combines them
 * with its classifier is the service's business.
 */

/** One case, as the service's `LIVE.md` § L1 cases defines it. */
interface SharedCase {
  readonly name: string;
  /** The frame's size. Sensors and detections are in its pixels. */
  readonly width: number;
  readonly height: number;
  readonly dpt: number;
  /** The width substituted for the predicted one: `dpt × 3000 / 1435`. */
  readonly car_width: number;
  /** The margin, in gauges. */
  readonly margin_g: number;
  readonly detections: readonly Detection[];
  readonly sensors: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly expected: Readonly<
    Record<string, { readonly state: string; readonly confidence?: number }>
  >;
}

/**
 * Through `unknown` because TypeScript infers each case's `sensors` and
 * `expected` as its own exact shape — every sensor id anywhere in the file, the
 * ones not in that case optional — so the inferred union does not overlap an
 * index signature. The shape that matters is `LIVE.md`'s, which no inference
 * from one copy of one file could state anyway.
 */
const CASES = shared.cases as unknown as readonly SharedCase[];

/**
 * One sensor's answer in the cases' vocabulary: the state, and the confidence
 * only where it is occupied.
 *
 * The `unknown` **reason is dropped**, and that is the one deliberate gap in
 * what these cases check. This page's closed `UnknownReason` set and a
 * service's own words are different vocabularies by decision (#331), so the
 * cases carry no reason to compare against and comparing one would be
 * asserting that somebody else's wording matches ours.
 */
function asShared(state: SensorState | undefined) {
  if (state === undefined) return undefined;
  if (state.state === 'occupied') return { state: state.state, confidence: state.confidence };
  return { state: state.state };
}

describe('the shared L1 cases', () => {
  it('there are some, so an empty copy cannot pass silently', () => {
    expect(CASES.length).toBeGreaterThan(0);
  });

  for (const sharedCase of CASES) {
    it(sharedCase.name, () => {
      // The constants the case was computed with have to be the ones this page
      // holds, or it is a different contract and passing it would mean nothing.
      // `car_width` is the number both sides derive from DPT, so it stands in
      // for the prototype's width and gauge, which the detector's interface
      // does not export. Close rather than equal: the fixture is Python's, and
      // a last-bit difference in one division is not a disagreement about how
      // wide a car is.
      expect(sharedCase.car_width).toBeCloseTo(carWidthPx(sharedCase.dpt), 9);
      expect(sharedCase.margin_g).toBe(MARGIN_GAUGES);

      const sensors: Sensor[] = Object.entries(sharedCase.sensors).map(([id, at]) => ({ id, ...at }));
      const states = occupancy({
        detections: sharedCase.detections,
        sensors,
        dpt: sharedCase.dpt,
        frame: { width: sharedCase.width, height: sharedCase.height },
      });

      const answered = Object.fromEntries(
        Object.keys(sharedCase.expected).map(id => [id, asShared(states.get(id))])
      );
      expect(answered).toEqual(sharedCase.expected);
    });
  }
});
