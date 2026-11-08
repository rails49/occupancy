import { describe, it, expect } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import '../src/rr-stats-bar.js';
import { RRStatsBar } from '../src/rr-stats-bar.js';

describe('rr-stats-bar', () => {
  it('is defined', () => {
    const el = document.createElement('rr-stats-bar');
    expect(el).to.be.instanceOf(RRStatsBar);
  });

  it('renders all stats', async () => {
    const el = await fixture<RRStatsBar>(html`
      <rr-stats-bar
        .fps=${60}
        .cars=${10}
        .occupied=${3}
        .inference=${1.2}
      ></rr-stats-bar>
    `);

    const text = el.shadowRoot!.textContent || '';
    expect(text).to.contain('60.0');
    expect(text).to.contain('10');
    expect(text).to.contain('Inference');
    expect(text).to.contain('1.2ms');
  });

  it('shows L0 and L1 as separate numbers', async () => {
    // Cars found and sensors occupied are different counts and the pair is the
    // readout: cars with no occupied sensor is either an empty siding or a
    // sensor in the wrong place, and one number cannot say which.
    const el = await fixture<RRStatsBar>(html`
      <rr-stats-bar .cars=${4} .occupied=${0}></rr-stats-bar>
    `);

    const rows = [...el.shadowRoot!.querySelectorAll('.stat')].map(r => r.textContent ?? '');
    expect(rows.find(r => r.includes('Cars'))).to.contain('4');
    expect(rows.find(r => r.includes('Occupied'))).to.contain('0');
  });

  describe('the rows nobody measured', () => {
    const rows = (el: RRStatsBar) =>
      [...el.shadowRoot!.querySelectorAll('.stat')].map(r => r.textContent ?? '');

    it('shows no car count where no L0 was published', async () => {
      // An occupancy service may send frames and L1 with no L0 at all (#331).
      // `0` there would claim a frame was inferred and held no cars, which is
      // the confident-looking miss the encoding exists to prevent.
      const el = await fixture<RRStatsBar>(html`
        <rr-stats-bar .cars=${null} .occupied=${2}></rr-stats-bar>
      `);

      expect(rows(el).find(r => r.includes('Cars'))).to.be.undefined;
      expect(rows(el).find(r => r.includes('Occupied'))).to.contain('2');
    });

    it('shows 0 cars for an L0 that found none', async () => {
      // An empty list is a frame that *was* inferred, which is a different fact.
      const el = await fixture<RRStatsBar>(html`<rr-stats-bar .cars=${0}></rr-stats-bar>`);
      expect(rows(el).find(r => r.includes('Cars'))).to.contain('0');
    });

    it('shows no inference row where this page ran no model', async () => {
      const el = await fixture<RRStatsBar>(html`<rr-stats-bar .inference=${null}></rr-stats-bar>`);
      expect(rows(el).find(r => r.includes('Inference'))).to.be.undefined;
    });

    it('shows the L0 age only where there is an L0 to be behind', async () => {
      const without = await fixture<RRStatsBar>(html`<rr-stats-bar></rr-stats-bar>`);
      expect(rows(without).find(r => r.includes('L0 age'))).to.be.undefined;

      const withAge = await fixture<RRStatsBar>(html`<rr-stats-bar .l0Age=${420}></rr-stats-bar>`);
      expect(rows(withAge).find(r => r.includes('L0 age'))).to.contain('420ms');
    });
  });

  describe('the alignment readout', () => {
    const driftRow = (el: RRStatsBar) =>
      [...el.shadowRoot!.querySelectorAll('.stat')].find(r => r.textContent?.includes('Drift:'));

    it('shows the measurement against the tolerance', async () => {
      // Both numbers, because the ratio is what a user aiming a camera judges.
      // A red/green dot would discard exactly that.
      const el = await fixture<RRStatsBar>(html`
        <rr-stats-bar .alignment=${3.4} .alignmentTolerance=${22.4}></rr-stats-bar>
      `);

      const row = driftRow(el)!;
      expect(row).to.exist;
      expect(row.textContent).to.contain('3.4px');
      expect(row.textContent).to.contain('22.4px');
      expect(row.classList.contains('over')).to.be.false;
    });

    it('marks a measurement past the tolerance', async () => {
      const el = await fixture<RRStatsBar>(html`
        <rr-stats-bar .alignment=${40} .alignmentTolerance=${22.4}></rr-stats-bar>
      `);
      expect(driftRow(el)!.classList.contains('over')).to.be.true;
    });

    it('shows an em dash before anything has been measured, never 0.0', async () => {
      // "not measured yet" and "measured, and the camera has not moved" are
      // different facts. This is the one readout where a zero is a claim.
      const el = await fixture<RRStatsBar>(html`
        <rr-stats-bar .alignment=${null} .alignmentTolerance=${22.4}></rr-stats-bar>
      `);

      const row = driftRow(el)!;
      expect(row.textContent).to.contain('—');
      expect(row.textContent).to.not.contain('0.0px');
    });

    it('renders no row at all when no tolerance resolves', async () => {
      // An uncalibrated layout has no track width to take a fraction of, and a
      // bare pixel count invites the reader to supply their own threshold.
      const el = await fixture<RRStatsBar>(html`
        <rr-stats-bar .alignment=${9} .alignmentTolerance=${null}></rr-stats-bar>
      `);
      expect(driftRow(el)).to.be.undefined;
    });
  });
});
