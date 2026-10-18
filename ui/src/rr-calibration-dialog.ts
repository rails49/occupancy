import { LitElement, html, css } from 'lit';
import { customElement, queryAll, query, state } from 'lit/decorators.js';
import type { WorldPoint } from '@rails49/r49';
import { lookTheme, type LookDialog } from '@rails49/look';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import type { SlInput } from '@shoelace-style/shoelace';

/** What a committed dialog reports: the world coordinate the user typed. */
export interface CalibrationCommitDetail {
  /** Millimetres from the layout's arbitrary but fixed origin. */
  readonly world: WorldPoint;
}

/** Which gesture the dialog is completing. Wording only — the commit is identical. */
export type CalibrationDialogMode = 'place' | 'edit';

const ORIGIN: WorldPoint = { x: 0, y: 0, z: 0 };

/**
 * The three axes, in the order they are asked for.
 *
 * One list drives the fields, the reads and the assembled result, so an axis
 * cannot be rendered in one order and read back in another.
 */
const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

/**
 * Asks for a calibration point's world coordinate, in millimetres.
 *
 * The second half of the calibration gesture: the click supplies the pixel, this
 * supplies the millimetres (`SPEC.md` § Reference points). It is deliberately
 * ignorant of both the pixel and the point's index — the editor holds those and
 * records the edit — so the same dialog serves placing and editing.
 *
 * The frame's origin and orientation are arbitrary but shared by every point in
 * the layout, so the fields carry no absolute meaning and are not validated
 * against anything: only the *differences* between points enter the fit.
 *
 * **Properties:** none. It is opened imperatively with {@link show}, because the
 * values it starts from belong to the gesture rather than to any parent state.
 *
 * @fires rr-calibration-commit - The user confirmed. Detail: {@link CalibrationCommitDetail}
 */
@customElement('rr-calibration-dialog')
export class RRCalibrationDialog extends LitElement {
  @state() private _mode: CalibrationDialogMode = 'place';
  /** Which field failed to parse, if any — the label, not the value. */
  @state() private _error: string | null = null;

  @query('look-dialog') private _dialog!: LookDialog;
  /** The three coordinate fields, in {@link AXES} order. */
  @queryAll('sl-input') private _fields!: NodeListOf<SlInput>;

  static styles = [
    lookTheme,
    css`
    .coordinates {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.75rem 1rem;
      align-items: center;
    }

    .label {
      text-align: right;
      font-family: var(--sl-font-mono);
      color: var(--sl-color-neutral-600);
    }

    .hint {
      color: var(--sl-color-neutral-500);
      font-size: var(--sl-font-size-small);
      margin-bottom: 1rem;
    }

    .error {
      color: var(--sl-color-danger-600);
      font-size: var(--sl-font-size-small);
      margin-top: 0.75rem;
    }
  `,
  ];

  /**
   * Opens the dialog on a coordinate.
   *
   * The fields are written imperatively rather than bound, so reopening on the
   * same values after the user typed something else still resets them — a
   * value-bound field would see no change and keep the stale text.
   *
   * @param world Starting coordinate; the origin for a new point.
   * @param options.mode Wording only: "Place" or "Edit".
   */
  public async show(
    world: WorldPoint = ORIGIN,
    options: { mode?: CalibrationDialogMode } = {}
  ): Promise<void> {
    this._mode = options.mode ?? 'place';
    this._error = null;
    await this.updateComplete;

    AXES.forEach((axis, i) => {
      this._fields[i].value = String(world[axis]);
    });

    // Not awaited: sl-dialog's promise resolves on `sl-after-show`, i.e. when
    // its opening animation finishes, and the caller is waiting only for the
    // fields to be ready to type into.
    void this._dialog.show();
    this._fields[0].focus();
  }

  public hide(): void {
    this._dialog?.hide();
  }

  /**
   * Parses one field. Blank is a refusal, not a zero: the origin is a real
   * position in the layout's frame, so reading an unanswered field as one would
   * place a point somewhere specific with nothing saying so.
   */
  private _read(input: SlInput): number | null {
    const text = input.value.trim();
    if (text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  private _onConfirm() {
    const world = {} as Record<Axis, number>;

    for (const [i, axis] of AXES.entries()) {
      const value = this._read(this._fields[i]);
      if (value === null) {
        this._error = `${axis} must be a number, in millimetres.`;
        return;
      }
      world[axis] = value;
    }

    this._error = null;
    this.hide();
    this.dispatchEvent(
      new CustomEvent<CalibrationCommitDetail>('rr-calibration-commit', {
        detail: { world },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Enter finishes the coordinate, which is how a three-field form is typed. */
  private _onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    this._onConfirm();
  }

  render() {
    const verb = this._mode === 'edit' ? 'Edit' : 'Place';

    return html`
      <look-dialog label="${verb} calibration point" size="small">
        <div class="hint">
          Where is this pixel on the layout, in millimetres? The origin is arbitrary
          but must be the same for every point in this layout.
        </div>

        <div class="coordinates" @keydown=${this._onKeyDown}>
          ${AXES.map(axis => html`
            <div class="label">${axis}</div>
            <sl-input id="world-${axis}" type="text" inputmode="decimal"></sl-input>
          `)}
        </div>

        ${this._error ? html`<div class="error">${this._error}</div>` : ''}

        <sl-button id="calibration-cancel" slot="footer" @click=${() => this.hide()}>
          Cancel
        </sl-button>
        <sl-button id="calibration-confirm" slot="footer" variant="primary" @click=${this._onConfirm}>
          ${verb}
        </sl-button>
      </look-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-calibration-dialog': RRCalibrationDialog;
  }

  interface HTMLElementEventMap {
    'rr-calibration-commit': CustomEvent<CalibrationCommitDetail>;
  }
}
