import { describe, it, expect } from 'vitest';
import { fixture, html, oneEvent, waitUntil } from '@open-wc/testing';
import '../src/rr-settings-dialog.ts';
import type { RRSettingsDialog } from '../src/rr-settings-dialog.ts';
import type { MissingRequirement } from '../src/requiredMetadata.ts';
import type { SlInput } from '@shoelace-style/shoelace';

/**
 * The required-metadata gate (#139), from the dialog's side.
 *
 * jsdom lays nothing out, so nothing here claims the dialog *looks* blocking —
 * these assert the open state, the refused close, and the events that leave.
 * The decision of *what* is missing is `requiredMetadata.ts`'s and is tested
 * separately; this component only obeys the list it is handed.
 */

const NEEDS_HEIGHT: MissingRequirement[] = [
  { field: 'camera_height_mm', message: 'Measure the camera height above layout zero, in mm.' },
];

const LAYOUT = { name: 'West Yard', scale: 'HO' as const, calibration: { points: [] } };

async function open(requiredMissing: MissingRequirement[] = [], layout: any = LAYOUT) {
  const el = await fixture<RRSettingsDialog>(
    html`<rr-settings-dialog .layout=${layout} .requiredMissing=${requiredMissing}></rr-settings-dialog>`,
  );
  await el.updateComplete;
  return el;
}

const dialogOf = (el: RRSettingsDialog) => el.shadowRoot!.querySelector('look-dialog')!;

