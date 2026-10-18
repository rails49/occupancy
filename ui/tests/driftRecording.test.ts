import { describe, it, expect } from 'vitest';
import { driftCsv, driftCsvName, driftRow } from '../src/driftRecording.ts';

// DPT 89.6875 puts the tolerance at 22.421875 px, as in `driftSession.test.ts`.
const DPT = 89.6875;
const AT = new Date('2026-10-18T14:32:05.250Z');

describe('driftRow', () => {
  it('records the reading against the tolerance and the stream size', () => {
    expect(driftRow(AT, 40.5, DPT, true, { width: 1280, height: 720 })).toEqual({
      time: '2026-10-18T14:32:05.250Z',
      px: 40.5,
      tolerancePx: 22.421875,
      dpt: DPT,
      past: true,
      overridden: true,
      streamWidth: 1280,
      streamHeight: 720,
    });
  });

  it('leaves the verdict empty without a DPT, rather than inventing one', () => {
    const row = driftRow(AT, 3, null, false, {});
    expect(row.tolerancePx).toBeNull();
    expect(row.dpt).toBeNull();
    expect(row.past).toBeNull();
    expect(row.streamWidth).toBeNull();
    expect(row.streamHeight).toBeNull();
  });
});

describe('driftCsv', () => {
  it('writes the header and one line per row, with empty cells for null', () => {
    const rows = [
      driftRow(AT, 4.25, DPT, false, { width: 1920, height: 1080 }),
      driftRow(new Date('2026-10-18T14:32:08.500Z'), 3, null, false, {}),
    ];
    expect(driftCsv(rows)).toBe(
      'time,px,tolerance_px,dpt,past,overridden,stream_width,stream_height\n' +
        '2026-10-18T14:32:05.250Z,4.25,22.421875,89.6875,false,false,1920,1080\n' +
        '2026-10-18T14:32:08.500Z,3,,,,false,,\n',
    );
  });

  it('writes the header alone when nothing was recorded', () => {
    expect(driftCsv([])).toBe('time,px,tolerance_px,dpt,past,overridden,stream_width,stream_height\n');
  });
});

describe('driftCsvName', () => {
  it('stamps the local start time so a folder of recordings sorts by time', () => {
    expect(driftCsvName(new Date(2026, 9, 18, 9, 5, 7))).toBe('drift-20261018-090507.csv');
  });
});
