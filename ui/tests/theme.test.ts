import { describe, it, expect } from 'vitest';
import type { CSSResult, CSSResultGroup } from 'lit';
import fs from 'node:fs';
import path from 'node:path';
import { matteTokens } from '../src/matte.js';
import { RRDiagnosticsReport } from '../src/rr-diagnostics-report.js';
import { RRThumbnailBar } from '../src/rr-thumbnail-bar.js';
import { RrViewer } from '../src/rr-viewer.js';

// LOOK.md § Theme: **the work pane follows the theme; the chrome does not**
// (#151). Both Shoelace themes are linked and `prefers-color-scheme` decides,
// so a pane painted with an `--sl-*` neutral inverts with the operating system
// and a pane painted with a hex does not.
//
// jsdom does not paint, so nothing here proves the result is *legible* — that
// was judged by hand in both OS settings, and `ui/CLAUDE.md` § Testing (#109)
// says why no browser runner is added for it. What this does guard is the one
// thing a reader cannot see: whether a literal has crept back in. A single
// hardcoded surface is what made the seam in the first place, and it is
// invisible to anyone developing in the theme it was written for.

const SRC = path.resolve(__dirname, '../src');

/**
 * The components that draw a work pane. `rr-viewer` is deliberately absent:
 * everything it draws is *on the photograph* — the matte behind it and the
 * zoom band over it — so it has no pane surface to follow the theme with, and
 * its two colours are judged the way a marker ink is.
 *
 * The chrome is absent for the opposite reason: `rr-header`, `rr-toolbar` and
 * `rr-tool-palette` keep one value in both themes by rule, and
 * `look/values.test.ts` is what holds them to it.
 */
const PANES = [
  'rr-app.ts',
  'rr-editor-view.ts',
  'rr-live-view.ts',
  'rr-stats-bar.ts',
  'rr-thumbnail-bar.ts',
  'rr-diagnostics-view.ts',
  'rr-diagnostics-queue.ts',
  'rr-diagnostics-report.ts',
];

/**
 * A module's code with its comments removed.
 *
 * Stripped first because prose is full of `#151`, which is three hex digits
 * and an issue number. The `//` rule spares `https://` by refusing a `//` that
 * follows a colon.
 */
function code(filename: string): string {
  return fs
    .readFileSync(path.join(SRC, filename), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '');
}

/** A component's `static styles` as the flat list of `css` literals in it. */
function styleEntries(styles: CSSResultGroup | undefined): CSSResult[] {
  if (!styles) return [];
  if (Array.isArray(styles)) return styles.flatMap(styleEntries);
  if (!('cssText' in styles)) {
    throw new Error('styles entry carries no cssText to inspect');
  }
  return [styles];
}

/** The components that mat a photograph, and so take the one black there is. */
const MATTED = [
  ['rr-viewer', RrViewer],
  ['rr-thumbnail-bar', RRThumbnailBar],
  ['rr-diagnostics-report', RRDiagnosticsReport],
] as const;

describe('the work panes follow the theme', () => {
  it.each(PANES)('%s paints with no hardcoded colour', filename => {
    // The whole module rather than `static styles`, because the report set a
    // tile's tint from an inline `style` attribute in its template and that is
    // as hardcoded as a rule is.
    expect(code(filename).match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it.each(MATTED)('%s takes the matte from the one block that declares it', (_name, ctor) => {
    // Declaring the block is not using it, and painting with it is not
    // declaring it: a component that did only the second would resolve
    // `--photo-matte` from an ancestor on a page and from nothing in a test.
    const entries = styleEntries(ctor.styles);
    expect(entries).toContain(matteTokens);
    expect(entries.map(s => s.cssText).join('\n')).toContain('var(--photo-matte)');
  });
});
