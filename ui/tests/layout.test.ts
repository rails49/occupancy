import { describe, it, expect } from 'vitest';
import type { CSSResult, CSSResultGroup } from 'lit';
import { TURN_HEIGHT_PX } from '@rails49/look';
import { RREditorView } from '../src/rr-editor-view.js';

/**
 * Flattens a component's `static styles` — one `css` literal or an array of
 * them — into the text a browser would parse.
 */
function cssTextOf(styles: CSSResultGroup | undefined): string {
  if (!styles) return '';
  if (Array.isArray(styles)) return styles.map(cssTextOf).join('\n');
  const text = (styles as CSSResult).cssText;
  // A `CSSStyleSheet` reaching here has no `cssText`, and an empty string would
  // let every assertion below pass by finding nothing to check.
  if (typeof text !== 'string' || text === '') {
    throw new Error('styles entry carries no cssText to inspect');
  }
  return text;
}

/**
 * jsdom does not lay out, so none of this proves the strip *fits*. What it
 * guards is that the editor gives back its readout bars' padding at the height
 * look's rail lies down at (#42), and at no other.
 */
describe('the editor turns with the rail', () => {
  it('reflows at look\'s turn height', () => {
    expect(cssTextOf(RREditorView.styles)).toContain(`@media (max-height: ${TURN_HEIGHT_PX}px)`);
  });

  it('carries no second, hardcoded breakpoint that could drift from it', () => {
    const heightQueries = cssTextOf(RREditorView.styles).match(/max-height:\s*\d+px/g) ?? [];
    for (const q of heightQueries) expect(q).toBe(`max-height: ${TURN_HEIGHT_PX}px`);
  });
});