describe('rr-settings-dialog', () => {
  describe('the required-metadata gate', () => {
    it('stays shut when nothing is required', async () => {
      const el = await open([]);
      expect(dialogOf(el).open).toBeFalsy();
    });

    it('opens itself when something is missing', async () => {
      // One rule covers New and Open both: a new archive has no camera height.
      const el = await open(NEEDS_HEIGHT);
      await waitUntil(() => dialogOf(el).open, 'the gate did not open');
    });

    it('states every missing requirement', async () => {
      const el = await open(NEEDS_HEIGHT);
      expect(el.shadowRoot!.querySelector('.required')?.textContent)
        .toContain('Measure the camera height');
    });

    it('refuses to close while blocking, whichever route is taken', async () => {
      const el = await open(NEEDS_HEIGHT);
      // sl-request-close carries the route in `detail.source`; one guard covers
      // the close button, Escape and the overlay alike.
      for (const source of ['close-button', 'keyboard', 'overlay']) {
        const event = new CustomEvent('sl-request-close', {
          detail: { source },
          cancelable: true,
          bubbles: true,
        });
        dialogOf(el).dispatchEvent(event);
        expect(event.defaultPrevented, source).toBe(true);
      }
    });

    it('allows closing once the requirements are satisfied', async () => {
      const el = await open(NEEDS_HEIGHT);
      el.requiredMissing = [];
      await el.updateComplete;

      const event = new CustomEvent('sl-request-close', {
        detail: { source: 'close-button' },
        cancelable: true,
        bubbles: true,
      });
      dialogOf(el).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('disables the footer button while blocking', async () => {
      const el = await open(NEEDS_HEIGHT);
      expect(el.shadowRoot!.querySelector('sl-button')?.hasAttribute('disabled')).toBe(true);
    });

    it('does not reopen itself after the user closes a satisfied dialog', async () => {
      // The gate only ever opens; closing is the user's once satisfied.
      const el = await open([]);
      await el.show();
      await el.hide();
      await el.updateComplete;
      expect(dialogOf(el).open).toBeFalsy();
    });
  });

  describe('the layout fields', () => {
    // sl-change, not sl-input: text fields commit on blur or Enter so that an
    // edit is one undo entry rather than one per keystroke. See history.ts.
    it('emits rr-layout-change when the name is committed', async () => {
      const el = await open([]);
      const nameInput = el.shadowRoot!.querySelector('sl-input')!;

      nameInput.value = 'New Layout Name';
      setTimeout(() => nameInput.dispatchEvent(new CustomEvent('sl-change')));

      const ev = await oneEvent(el, 'rr-layout-change');
      expect(ev.detail.layout.name).to.equal('New Layout Name');
    });

    it('emits rr-layout-change when a scale is selected', async () => {
      const el = await open([]);
      const scaleSelect = el.shadowRoot!.querySelector('sl-select')!;

      scaleSelect.value = 'N';
      setTimeout(() => scaleSelect.dispatchEvent(new CustomEvent('sl-change')));

      const ev = await oneEvent(el, 'rr-layout-change');
      expect(ev.detail.layout.scale).to.equal('N');
    });
  });

  describe('the camera height field', () => {
    const heightInput = (el: RRSettingsDialog) =>
      el.shadowRoot!.querySelector('#camera-height') as SlInput;

    it('shows the authored value', async () => {
      const el = await open([], { ...LAYOUT, calibration: { points: [], camera_height_mm: 1150 } });
      expect(heightInput(el).value).toBe('1150');
    });

    it('is empty when no height is authored', async () => {
      const el = await open([]);
      expect(heightInput(el).value).toBe('');
    });

    it('emits the parsed number on change', async () => {
      const el = await open([]);
      const seen: unknown[] = [];
      el.addEventListener('rr-camera-height-change', (e) =>
        seen.push((e as CustomEvent).detail.camera_height_mm));

      const input = heightInput(el);
      input.value = '1150';
      input.dispatchEvent(new CustomEvent('sl-change', { bubbles: true, composed: true }));
      expect(seen).toEqual([1150]);
    });

    it('emits undefined for an emptied field rather than zero', async () => {
      // Absent means "unknown", which the fit has a defined fallback for; 0
      // would be a camera at layout zero, which is not a pose.
      const el = await open([], { ...LAYOUT, calibration: { points: [], camera_height_mm: 1150 } });
      const seen: unknown[] = [];
      el.addEventListener('rr-camera-height-change', (e) =>
        seen.push((e as CustomEvent).detail.camera_height_mm));

      const input = heightInput(el);
      input.value = '   ';
      input.dispatchEvent(new CustomEvent('sl-change', { bubbles: true, composed: true }));
      expect(seen).toEqual([undefined]);
    });

    it('emits nothing for text that is not a number', async () => {
      const el = await open([]);
      const seen: unknown[] = [];
      el.addEventListener('rr-camera-height-change', () => seen.push('fired'));

      const input = heightInput(el);
      input.value = 'tall';
      input.dispatchEvent(new CustomEvent('sl-change', { bubbles: true, composed: true }));
      expect(seen).toEqual([]);
    });
  });

  describe("the detector's source link (#274)", () => {
    // The site serves @rails49/detector's weights and browser runtime, which
    // are AGPL-3.0; this line is the site's own pointer to their source
    // (rails49/detector ADR 0015). It is an anchor, not a fetch, so ADR 0006
    // is unaffected.
    const sourceLink = (el: RRSettingsDialog) =>
      el.shadowRoot!.querySelector<HTMLAnchorElement>('a[href="https://github.com/rails49/detector"]');

    it('links to rails49/detector', async () => {
      const el = await open([]);
      expect(sourceLink(el)).not.toBeNull();
    });

    it('names the licence and what it covers', async () => {
      const el = await open([]);
      const line = sourceLink(el)!.closest('.source')!.textContent!;
      expect(line).toContain('AGPL-3.0');
      expect(line).toMatch(/model/i);
      expect(line).toMatch(/runtime/i);
    });

    it('stands even while the gate is blocking', async () => {
      // The gate refuses to close, so this is the only dialog a new archive
      // sees; the pointer cannot be behind it.
      const el = await open(NEEDS_HEIGHT);
      expect(sourceLink(el)).not.toBeNull();
    });
  });
});
