import { describe, it, expect } from 'vitest';
import { MAX_DRIFT_TRACK_FRACTION, driftVerdict, maxDriftPx } from '../src/driftSession.ts';

// DPT 89.6875 with `MAX_DRIFT_TRACK_FRACTION` of 0.5 puts the tolerance at
// 44.84375 px — the same layout the editor's drift tests calibrate.
const DPT = 89.6875;

describe('MAX_DRIFT_TRACK_FRACTION', () => {
  it('is half a track width, and maxDriftPx scales it by DPT', () => {
    expect(MAX_DRIFT_TRACK_FRACTION).toBe(0.5);
    expect(maxDriftPx(DPT)).toBe(MAX_DRIFT_TRACK_FRACTION * DPT);
  });
});

describe('driftVerdict', () => {
  it('passes a drift inside the tolerance', () => {
    expect(driftVerdict(6, DPT)).toEqual({
      px: 6,
      tracks: expect.closeTo(0.0669, 4),
      tolerancePx: 44.84375,
      past: false,
    });
  });

  it('fails a drift past the tolerance, and says how many track widths it is', () => {
    const verdict = driftVerdict(60, DPT)!;
    expect(verdict.past).toBe(true);
    expect(verdict.tracks).toBeCloseTo(0.669, 4);
  });

  it('passes a reading of half a track width, and refuses one just above it', () => {
    // Both sides of the line the measured readings put it on
    // (`docs/research/drift-tolerance-measured.md`): half a track width is the
    // tolerance, so it is accepted, and the next hair of displacement is not.
    expect(driftVerdict(0.5 * DPT, DPT)!.past).toBe(false);
    expect(driftVerdict(0.5 * DPT + 0.01, DPT)!.past).toBe(true);
  });

  it('passes a reading of 0.3 of a track width, which the tolerance before it refused', () => {
    // The band the readings landed in: a step of the check on the ceiling rig
    // is 0.257 of a track width, so an untouched camera reads around here and
    // the tolerance this replaced refused it.
    const verdict = driftVerdict(0.3 * DPT, DPT)!;
    expect(verdict.past).toBe(false);
    expect(verdict.px).toBeGreaterThan(0.25 * DPT);
  });

  it('gives no verdict without a DPT, since there is no track width to take a fraction of', () => {
    expect(driftVerdict(40.4, null)).toBeNull();
  });
});
