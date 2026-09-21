import { describe, it, expect } from 'vitest';
import type { CSSResult, CSSResultGroup } from 'lit';
import fs from 'node:fs';
import path from 'node:path';
import { lookTokens, railButtonStyles } from '../src/look.js';
import { COMPACT_MAX_HEIGHT_PX } from '../src/layout.js';
import { RRHeader } from '../src/rr-header.js';
import { RRToolbar } from '../src/rr-toolbar.js';
import { RRToolPalette } from '../src/rr-tool-palette.js';
import { RREditorView } from '../src/rr-editor-view.js';

// The look rules bind four UIs to six values (ADR-0003), and those values
// travel as a copied file rather than a package (ADR-0005): `tokens.css` beside
// this test is `rails49/.github`'s, verbatim, at the commit `README.md` records.
//
// This file is the test that ADR asks every consumer for. It **never fetches**
// — it compares what this UI draws with against the copy on disk, so it fails
// only on a local edit and cannot go red on someone else's commit. It sits
// outside `ui/tests/` on purpose, which is what keeps it out of `pnpm test` and
// so out of `bin/test.sh`; `README.md` beside it says why.

const copy = fs.readFileSync(path.resolve(__dirname, 'tokens.css'), 'utf8');

/**
 * Every `--name: value` declaration in a stylesheet, comments stripped first so
 * prose that happens to look like one cannot enter the map.
 */
function customPropertiesIn(cssText: string): Map<string, string> {
  const declarations = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Map(
    [...declarations.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)].map(
      ([, name, value]) => [name, value.trim()]
    )
  );
}

/**
 * A component's `static styles` as the flat list of `css` literals it is built
 * from. The list rather than the joined text, because both questions asked
 * below are about an individual entry: whether the shared blocks are among
 * them, and whether any of the *others* restates a value they declare.
 */
function styleEntries(styles: CSSResultGroup | undefined): CSSResult[] {
  if (!styles) return [];
  if (Array.isArray(styles)) return styles.flatMap(styleEntries);
  // A `CSSStyleSheet` also satisfies `CSSResultGroup` and carries no `cssText`.
  // Nothing here uses one, and casting it through would hand every assertion
  // below an empty string to pass against.
  if (!('cssText' in styles)) {
    throw new Error('styles entry carries no cssText to inspect');
  }
  return [styles];
}

const tokens = customPropertiesIn(copy);
const declared = customPropertiesIn(lookTokens.cssText);

/** The components whose chrome the rules bind, and the tokens each one draws. */
const CHROME = [
  ['rr-header', RRHeader, ['--band', '--band-ink']],
  ['rr-toolbar', RRToolbar, ['--rail', '--rail-group']],
  ['rr-tool-palette', RRToolPalette, ['--rail-group']],
  ['rr-editor-view', RREditorView, ['--rail']],
] as const;

/** A component's own rules — everything but the blocks it shares. */
function ownRules(ctor: (typeof CHROME)[number][1]): string {
  return styleEntries(ctor.styles)
    .filter(s => s !== lookTokens && s !== railButtonStyles)
    .map(s => s.cssText)
    .join('\n');
}

describe('the look rules', () => {
  it('copies exactly the tokens the rules define', () => {
    // An upstream addition arriving in a sync fails here rather than being
    // quietly ignored: the copy is the only thing that changes, and nothing
    // else would notice a seventh token nothing expresses.
    expect([...tokens.keys()].sort()).toEqual([
      '--band',
      '--band-ink',
      '--rail',
      '--rail-button',
      '--rail-group',
      '--rail-turns',
    ]);
  });

  it.each([['--band'], ['--band-ink'], ['--rail'], ['--rail-group'], ['--rail-button']])(
    'draws %s with the copy\'s value',
    name => {
      expect(declared.get(name)).toBe(tokens.get(name));
    }
  );

  it('reflows at the copy\'s --rail-turns height', () => {
    // The one value that cannot be a custom property: a media query cannot read
    // one, so `layout.ts` holds it as a number and interpolates it.
    expect(`${COMPACT_MAX_HEIGHT_PX}px`).toBe(tokens.get('--rail-turns'));
  });

  it.each(CHROME)('%s takes the tokens from the one block that declares them', (_name, ctor) => {
    expect(styleEntries(ctor.styles)).toContain(lookTokens);
  });

  it.each([
    ['rr-toolbar', RRToolbar],
    ['rr-tool-palette', RRToolPalette],
  ] as const)('%s draws the rail\'s buttons from the one block that states them', (_name, ctor) => {
    // The two halves of one rail. These rules were a byte-for-byte copy in each
    // until they moved into `railButtonStyles`, which is the same hazard
    // `compactStripStyles` exists to close — and `tests/layout.test.ts` guards
    // it there the same way.
    expect(styleEntries(ctor.styles)).toContain(railButtonStyles);
  });

  it.each(CHROME)('%s paints with the tokens rather than beside them', (_name, ctor, drawn) => {
    // Declaring the block is not using it. Without this, a component could
    // include `lookTokens`, restate no hex, and still paint the band with
    // `--sl-color-primary-600` — which is the exact failure #148 exists to fix,
    // and every other assertion here would pass.
    const own = ownRules(ctor);
    for (const name of drawn) {
      expect(own).toContain(`var(${name})`);
    }
  });

  it('draws the rail\'s buttons at the size the rules set', () => {
    expect(railButtonStyles.cssText).toContain('var(--rail-button)');
  });

  it.each(CHROME)('%s keeps no second copy of a bound value', (_name, ctor) => {
    // The literals these three colours replaced are what the rules exist to
    // stop: each one drifted independently, and a comment calling #064e3b
    // "explicit dark green" was the whole of its provenance.
    const own = ownRules(ctor);
    for (const name of ['--band', '--rail', '--rail-group'] as const) {
      expect(own).not.toContain(tokens.get(name));
    }
  });

  it('links both Shoelace themes and lets prefers-color-scheme decide', () => {
    // LOOK.md § Theme. Not a value, but the rule the values sit inside: the
    // chrome keeps its colours in both themes, which means nothing if only one
    // theme is ever linked.
    const index = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    for (const theme of ['light', 'dark']) {
      expect(index).toMatch(
        new RegExp(`media="\\(prefers-color-scheme: ${theme}\\)"[^>]*themes/${theme}\\.css`)
      );
    }
  });
});
