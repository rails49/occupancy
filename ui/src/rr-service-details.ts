import { LitElement, html, css, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { lookTheme } from '@rails49/look';
import { customElement, property } from 'lit/decorators.js';
import type { Sensor } from '@rails49/r49';
import type { LiveDrift, LiveMessage } from './liveContract.js';
import type { ServiceDetails } from './liveSources.js';
import type { SensorState } from './occupancy.js';
import { stateText } from './sensorMarker.js';

/** The time stages, in the order a frame passes through them, with their labels. */
const STAGES = [
  ['capture_ms', 'capture'],
  ['decode_ms', 'decode'],
  ['cut_ms', 'cut'],
  ['classify_ms', 'classify'],
  ['detect_ms', 'detect'],
] as const;

/** A number to one decimal, with its unit. */
const unit = (value: number, name: string) => `${value.toFixed(1)} ${name}`;

/**
 * What an occupancy service sent beyond L1 (#332): a few lines about the
 * camera, the rates, the time per stage, the frame age, the threshold and
 * drift, then one row per sensor with its patch, score, L1 changes, state and
 * last MQTT messages.
 *
 * Only what the service sent is shown: a field it did not send has no line or
 * column. Times from the service show in local time and are never compared
 * with this page's clock.
 *
 * **Properties:** `details` (`null` before the first answer and after a failed
 * one), `sensors` (the held manifest's, in order), `states` (L1 by sensor id),
 * `rate` (frames per second this page gets). **Events:** none.
 */
@customElement('rr-service-details')
export class RRServiceDetails extends LitElement {
  @property({ attribute: false }) details: ServiceDetails | null = null;
  @property({ attribute: false }) sensors: readonly Sensor[] = [];
  @property({ attribute: false }) states: ReadonlyMap<string, SensorState> = new Map();
  @property({ attribute: false }) rate = 0;

  static styles = [
    lookTheme,
    css`
      :host {
        display: block;
        overflow: auto;
        padding: 0.5rem 1rem;
        background: var(--sl-color-neutral-0);
        color: var(--sl-color-neutral-900);
        font-size: 0.85rem;
        border-top: 1px solid var(--sl-color-neutral-200);
      }

      .lines {
        margin: 0 0 0.5rem;
      }

      .line {
        display: flex;
        gap: 0.5rem;
      }

      .label {
        color: var(--sl-color-neutral-600);
        min-width: 7rem;
      }

      table {
        border-collapse: collapse;
      }

      th,
      td {
        padding: 0.25rem 0.5rem;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid var(--sl-color-neutral-200);
        white-space: nowrap;
      }

      th {
        color: var(--sl-color-neutral-600);
        font-weight: normal;
      }

      .name {
        color: var(--sl-color-neutral-600);
        margin-left: 0.25rem;
      }

      img {
        display: block;
        max-height: 3rem;
        max-width: 6rem;
      }
    `,
  ];

  /** The lines above the table, each `[label, value]`, leaving out what was not sent. */
  private _lines(): [string, string][] {
    const { camera, timings, threshold, drift } = this.details ?? {};
    const lines: [string, string][] = [];
    if (camera?.state !== undefined) lines.push(['Camera', camera.state]);

    const rates = [`page ${unit(this.rate, 'fps')}`];
    if (timings?.rate_fps !== undefined) rates.push(`service ${unit(timings.rate_fps, 'fps')}`);
    if (camera?.rate_fps !== undefined) rates.push(`camera ${unit(camera.rate_fps, 'fps')}`);
    if (timings?.l0_rate_fps !== undefined) rates.push(`detector ${unit(timings.l0_rate_fps, 'fps')}`);
    lines.push(['Rate', rates.join(' · ')]);

    const stages = STAGES.flatMap(([key, label]) =>
      timings?.[key] === undefined ? [] : [`${label} ${unit(timings[key], 'ms')}`]
    );
    if (stages.length > 0) lines.push(['Time per stage', stages.join(' · ')]);

    if (camera?.frame_age_ms !== undefined) {
      lines.push(['Frame age', `${Math.round(camera.frame_age_ms)} ms`]);
    }
    if (timings?.l0_age_ms !== undefined) lines.push(['L0 age', `${Math.round(timings.l0_age_ms)} ms`]);
    if (threshold !== undefined) lines.push(['Threshold', threshold.toFixed(2)]);
    if (drift !== undefined) lines.push(['Drift', driftText(drift)]);
    return lines;
  }

  render() {
    const { patches, scores, changes, last_messages: messages } = this.details ?? {};
    // Each optional column: its header, and a sensor's cell.
    const columns: [string, (id: string) => unknown][] = [];
    if (patches) {
      columns.push(['Patch', id => {
        const src = patches.get(id);
        return src === undefined ? nothing : html`<img src=${src} alt="Patch of ${id}" />`;
      }]);
    }
    if (scores) columns.push(['Score', id => scores.get(id)?.toFixed(2) ?? nothing]);
    if (changes) columns.push(['Changes', id => changes.get(id) ?? nothing]);
    const state = (id: string) => {
      const entry = this.states.get(id);
      return entry ? stateText(entry) : nothing;
    };

    return html`
      <div class="lines">
        ${this._lines().map(
          ([label, value]) =>
            html`<div class="line"><span class="label">${label}</span><span class="value">${value}</span></div>`
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Sensor</th>
            ${columns.map(([header]) => html`<th>${header}</th>`)}
            <th>State</th>
            ${messages ? html`<th>Last messages</th>` : nothing}
          </tr>
        </thead>
        <tbody>
          ${this.sensors.map(
            sensor => html`<tr>
              <td>
                <code>${sensor.id}</code>${sensor.name ? html`<span class="name">${sensor.name}</span>` : nothing}
              </td>
              ${columns.map(([, cell]) => html`<td>${cell(sensor.id)}</td>`)}
              <td>${state(sensor.id)}</td>
              ${messages ? html`<td>${messagesCell(messages.get(sensor.id))}</td>` : nothing}
            </tr>`
          )}
        </tbody>
      </table>
    `;
  }
}

/** Drift as a line: the reading against its tolerance, or why there is none. */
function driftText(drift: LiveDrift): string {
  if ('unmeasured' in drift) return `not measured: ${drift.unmeasured}`;
  return `${unit(drift.px, 'px')}, ${drift.past ? 'past' : 'within'} ${unit(drift.tolerance_px, 'px')}`;
}

/** One sensor's last message per profile, each with its time. */
function messagesCell(profiles: ReadonlyMap<string, LiveMessage> | undefined): TemplateResult[] {
  return [...(profiles ?? [])].map(([profile, { message, time }]) => {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    return html`<div>${profile}: <code>${text}</code> <time datetime=${time}>${localTime(time)}</time></div>`;
  });
}

/** A time from the service in local time, or as sent where it does not read. */
function localTime(time: string): string {
  const at = new Date(time);
  return Number.isNaN(at.getTime()) ? time : at.toLocaleString();
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-service-details': RRServiceDetails;
  }
}
