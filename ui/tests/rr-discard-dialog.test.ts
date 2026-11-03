import { describe, it, expect } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import '../src/rr-discard-dialog.js';
import type { RRDiscardDialog } from '../src/rr-discard-dialog.js';

function press(el: RRDiscardDialog, id: string) {
  (el.shadowRoot!.querySelector(`#${id}`) as HTMLElement).click();
}

describe('rr-discard-dialog', () => {
  it('resolves with the button pressed', async () => {
    const el = await fixture<RRDiscardDialog>(html`<rr-discard-dialog></rr-discard-dialog>`);
    for (const [id, choice] of [
      ['discard-save', 'save'],
      ['discard-discard', 'discard'],
      ['discard-cancel', 'cancel'],
    ] as const) {
      const asked = el.ask();
      await el.updateComplete;
      press(el, id);
      expect(await asked).toBe(choice);
    }
  });

  it('resolves cancel when the dialog is closed without a choice', async () => {
    const el = await fixture<RRDiscardDialog>(html`<rr-discard-dialog></rr-discard-dialog>`);
    const asked = el.ask();
    await el.updateComplete;
    el.shadowRoot!.querySelector('look-dialog')!.dispatchEvent(new Event('sl-hide'));
    expect(await asked).toBe('cancel');
  });
});
