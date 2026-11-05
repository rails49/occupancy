import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { lookTheme, type LookDialog } from '@rails49/look';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import type { SlInput } from '@shoelace-style/shoelace';
import { sensorId, sensorIdRefusal, type SensorFields } from './sensorId.js';

/**
 * What a committed dialog reports: the sensor's two editable fields.
 *
 * The `id` is already trimmed and has passed {@link sensorIdRefusal} — the
 * dialog commits nothing it would refuse. `name`'s `null` is "no name", which
 * is a real state rather than an empty string: `name` is **absent** when unset
 * (`SPEC.md` § Occupancy Output), and a stored `""` would be a name that
 * displays as nothing.
 */
export type SensorCommitDetail = SensorFields;

/**
 * Edits a sensor's id and its optional name (#335).
 *
 * The `id` is what a controller knows the sensor by: it is generated when the
 * sensor is placed, and this is where a person sets it to the name the
 * controller already uses. So it is **judged, and the name is not** — the rule
 * is `sensorId.ts`'s, shared with `EditSession`, and a refusal appears under
 * the field as the person types. Save and Enter do nothing until it is fixed;
 * there is no toast, because the field the refusal is about is on screen.
 *
 * `name` is free text, optional and not unique: a controller mapping keyed on a
 * name breaks the moment someone renames it, so the format refuses to promise
 * uniqueness and this dialog refuses to imply one. A cleared field removes it,
 * and the editor then shows the id in its place.
 *
 * Editing is separate from placing: the click places the sensor immediately
 * with its generated id, which is a complete sensor, and this edits it
 * afterwards.
 *
 * **Properties:** none. Opened imperatively with {@link show}, like
 * `rr-calibration-dialog`, because the values it starts from belong to the
 * gesture rather than to any parent state.
 *
 * @fires rr-sensor-commit - The user confirmed an id the rule accepts. Detail: {@link SensorCommitDetail}
 */
@customElement('rr-sensor-dialog')
export class RRSensorDialog extends LitElement {
  /** Why the typed id is refused, shown under the field, or null when it is not. */
  @state() private _refusal: string | null = null;
  /** The id the sensor holds, which is never refused, or null while closed. */
  private _current: string | null = null;
  /** Every sensor id in the layout, for the uniqueness check. */
  private _taken: readonly string[] = [];

  @query('look-dialog') private _dialog!: LookDialog;
  @query('#sensor-id') private _idField!: SlInput;
  @query('#sensor-name') private _nameField!: SlInput;

  static styles = [
    lookTheme,
    css`
    .hint {
      color: var(--sl-color-neutral-500);
      font-size: var(--sl-font-size-small);
      margin-bottom: 1rem;
    }

    .fields {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    #sensor-id::part(input) {
      font-family: var(--sl-font-mono);
    }

    .refusal {
      color: var(--sl-color-danger-600);
      font-size: var(--sl-font-size-small);
      margin-top: 0.25rem;
    }
  `,
  ];

  /**
   * Opens the dialog on a sensor.
   *
   * The fields are written imperatively rather than bound, for the same reason
   * `rr-calibration-dialog` does it: reopening on the same values after the user
   * typed something else must reset the text, and a value-bound field would see
   * no change and keep the stale one.
   *
   * @param sensor The sensor's id, and its name or null when it has none.
   * @param options.taken Every sensor id in the layout. The sensor's own may be
   *   among them: its current id is never refused.
   */
  public async show(
    sensor: SensorFields,
    options: { taken?: readonly string[] } = {}
  ): Promise<void> {
    this._current = sensor.id;
    this._taken = options.taken ?? [sensor.id];
    this._refusal = null;
    await this.updateComplete;

    this._idField.value = sensor.id;
    this._nameField.value = sensor.name ?? '';

    // Not awaited: sl-dialog's promise resolves when its opening animation
    // finishes, and the caller is waiting only for the fields to be typable.
    void this._dialog.show();
    this._idField.focus();
  }

  public hide(): void {
    this._dialog?.hide();
  }

  /** Why the field's id is refused, or null. The rule, against this sensor. */
  private _judge(): string | null {
    return sensorIdRefusal(this._idField.value, {
      current: this._current,
      taken: this._taken,
    });
  }

  /** The message follows the field as it is typed, so a fix clears it at once. */
  private _onIdInput() {
    this._refusal = this._judge();
  }

  /**
   * Save, on an id the rule accepts. A refused one leaves the dialog open with
   * its message and commits nothing.
   *
   * The id is judged here rather than trusting {@link _refusal}: the message is
   * what the person reads, and the commit must be decided by the value the
   * field actually holds.
   *
   * A blank name field is **no name**, not an empty one. Clearing the box is how
   * a name is removed, so the two have to be the same value: the field is
   * trimmed and an empty result becomes `null`, which the editor writes as the
   * absence of the key.
   */
  private _onConfirm() {
    this._refusal = this._judge();
    if (this._refusal !== null) return;

    const id = sensorId(this._idField.value);
    const name = this._nameField.value.trim();
    this.hide();
    this.dispatchEvent(
      new CustomEvent<SensorCommitDetail>('rr-sensor-commit', {
        detail: { id, name: name === '' ? null : name },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Enter finishes the form, from either field. */
  private _onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this._onConfirm();
  }

  render() {
    return html`
      <look-dialog label="Sensor" size="small">
        <div class="hint">
          The id is what a controller knows this sensor by, and it is unique within the
          layout. The name is optional free text, need not be unique, and is shown in the
          editor in the id's place — clear the field to remove one.
        </div>

        <div class="fields" @keydown=${this._onKeyDown}>
          <div>
            <sl-input
              id="sensor-id"
              label="Id"
              type="text"
              placeholder="e.g. c3.a"
              @sl-input=${this._onIdInput}
            ></sl-input>
            ${this._refusal ? html`<div class="refusal">${this._refusal}</div>` : ''}
          </div>

          <sl-input
            id="sensor-name"
            label="Name"
            type="text"
            placeholder="e.g. Yard throat"
          ></sl-input>
        </div>

        <sl-button id="sensor-cancel" slot="footer" @click=${() => this.hide()}>
          Cancel
        </sl-button>
        <sl-button id="sensor-confirm" slot="footer" variant="primary" @click=${this._onConfirm}>
          Save
        </sl-button>
      </look-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-sensor-dialog': RRSensorDialog;
  }

  interface HTMLElementEventMap {
    'rr-sensor-commit': CustomEvent<SensorCommitDetail>;
  }
}
