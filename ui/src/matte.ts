import { css } from 'lit';

/**
 * The black a photograph is matted against, in either theme (#151).
 *
 * The work panes follow the theme (LOOK.md § Theme) and every surface in them
 * is an `--sl-*` neutral, which inverts when the operating system's preference
 * changes. This one does not: it sits *behind a photograph or a video frame*,
 * and black is what a photograph is matted against under either preference —
 * the same reason a gallery mats a print in black rather than in the colour of
 * the wall.
 *
 * It is a token rather than four `#000` literals because that is exactly the
 * number of rules that mean it — `rr-viewer`'s viewport, a thumbnail, and the
 * report's row image and crop card — and a literal gives a reader no way to
 * tell a considered black from one that was simply never converted.
 * `tests/theme.test.ts` asserts that no pane restates it.
 *
 * **Include it in the component's `static styles`**, first, so `var()` resolves
 * in its own root rather than relying on inheritance from an ancestor.
 */
export const matteTokens = css`
  :host {
    --photo-matte: #000;
  }
`;
