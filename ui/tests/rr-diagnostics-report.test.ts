import { describe, it, expect } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import type { CarLabel } from '@rails49/r49';
import { carWidthPx } from '@rails49/detector';
import { diagnoseImage, rollUp } from '../src/diagnostics.js';
import '../src/rr-diagnostics-report.js';
import type { RRDiagnosticsReport } from '../src/rr-diagnostics-report.js';

const DPT = 10;
const WIDTH = carWidthPx(DPT);

function label(id: string, x0: number, x1: number): CarLabel {
  return { id, class: 'stock', provenance: 'human', p0: { x: x0, y: 0 }, p1: { x: x1, y: 0 } };
}

function archive() {
  return rollUp([
    diagnoseImage({
      filename: 'a.jpg',
      labeledComplete: true,
      dpt: DPT,
      labels: [label('L1', 0, 100)],
      detections: [
        {
          centre: { x: 50, y: 0 },
          length: 100,
          width: WIDTH,
          angle: 0,
          class: 'stock',
          confidence: 0.9,
        },
      ],
    }),
  ]);
}

describe('rr-diagnostics-report', () => {
  it('marks exactly one column as sorted', async () => {
    // The regression this exists for: `aria-sort=${… : undefined}` renders the
    // attribute as an empty string rather than removing it, so `th[aria-sort]`
    // matched every sortable header and the sorted column was unidentifiable.
    // Only lit's `nothing` removes an attribute.
    const el = await fixture<RRDiagnosticsReport>(
      html`<rr-diagnostics-report .diagnostics=${archive()} .dpt=${DPT}></rr-diagnostics-report>`
    );

    const sorted = el.shadowRoot!.querySelectorAll('th[aria-sort]');
    expect(sorted).to.have.lengthOf(1);
    expect(sorted[0].getAttribute('aria-sort')).to.equal('descending');
    expect(sorted[0].textContent!.trim()).to.equal('Disagree');
  });

  it('moves the marker when another column is chosen', async () => {
    const el = await fixture<RRDiagnosticsReport>(
      html`<rr-diagnostics-report .diagnostics=${archive()} .dpt=${DPT}></rr-diagnostics-report>`
    );

    const headers = [...el.shadowRoot!.querySelectorAll('th')];
    const missed = headers.find(h => h.textContent!.trim() === 'Missed')!;
    missed.click();
    await el.updateComplete;

    const sorted = el.shadowRoot!.querySelectorAll('th[aria-sort]');
    expect(sorted).to.have.lengthOf(1);
    expect(sorted[0].textContent!.trim()).to.equal('Missed');
  });
});
