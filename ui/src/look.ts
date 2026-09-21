import { css } from 'lit';

/**
 * The look rules' values, as this UI expresses them (#148, #149).
 *
 * Four rails49 UIs are bound to the same six values — four colours and two
 * sizes — and nothing else (ADR-0003). They travel as a copied file rather than
 * a package (ADR-0005): `../look/tokens.css` is `rails49/.github`'s file
 * verbatim, `../look/README.md` records the commit, and `../look/values.test.ts`
 * asserts that what is declared here equals it. That test is the only thing
 * that reads the copy — nothing imports it and no build sees it.
 *
 * How a consumer expresses the values is free, which is why this is a
 * `CSSResult` rather than a linked stylesheet: this app's chrome lives inside
 * shadow roots, and a `:host` block put first in a component's `static styles`
 * is the shortest route from a token to the rule that uses it.
 *
 * **Include it in every component that draws chrome**, first, so its own rules
 * can override nothing and `var()` resolves in its own root. Custom properties
 * do inherit across the shadow boundary, so a child would often resolve them
 * from an ancestor anyway — declaring them per component is what keeps each one
 * standing on its own, in a test as much as on a page.
 *
 * `--rail-turns` is deliberately **absent**: a media query cannot read a custom
 * property, so the reflow height is a number in `layout.ts` and the test
 * compares that number instead.
 */
export const lookTokens = css`
  :host {
    /* The chrome keeps these values in both themes — that is what makes them
       tokens rather than a palette. Shoelace's own colours move with the theme,
       and the band used to be one of them. */
    --band: #1d4ed8;
    --band-ink: #ffffff;
    --rail: #064e3b;
    --rail-group: #059669;

    /* Every button on the rail: the minimum a thumb needs. Stated as a floor
       rather than a size — the rail's buttons are larger than this at full
       height, and #53 already refused a density change that would have taken
       them under it. */
    --rail-button: 44px;
  }
`;

/**
 * The rail's buttons, as both elements that carry them draw them.
 *
 * `rr-toolbar` and `rr-tool-palette` are two halves of one rail, and these two
 * rules were a byte-for-byte copy in each — the same hazard `layout.ts`'s
 * `compactStripStyles` exists to close, for the same pair of components.
 *
 * `--rail-button` is applied as a **floor rather than a size**: the rail draws
 * its buttons larger than this at full height, and the strip below
 * `COMPACT_MAX_HEIGHT_PX` shrinks the glyph — this is what stops the button
 * shrinking past what a thumb needs, which is the same refusal #53 made when it
 * cut the column's spacing instead of its icons. `justify-content` goes with
 * it: once the floor can make the box wider than its glyph, something has to
 * say where the glyph sits in it.
 *
 * The hover is a dimmed ink rather than a Shoelace colour, for the reason the
 * tokens exist at all: the rail keeps its value in both themes, and
 * `--sl-color-neutral-100` flips from near-black to near-white now that the
 * operating system decides which theme is linked.
 *
 * Order is free — nothing here collides with either component's own rules, and
 * `compactStripStyles` touches only `font-size`.
 */
export const railButtonStyles = css`
  sl-icon-button::part(base) {
    color: white;
    justify-content: center;
    min-width: var(--rail-button);
    min-height: var(--rail-button);
  }

  sl-icon-button::part(base):hover {
    color: rgba(255, 255, 255, 0.7);
  }
`;
