/**
 * The height of the live view's Details panel, which a person sets by dragging
 * the divider above it (#398).
 *
 * The height is measured from the view's bottom edge. It is kept in the
 * browser's `localStorage`. A browser that refuses the store keeps none.
 */

/** The least height of the panel, in CSS pixels. */
export const LEAST = 96;

/** What the panel leaves the rest of the view, in CSS pixels. */
export const REST = 192;

const KEY = 'occupancy.details';

/**
 * The panel's height in CSS pixels with the divider at a client point, held to
 * `LEAST` and to what leaves the view `REST`. In a view too small for both,
 * `LEAST` holds.
 */
export function heightAt(
  view: { readonly bottom: number; readonly height: number },
  at: { readonly y: number }
): number {
  return Math.round(Math.max(LEAST, Math.min(view.bottom - at.y, view.height - REST)));
}

/** The height this browser keeps, or `null` for none. */
export function kept(): number | null {
  try {
    const height = localStorage.getItem(KEY);
    return height === null ? null : Number(height);
  } catch {
    return null;
  }
}

export function keep(height: number): void {
  try {
    localStorage.setItem(KEY, String(height));
  } catch {
    // The browser refuses the store.
  }
}
