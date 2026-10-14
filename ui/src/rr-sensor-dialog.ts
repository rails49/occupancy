import { LitElement, html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { lookTheme, type LookDialog } from '@rails49/look';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import type { SlInput } from '@shoelace-style/shoelace';

/**
 * What a committed dialog reports: the name the user typed.
 *
 * `null` is "no name", which is a real state rather than an empty string:
 * `name` is **absent** when unset (`SPEC.md` § Occupancy Output), and a stored
 * `""` would be a name that displays as nothing.
 */
export interface SensorNameCommitDetail {
  readonly name: string | null;
}

/**
 * Asks for a sensor's name, which is optional.
 *
 * Naming is separate from placing: the click places the sensor immediately, and
 * this names it afterwards — a sensor with no name is complete and useful,
 * because consumers key on `id` and never on `name` (`SPEC.md` § Occupancy
 * Output). The name exists for Rocrail and for humans who cannot remember hex
 * strings.
 *
 * Nothing is validated and nothing is unique: a controller mapping keyed on a
 * name breaks the moment someone renames it, so the format refuses to promise
 * uniqueness and this dialog refuses to imply one.
 *
 * **Properties:** none. Opened imperatively with {@link show}, like
 * `rr-calibration-dialog`, because the value it starts from belongs to the
 * gesture rather than to any parent state.
 *
 * @fires rr-sensor-name-commit - The user confirmed. Detail: {@link SensorNameCommitDetail}
 */
@customElement('rr-sensor-dialog')
export class RRSensorDialog extends LitElement {
  /** The id shown as the fallback identity, or null while closed. */
  @state() private _id: string | null = null;

  @query('look-dialog') private _dialog!: LookDialog;
  @query('sl-input') private _field!: SlInput;

  static styles = [
    lookTheme,
    css`
    .hint {
      color: var(--sl-color-neutral-500);
      font-size: var(--sl-font-size-small);
      margin-bottom: 1rem;
    }

    .identity {
      font-family: var(--sl-font-mono);
    }
  `,
  ];

  /**
   * Opens the dialog on a sensor's current name.
   *
   * The field is written imperatively rather than bound, for the same reason
   * `rr-calibration-dialog` does it: reopening on the same value after the user
   * typed something else must reset the text, and a value-bound field would see
   * no change and keep the stale one.
   *
   * @param name The sensor's name, or null when it has none.
   * @param options.id The sensor's id, shown as what it is identified by when
   *   it carries no name.
   */
  public async show(name: string | null, options: { id?: string } = {}): Promise<void> {
    this._id = options.id ?? null;
    await this.updateComplete;

    this._field.value = name ?? '';

    // Not awaited: sl-dialog's promise resolves when its opening animation
    // finishes, and the caller is waiting only for the field to be typable.
    void this._dialog.show();
    this._field.focus();
  }

  public hide(): void {
    this._dialog?.hide();
  }

  /**
   * A blank field is **no name**, not an empty one.
   *
   * Clearing the box is how a name is removed, so the two have to be the same
   * value: the field is trimmed and an empty result becomes `null`, which the
   * editor writes as the absence of the key.
   */
  private _onConfirm() {
    const text = this._field.value.trim();
    this.hide();
    this.dispatchEvent(
      new CustomEvent<SensorNameCommitDetail>('rr-sensor-name-commit', {
        detail: { name: text === '' ? null : text },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Enter finishes a one-field form. */
  private _onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this._onConfirm();
  }

  render() {
    return html`
      <look-dialog label="Name sensor" size="small">
        <div class="hint">
          Optional. Names are free text and need not be unique — consumers key on the
          sensor's id${this._id ? html`, <span class="identity">${this._id}</span>` : ''}, which is
          also what the editor shows when there is no name. Clear the field to remove one.
        </div>

        <sl-input
          id="sensor-name"
          type="text"
          placeholder="e.g. Yard throat"
          @keydown=${this._onKeyDown}
        ></sl-input>

        <sl-button id="sensor-name-cancel" slot="footer" @click=${() => this.hide()}>
          Cancel
        </sl-button>
        <sl-button id="sensor-name-confirm" slot="footer" variant="primary" @click=${this._onConfirm}>
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
    'rr-sensor-name-commit': CustomEvent<SensorNameCommitDetail>;
  }
}
