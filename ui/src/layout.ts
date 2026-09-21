import { css } from 'lit';

/**
 * The height at which the editor's chrome reflows, and the rules the two
 * elements that reflow with it share.
 *
 * This is not a stylesheet of general layout helpers. It is one agreement
 * between three components that must change shape together (#42):
 * `rr-editor-view` turns its sidebar column into a strip along the top, and
 * `rr-toolbar` and `rr-tool-palette` turn their own contents sideways to sit in
 * it. Switching at different heights would half-apply the reflow, and **a
 * horizontal strip holding two vertical stacks is taller than the column it
 * replaced** — the bug, with extra steps.
 *
 * A media query cannot read a custom property, which is the one thing that
 * stops the breakpoint reaching across on its own; it is interpolated into each
 * component's `static styles` instead, and `tests/layout.test.ts` asserts the
 * three agree.
 */

/**
 * The window height at or below which the editor's sidebar reflows into a
 * horizontal strip (#42).
 *
 * Measured, in the state that decides it: the sidebar is **571px** with an
 * archive open and **not yet calibrated** — five toolbar buttons, three palette
 * buttons, and the gate reason under them — and the header takes 60px above it,
 * so the column needs a 631px window. That state is the one to clear rather
 * than the calibrated arrangement: an archive is uncalibrated before it is
 * calibrated, so the taller arrangement is the one a user meets first, and a
 * breakpoint set for the shorter one would clip exactly the note explaining why
 * the tools are off.
 *
 * **Re-measured for #53**, which cut the column's spacing: it was 721px needing
 * 781px, and this constant was 800. The derivation is what moves — a density
 * change invalidates the measurement, so the number has to be taken again
 * rather than left standing over a column that no longer has that shape.
 *
 * Set above the measurement, not at it. 631 is where the column fills the
 * window with nothing to spare, and the measurement moves with the font and the
 * engine: the same baseline state read 721px when #42 measured it and 708px
 * when #53 did, in a different browser. The margin is what swallows that
 * spread, and keeps the reflow ahead of the clipping rather than level with it.
 *
 * **The number is no longer this repository's to choose** (#148). It is the
 * look rules' `--rail-turns`, one of six values four rails49 UIs are bound to,
 * and it arrives as a copied file rather than a package (#149) — see
 * `../look/README.md`. It moved 650 → 640 on the way in, which the derivation
 * above still clears: the margin over the 631px measurement narrows from ~19px
 * to 9px, the reflow still happens before the column runs out of window, and a
 * measurement that ever exceeded it would be a reason to raise the rules rather
 * than to set a local number. It is absent from `look.ts` because a media query
 * cannot read a custom property, which is why it is a number here and why the
 * values test compares it separately.
 */
export const COMPACT_MAX_HEIGHT_PX = 640;

/**
 * The half of the reflow `rr-toolbar` and `rr-tool-palette` state identically:
 * lie down, and shrink to a strip's height.
 *
 * Shared as a `CSSResult` rather than repeated, the way `marker.ts` shares its
 * styles across the shadow boundary. The breakpoint test guards only that the
 * three components switch at the same height — two copies of these rules could
 * still drift apart underneath it.
 *
 * The icons shrink along with the turn. A strip as tall as these buttons are at
 * full size would take back most of the height the reflow won, which is the
 * whole point of it.
 *
 * **Append this after the component's own rules.** It overrides them at equal
 * specificity, so order is what makes it win.
 */
export const compactStripStyles = css`
  @media (max-height: ${COMPACT_MAX_HEIGHT_PX}px) {
    :host {
      flex-direction: row;
      width: auto;
      gap: 0.75em;
      padding: 0.4em 0.5em;
    }

    .tool-group {
      flex-direction: row;
      width: auto;
      gap: 0.75em;
      padding: 0 0.5em;
    }

    sl-icon-button {
      font-size: 1.6em;
    }
  }
`;
