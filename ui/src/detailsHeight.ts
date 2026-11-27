/**
 * The height of the live view's Details panel, which a person sets by dragging
 * the divider above it (#398).
 *
 * The height is measured from the view's bottom edge. The arithmetic and the
 * store in `localStorage` are `@rails49/look`'s divider functions (#400).
 */

import { dividerSizeAt, keepDivider, keptDivider } from '@rails49/look';

/** The least height of the panel, in CSS pixels. */
export const LEAST = 96;

/** What the panel leaves the rest of the view, in CSS pixels. */
export const REST = 192;

const KEY = 'occupancy.details';

/** The panel's height in CSS pixels with the divider at a client point, held to `LEAST` and `REST`. */
export function heightAt(
  view: Parameters<typeof dividerSizeAt>[0],
  at: Parameters<typeof dividerSizeAt>[1]
): number {
  return dividerSizeAt(view, at, 'bottom', { least: LEAST, leaves: REST });
}

/** The height this browser keeps, or `null` for none. */
export function kept(): number | null {
  return keptDivider(KEY);
}

export function keep(height: number): void {
  keepDivider(KEY, height);
}
