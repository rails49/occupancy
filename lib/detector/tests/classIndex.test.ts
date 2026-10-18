import { describe, it, expect } from 'vitest';
import { detectorClassIndex } from '../src/index.ts';

describe('the class index', () => {
  it('maps every authored subtype onto the one trained class', () => {
    // The whole authoring taxonomy trains as `stock` today, which is what lets
    // the editor offer subtypes before any of them is a class of its own.
    for (const cls of ['stock', 'stock.freight', 'stock.loco', 'stock.loco.steam']) {
      expect(detectorClassIndex(cls)).toBe(0);
    }
  });

  it('does not treat a longer word as a subtype', () => {
    expect(detectorClassIndex('stockyard')).toBeNull();
    expect(detectorClassIndex('rolling.stock')).toBeNull();
    expect(detectorClassIndex('')).toBeNull();
  });

  it('prefers the longest matching entry, which is what makes appending safe', () => {
    // Appending `stock.loco` re-maps locomotives onto the new index with no
    // relabeling, while a plain `stock` car stays where it was.
    const classes = ['stock', 'stock.loco'];
    expect(detectorClassIndex('stock.loco.steam', classes)).toBe(1);
    expect(detectorClassIndex('stock.loco', classes)).toBe(1);
    expect(detectorClassIndex('stock.freight', classes)).toBe(0);
    expect(detectorClassIndex('stock', classes)).toBe(0);
  });
});
