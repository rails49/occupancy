import { describe, it, expect, beforeEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import type { SlInput } from '@shoelace-style/shoelace';
import '../src/rr-calibration-dialog.js';
import type { RRCalibrationDialog } from '../src/rr-calibration-dialog.js';

/** The three coordinate inputs, in x/y/z order. */
function inputs(el: RRCalibrationDialog): [SlInput, SlInput, SlInput] {
  const found = [...el.shadowRoot!.querySelectorAll('sl-input')] as SlInput[];
  return found as [SlInput, SlInput, SlInput];
}

function type(el: RRCalibrationDialog, values: [string, string, string]) {
  inputs(el).forEach((input, i) => { input.value = values[i]; });
}

function confirm(el: RRCalibrationDialog) {
  (el.shadowRoot!.querySelector('#calibration-confirm') as HTMLElement).click();
}

describe('rr-calibration-dialog', () => {
  let el: RRCalibrationDialog;
  let committed: unknown[];

  beforeEach(async () => {
    el = await fixture<RRCalibrationDialog>(html`<rr-calibration-dialog></rr-calibration-dialog>`);
    committed = [];
    el.addEventListener('rr-calibration-commit', (e) => committed.push((e as CustomEvent).detail));
  });

  it('opens blank for a new point', async () => {
    await el.show();
    expect(inputs(el).map(i => i.value)).to.deep.equal(['0', '0', '0']);
  });

  it('opens prefilled when editing an existing point', async () => {
    await el.show({ x: 12, y: -250.5, z: 3 });
    expect(inputs(el).map(i => i.value)).to.deep.equal(['12', '-250.5', '3']);
  });

  it('resets the fields when reopened, rather than keeping what was typed', async () => {
    await el.show({ x: 1, y: 2, z: 3 });
    type(el, ['999', '999', '999']);
    await el.show({ x: 1, y: 2, z: 3 });
    expect(inputs(el).map(i => i.value)).to.deep.equal(['1', '2', '3']);
  });

  it('commits the three coordinates as numbers in millimetres', async () => {
    await el.show();
    type(el, ['10', '-250.5', '0']);
    confirm(el);

    expect(committed).to.deep.equal([{ world: { x: 10, y: -250.5, z: 0 } }]);
  });

  it('commits on Enter, the way a typed coordinate wants to be finished', async () => {
    await el.show();
    type(el, ['1', '2', '3']);
    inputs(el)[1].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
    );

    expect(committed).to.deep.equal([{ world: { x: 1, y: 2, z: 3 } }]);
  });

  it('refuses a field that is not a number, and says which', async () => {
    await el.show();
    type(el, ['10', 'two hundred', '0']);
    confirm(el);
    await el.updateComplete;

    expect(committed).to.have.length(0);
    expect(el.shadowRoot!.textContent).to.contain('y');
  });

  it('refuses a blank field rather than reading it as zero', async () => {
    // A blank coordinate is an unanswered question, and zero is a real
    // position in the layout's frame — defaulting one to the other would put a
    // point at the origin with nothing saying so.
    await el.show();
    type(el, ['10', '', '0']);
    confirm(el);
    await el.updateComplete;

    expect(committed).to.have.length(0);
  });

  it('commits nothing when cancelled', async () => {
    await el.show();
    type(el, ['10', '20', '30']);
    (el.shadowRoot!.querySelector('#calibration-cancel') as HTMLElement).click();

    expect(committed).to.have.length(0);
  });

  it('clears a stale error when reopened', async () => {
    await el.show();
    type(el, ['x', '0', '0']);
    confirm(el);
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).to.contain('number');

    await el.show();
    expect(el.shadowRoot!.textContent).to.not.contain('number');
  });

  it('names the gesture it is completing, so place and edit read differently', async () => {
    await el.show();
    expect(el.shadowRoot!.querySelector('look-dialog')!.getAttribute('label')).to.contain('Place');

    await el.show({ x: 1, y: 2, z: 3 }, { mode: 'edit' });
    expect(el.shadowRoot!.querySelector('look-dialog')!.getAttribute('label')).to.contain('Edit');
  });
});
