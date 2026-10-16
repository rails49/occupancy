import { describe, it, expect, vi } from 'vitest';
import { DriftMeasurements } from '../src/driftMeasurements.ts';

/** Let every queued measurement run to completion. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** A measuring function that reports `px[image]`, recording what it was asked. */
function fake(px: Record<string, number> = {}) {
  return vi.fn(async (_reference: string, image: string) => px[image] ?? 0);
}

describe('DriftMeasurements', () => {
  it('measures every image against the reference image, and never the reference itself', async () => {
    const measure = fake({ b: 3, c: 7 });
    const drift = new DriftMeasurements(measure, () => {});

    drift.sync(['a', 'b', 'c']);
    await settle();

    expect(measure.mock.calls).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
    expect(drift.row('a')).toEqual({ kind: 'reference' });
    expect(drift.row('b')).toEqual({ kind: 'measured', px: 3 });
    expect(drift.row('c')).toEqual({ kind: 'measured', px: 7 });
  });

  it('measures only an added image, since appending cannot move the reference', async () => {
    const measure = fake({ b: 3, d: 9 });
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b', 'c']);
    await settle();
    measure.mockClear();

    drift.sync(['a', 'b', 'c', 'd']);
    await settle();

    expect(measure.mock.calls).toEqual([['a', 'd']]);
    expect(drift.row('b')).toEqual({ kind: 'measured', px: 3 });
    expect(drift.row('d')).toEqual({ kind: 'measured', px: 9 });
  });

  it('measures nothing again when nothing changed', async () => {
    const measure = fake();
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b']);
    await settle();

    drift.sync(['a', 'b']);
    await settle();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('measures everything again against a new reference image', async () => {
    // A reorder, a delete of position 0, or an undo or redo of either: all the
    // module sees is a different first filename.
    const measure = fake();
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b', 'c']);
    await settle();
    measure.mockClear();

    drift.sync(['c', 'a', 'b']);
    await settle();

    expect(measure.mock.calls).toEqual([
      ['c', 'a'],
      ['c', 'b'],
    ]);
    expect(drift.row('c')).toEqual({ kind: 'reference' });
    expect(drift.row('a')).toEqual({ kind: 'measured', px: 0 });
  });

  it('drops the row of a removed image, and measures it again when it comes back', async () => {
    const measure = fake({ b: 3, c: 7 });
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b', 'c']);
    await settle();
    measure.mockClear();

    drift.sync(['a', 'b']);
    await settle();
    expect(drift.row('c')).toBeUndefined();
    expect(measure).not.toHaveBeenCalled();

    drift.sync(['a', 'b', 'c']);
    await settle();
    expect(measure.mock.calls).toEqual([['a', 'c']]);
    expect(drift.row('c')).toEqual({ kind: 'measured', px: 7 });
  });

  it('drops a result that lands after the reference image changed, and measures that image again', async () => {
    const resolvers: Array<(px: number) => void> = [];
    const measure = vi.fn(
      (_reference: string, _image: string) => new Promise<number>(resolve => resolvers.push(resolve))
    );
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b', 'c']);
    await settle();

    // b is being measured against a when c is dragged to the front.
    drift.sync(['c', 'a', 'b']);
    resolvers[0](50);
    await settle();

    expect(drift.row('b')).not.toEqual({ kind: 'measured', px: 50 });
    resolvers[1](4);
    await settle();
    resolvers[2](6);
    await settle();
    expect(measure.mock.calls).toEqual([
      ['a', 'b'],
      ['c', 'a'],
      ['c', 'b'],
    ]);
    expect(drift.row('a')).toEqual({ kind: 'measured', px: 4 });
    expect(drift.row('b')).toEqual({ kind: 'measured', px: 6 });
  });

  it('says which image is being measured, and reports each change', async () => {
    let resolve: (px: number) => void = () => {};
    const measure = vi.fn(() => new Promise<number>(r => (resolve = r)));
    const onChange = vi.fn();
    const drift = new DriftMeasurements(measure, onChange);

    drift.sync(['a', 'b']);
    await settle();
    expect(drift.row('b')).toEqual({ kind: 'measuring' });
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();

    resolve(2);
    await settle();
    expect(drift.row('b')).toEqual({ kind: 'measured', px: 2 });
    expect(onChange).toHaveBeenCalled();
  });

  it('leaves no row for an image whose measurement failed, goes on to the next, and does not retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const measure = vi.fn(async (_reference: string, image: string) => {
      if (image === 'b') throw new Error('decode failed');
      return 5;
    });
    const drift = new DriftMeasurements(measure, () => {});

    drift.sync(['a', 'b', 'c']);
    await settle();
    drift.sync(['a', 'b', 'c']);
    await settle();

    expect(drift.row('b')).toBeUndefined();
    expect(drift.row('c')).toEqual({ kind: 'measured', px: 5 });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('measures nothing more once stopped', async () => {
    let resolve: (px: number) => void = () => {};
    const measure = vi.fn(() => new Promise<number>(r => (resolve = r)));
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b', 'c']);
    await settle();

    drift.stop();
    resolve(1);
    await settle();

    expect(measure).toHaveBeenCalledTimes(1);
    expect(drift.row('b')).toBeUndefined();
  });

  it('measures an uncalibrated archive too: the pixels need no DPT', async () => {
    // Nothing here takes a DPT. The verdict does, and the editor withholds the
    // rows until one resolves; the measurements are ready when it does.
    const measure = fake({ b: 3 });
    const drift = new DriftMeasurements(measure, () => {});
    drift.sync(['a', 'b']);
    await settle();
    expect(drift.row('b')).toEqual({ kind: 'measured', px: 3 });
  });
});
