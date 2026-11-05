import { describe, it, expect, beforeEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import type { SlInput } from '@shoelace-style/shoelace';
import '../src/rr-sensor-dialog.js';
import type { RRSensorDialog } from '../src/rr-sensor-dialog.js';

function field(el: RRSensorDialog): SlInput {
  return el.shadowRoot!.querySelector('sl-input')! as SlInput;
}

function confirm(el: RRSensorDialog) {
  (el.shadowRoot!.querySelector('#sensor-confirm') as HTMLElement).click();
}

describe('rr-sensor-dialog', () => {
  let el: RRSensorDialog;
  let committed: unknown[];

  beforeEach(async () => {
    el = await fixture<RRSensorDialog>(html`<rr-sensor-dialog></rr-sensor-dialog>`);
    committed = [];
    el.addEventListener('rr-sensor-commit', e => committed.push((e as CustomEvent).detail));
  });

  it('opens blank for a sensor with no name', async () => {
    await el.show(null);
    expect(field(el).value).to.equal('');
  });

  it('opens prefilled with the name it has', async () => {
    await el.show('Yard throat');
    expect(field(el).value).to.equal('Yard throat');
  });

  it('resets the field when reopened, rather than keeping what was typed', async () => {
    await el.show('Yard throat');
    field(el).value = 'something else';
    await el.show('Yard throat');
    expect(field(el).value).to.equal('Yard throat');
  });

  it('commits the trimmed name', async () => {
    await el.show(null);
    field(el).value = '  Yard throat  ';
    confirm(el);

    expect(committed).to.deep.equal([{ name: 'Yard throat' }]);
  });

  it('commits null for a cleared field, which is how a name is removed', async () => {
    // `name` is absent when unset, never an empty string: a stored `""` would
    // be a name that displays as nothing.
    await el.show('Yard throat');
    field(el).value = '   ';
    confirm(el);

    expect(committed).to.deep.equal([{ name: null }]);
  });

  it('commits on Enter, the way a one-field form wants to be finished', async () => {
    await el.show(null);
    field(el).value = 'Approach';
    field(el).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
    );

    expect(committed).to.deep.equal([{ name: 'Approach' }]);
  });

  it('commits nothing when dismissed', async () => {
    await el.show('Yard throat');
    (el.shadowRoot!.querySelector('#sensor-cancel') as HTMLElement).click();

    expect(committed).to.have.length(0);
  });

  it('shows the id, which is what the sensor is identified by without a name', async () => {
    await el.show(null, { id: 'S1abcdefghi' });
    expect(el.shadowRoot!.textContent).to.contain('S1abcdefghi');
  });
});
