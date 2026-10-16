import { describe, it, expect } from 'vitest';
import { driftVerdict } from '../src/driftSession.ts';

// DPT 89.6875 with `max_drift_track_fraction: 0.25` puts the tolerance at
// 22.421875 px — the same layout the editor's drift tests calibrate.
const DPT = 89.6875;

describe('driftVerdict', () => {
  it('passes a drift inside the tolerance', () => {
    expect(driftVerdict(6, DPT)).toEqual({
      px: 6,
      tracks: expect.closeTo(0.0669, 4),
      tolerancePx: 22.421875,
      past: false,
    });
  });

  it('fails a drift past the tolerance, and says how many track widths it is', () => {
    const verdict = driftVerdict(40.4, DPT)!;
    expect(verdict.past).toBe(true);
    expect(verdict.tracks).toBeCloseTo(0.4505, 4);
  });

  it('passes a drift exactly at the tolerance', () => {
    expect(driftVerdict(22.421875, DPT)!.past).toBe(false);
  });

  it('gives no verdict without a DPT, since there is no track width to take a fraction of', () => {
    expect(driftVerdict(40.4, null)).toBeNull();
  });
});
