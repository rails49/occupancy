import { describe, it, expect } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import type { CarLabel } from '@rails49/r49';
import { diagnoseImage } from '../src/diagnostics.js';
import '../src/rr-diagnostics-queue.js';
import type { RRDiagnosticsQueue } from '../src/rr-diagnostics-queue.js';

const DPT = 10;

function label(id: string, x0: number, x1: number): CarLabel {
  return { id, class: 'stock', provenance: 'human', p0: { x: x0, y: 0 }, p1: { x: x1, y: 0 } };
}

/** Four labels, none found: a queue of four `missed` findings. */
function image(filename = 'a.jpg') {
  return diagnoseImage({
    filename,
    labeledComplete: true,
    dpt: DPT,
    labels: [label('L1', 0, 100), label('L2', 200, 300), label('L3', 400, 500), label('L4', 600, 700)],
    detections: [],
  });
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('rr-diagnostics-queue', () => {
  it('keeps the cursor when the same image is re-scored into a new object', async () => {
    // The regression this exists for. `rr-diagnostics-view` scores on every
    // render rather than caching, so `image` is a fresh object each time and
    // `changed.has('image')` fires on every parent update — once per completed
    // image during a sweep. Resetting on identity put the cursor back to the
    // first finding roughly twice a second while a sweep ran.
    const el = await fixture<RRDiagnosticsQueue>(
      html`<rr-diagnostics-queue .image=${image()} .dpt=${DPT}></rr-diagnostics-queue>`
    );

    press('ArrowDown');
    press('ArrowDown');
    await el.updateComplete;
    expect(el.shadowRoot!.textContent).to.contain('3');

    // A new object for the same filename — exactly what the parent hands over.
    el.image = image();
    await el.updateComplete;

    const counter = el.shadowRoot!.querySelector('.counter')!.textContent!;
    expect(counter.replace(/\s+/g, ' ')).to.contain('3 of 4');
  });

  it('resets the cursor when a different image arrives', async () => {
    const el = await fixture<RRDiagnosticsQueue>(
      html`<rr-diagnostics-queue .image=${image('a.jpg')} .dpt=${DPT}></rr-diagnostics-queue>`
    );

    press('ArrowDown');
    await el.updateComplete;

    el.image = image('b.jpg');
    await el.updateComplete;

    const counter = el.shadowRoot!.querySelector('.counter')!.textContent!;
    expect(counter.replace(/\s+/g, ' ')).to.contain('1 of 4');
  });

  it('declines keystrokes being typed into a field', async () => {
    // Open the settings dialog over the queue and type "Zurich": without the
    // guard the `z` toggles zoom and never reaches the input.
    const el = await fixture<RRDiagnosticsQueue>(
      html`<rr-diagnostics-queue .image=${image()} .dpt=${DPT}></rr-diagnostics-queue>`
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', { key: 'j', bubbles: true });
    Object.defineProperty(event, 'composedPath', { value: () => [input] });
    window.dispatchEvent(event);
    await el.updateComplete;

    const counter = el.shadowRoot!.querySelector('.counter')!.textContent!;
    expect(counter.replace(/\s+/g, ' ')).to.contain('1 of 4');
    input.remove();
  });

  it('leaves Escape to an open dialog rather than closing itself', async () => {
    const el = await fixture<RRDiagnosticsQueue>(
      html`<rr-diagnostics-queue .image=${image()} .dpt=${DPT}></rr-diagnostics-queue>`
    );

    let closed = false;
    el.addEventListener('rr-diagnostics-close', () => (closed = true));

    const dialog = document.createElement('sl-dialog');
    dialog.setAttribute('open', '');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(event, 'composedPath', { value: () => [dialog] });
    window.dispatchEvent(event);

    expect(closed).to.be.false;

    // ...but Escape over the queue itself still leaves.
    press('Escape');
    expect(closed).to.be.true;
  });
});
