import { describe, it, expect } from 'vitest';
import r49Data from '@rails49/r49/data.json';
import { classChoices, isKnownClass, rootClass } from '../src/vocabulary.js';
import type { VocabularyNode } from '../src/vocabulary.js';

/**
 * A taxonomy deeper than the authored one, so the nesting rules are exercised
 * against a shape `@rails49/r49`'s vocabulary may grow into rather than only the shape it has
 * today. The point of the whole module is that this file is the *only* place a
 * class name is written in `ui/`.
 */
const vocabulary: VocabularyNode = {
  stock: {
    loco: { steam: {}, diesel: {} },
    wagon: {},
    // Not a subtype: a property of `stock` itself. Told apart by being a
    // non-object, which is what keeps `width_mm` from needing a reserved name.
    width_mm: 2900,
  },
};

describe('rootClass()', () => {
  it('is the taxonomy s single top-level entry', () => {
    expect(rootClass(vocabulary)).toBe('stock');
  });

  it('refuses a vocabulary with no root, rather than inventing one', () => {
    // Every new car is created at the root, so there is no fallback that is
    // not a hardcoded class name — which is exactly what this module exists to
    // remove from `ui/`.
    expect(() => rootClass({})).toThrow();
  });

  it('refuses a second root, which would make "the root" ambiguous', () => {
    expect(() => rootClass({ stock: {}, scenery: {} })).toThrow();
  });

  it('reads the authored vocabulary without being told what it says', () => {
    // The gate-time check that the pinned `@rails49/r49` names exactly one
    // root: `rootClass()` throws on any other count.
    expect(rootClass()).toBe(Object.keys(r49Data.vocabulary)[0]);
  });
});

describe('classChoices()', () => {
  it('offers the root s children and never the root itself', () => {
    // ADR 0018: the root is required in the
    // stored class and absent from the UI.
    const choices = classChoices(vocabulary);

    expect(choices.map(c => c.name)).toEqual(['loco', 'wagon']);
    expect(choices.map(c => c.class)).toEqual(['stock.loco', 'stock.wagon']);
  });

  it('carries the full dotted class at every depth', () => {
    // The stored class must be rooted or it matches no entry of
    // `detector.classes` and is dropped from the export.
    const [loco] = classChoices(vocabulary);

    expect(loco.children.map(c => c.class)).toEqual(['stock.loco.steam', 'stock.loco.diesel']);
    expect(loco.children.map(c => c.name)).toEqual(['steam', 'diesel']);
  });

  it('keeps a leaf childless', () => {
    const wagon = classChoices(vocabulary)[1];
    expect(wagon.children).toEqual([]);
  });

  it('treats a non-object value as a property, not a subtype', () => {
    const [loco, ...rest] = classChoices(vocabulary);
    expect([loco, ...rest].map(c => c.name)).not.toContain('width_mm');
  });

  it('preserves the authored order', () => {
    const ordered = classChoices({ stock: { c: {}, a: {}, b: {} } });
    expect(ordered.map(c => c.name)).toEqual(['c', 'a', 'b']);
  });

  it('offers nothing when the root has no children', () => {
    // A menu of nothing is worse than no menu, so the editor renders no
    // reclassify row at all in this case — see `rr-editor-view.ts`.
    expect(classChoices({ stock: {} })).toEqual([]);
  });

  it('is generated from the authored vocabulary, with no list in the code', () => {
    const authored: VocabularyNode = r49Data.vocabulary;
    const root = authored[rootClass()] as VocabularyNode;

    expect(classChoices().map(c => c.name)).toEqual(Object.keys(root));
  });
});

describe('isKnownClass()', () => {
  it('accepts the root, which is what a new car is created as', () => {
    expect(isKnownClass('stock', vocabulary)).toBe(true);
  });

  it('accepts an entry at any depth', () => {
    expect(isKnownClass('stock.loco', vocabulary)).toBe(true);
    expect(isKnownClass('stock.loco.steam', vocabulary)).toBe(true);
  });

  it('rejects a class no entry names — the warning the editor renders', () => {
    expect(isKnownClass('stock.loko', vocabulary)).toBe(false);
    expect(isKnownClass('stock.loco.turbine', vocabulary)).toBe(false);
  });

  it('rejects an unrooted class, which would be dropped from the export', () => {
    expect(isKnownClass('loco.steam', vocabulary)).toBe(false);
  });

  it('rejects a prefix that is not a segment boundary', () => {
    // The same rule the exporter maps with: `stock` matches `stock.loco` but
    // never `stockyard`.
    expect(isKnownClass('stockyard', vocabulary)).toBe(false);
  });

  it('rejects a property name, which is not a class', () => {
    expect(isKnownClass('stock.width_mm', vocabulary)).toBe(false);
  });

  it('rejects the empty class and a trailing separator', () => {
    expect(isKnownClass('', vocabulary)).toBe(false);
    expect(isKnownClass('stock.', vocabulary)).toBe(false);
  });
});
