import { describe, it, expect } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import '../src/rr-service-details.js';
import type { RRServiceDetails } from '../src/rr-service-details.js';
import type { ServiceDetails } from '../src/liveSources.js';
import type { SensorState } from '../src/occupancy.js';

// The panel is a function of what it is handed (#332): every field the service
// sent has its line or column, and every field it did not has none.

const SENSORS = [
  { id: 'C3.A', name: 'West', x: 10, y: 10 },
  { id: 'C3.B', x: 20, y: 10 },
];

const STATES = new Map<string, SensorState>([
  ['C3.A', { state: 'occupied', confidence: 0.93 }],
  ['C3.B', { state: 'clear' }],
]);

const SENT_AT = '2026-11-05T10:15:30.140Z';

const FULL: ServiceDetails = {
  scores: new Map([
    ['C3.A', 0.93],
    ['C3.B', 0.02],
  ]),
  threshold: 0.5,
  patches: new Map([['C3.A', 'blob:patch-a']]),
  changes: new Map([
    ['C3.A', 4],
    ['C3.B', 3],
  ]),
  timings: { capture_ms: 2.5, decode_ms: 11, cut_ms: 1.25, classify_ms: 30, rate_fps: 14.5, detect_ms: 80 },
  camera: { state: 'ok', rate_fps: 15, frame_age_ms: 20 },
  drift: { px: 2, tolerance_px: 9.75, past: false },
  last_messages: new Map([
    ['C3.A', new Map([['occupancy', { message: { state: 'occupied' }, time: SENT_AT }]])],
  ]),
};

async function mount(details: ServiceDetails | null, rate = 4) {
  return fixture<RRServiceDetails>(html`
    <rr-service-details
      .details=${details}
      .sensors=${SENSORS}
      .states=${STATES}
      .rate=${rate}
    ></rr-service-details>
  `);
}

const headers = (el: RRServiceDetails) =>
  [...el.shadowRoot!.querySelectorAll('th')].map(th => th.textContent!.trim());

/** Each row's cells, by column header. */
function rows(el: RRServiceDetails): Record<string, HTMLTableCellElement>[] {
  const names = headers(el);
  return [...el.shadowRoot!.querySelectorAll('tbody tr')].map(tr =>
    Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [names[i], td]))
  );
}

/** The summary's lines, by label. */
function lines(el: RRServiceDetails): Record<string, string> {
  return Object.fromEntries(
    [...el.shadowRoot!.querySelectorAll('.line')].map(line => [
      line.querySelector('.label')!.textContent!.trim(),
      line.querySelector('.value')!.textContent!.replace(/\s+/g, ' ').trim(),
    ])
  );
}

describe('rr-service-details', () => {
  it('shows every field the service sent', async () => {
    const el = await mount(FULL);

    expect(headers(el)).toEqual(['Sensor', 'Patch', 'Score', 'Changes', 'State', 'Last messages']);
    const [a, b] = rows(el);

    // One row per sensor in manifest order, the name beside the id.
    expect(a.Sensor.textContent).to.contain('C3.A');
    expect(a.Sensor.textContent).to.contain('West');
    expect(b.Sensor.textContent!.trim()).toBe('C3.B');

    expect(a.Patch.querySelector('img')!.getAttribute('src')).toBe('blob:patch-a');
    expect(b.Patch.querySelector('img')).to.be.null;
    expect(a.Score.textContent!.trim()).toBe('0.93');
    expect(a.Changes.textContent!.trim()).toBe('4');
    expect(a.State.textContent!.trim()).toBe('occupied — 93% confidence');

    const time = a['Last messages'].querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe(SENT_AT);
    expect(time.textContent).toBe(new Date(SENT_AT).toLocaleString());
    expect(a['Last messages'].textContent).to.contain('occupancy');
    expect(a['Last messages'].textContent).to.contain('{"state":"occupied"}');
    expect(b['Last messages'].textContent!.trim()).toBe('');

    expect(lines(el)).toEqual({
      Camera: 'ok',
      Rate: 'page 4.0 fps · service 14.5 fps · camera 15.0 fps',
      'Time per stage': 'capture 2.5 ms · decode 11.0 ms · cut 1.3 ms · classify 30.0 ms · detect 80.0 ms',
      'Frame age': '20 ms',
      Threshold: '0.50',
      Drift: '2.0 px, within 9.8 px',
    });
  });

  it('shows id and state only, and the page\'s rate, where the service sent nothing optional', async () => {
    for (const details of [{}, null]) {
      const el = await mount(details);

      expect(headers(el)).toEqual(['Sensor', 'State']);
      expect(rows(el)[1].State.textContent!.trim()).toBe('clear');
      expect(lines(el)).toEqual({ Rate: 'page 4.0 fps' });
    }
  });

  it('gives a clear sensor\'s score its own column, and no confidence in its state', async () => {
    const el = await mount({ scores: new Map([['C3.B', 0.02]]) });
    const b = rows(el)[1];

    expect(b.Score.textContent!.trim()).toBe('0.02');
    expect(b.State.textContent!.trim()).toBe('clear');
  });

  it('shows a reading past the tolerance, and an unmeasured drift with its reason', async () => {
    const past = await mount({ drift: { px: 12, tolerance_px: 9.75, past: true } });
    expect(lines(past).Drift).toBe('12.0 px, past 9.8 px');

    const unmeasured = await mount({ drift: { unmeasured: 'no reference image' } });
    expect(lines(unmeasured).Drift).toBe('not measured: no reference image');
  });

  it('shows a message sent as text as it was sent', async () => {
    const el = await mount({
      last_messages: new Map([['C3.A', new Map([['jmri', { message: 'ACTIVE', time: SENT_AT }]])]]),
    });
    expect(rows(el)[0]['Last messages'].textContent).to.contain('ACTIVE');
    expect(rows(el)[0]['Last messages'].textContent).to.not.contain('"ACTIVE"');
  });

  it('shows a time it cannot read as sent', async () => {
    const el = await mount({
      last_messages: new Map([['C3.A', new Map([['jmri', { message: 'ACTIVE', time: 'soon' }]])]]),
    });
    expect(rows(el)[0]['Last messages'].querySelector('time')!.textContent).toBe('soon');
  });
});
