import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { VALID_SCALES } from '@rails49/r49';
import type { Layout } from '@rails49/r49';
import { lookTheme, type LookDialog } from '@rails49/look';
import type { MissingRequirement } from './requiredMetadata.js';
import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/select/select.js';
import '@shoelace-style/shoelace/dist/components/option/option.js';
import '@shoelace-style/shoelace/dist/components/spinner/spinner.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import type { SlInput, SlSelect } from '@shoelace-style/shoelace';

/**
 * The subset of `Layout` this dialog edits, plus the calibration it reads.
 *
 * `calibration` is read-only here: the dialog edits one field inside it and
 * never touches `points`, which is why the camera height leaves on its own
 * event rather than through a spread of the parent object.
 */
type LayoutFields = Pick<Layout, 'name' | 'scale' | 'description' | 'contact'> & {
  readonly calibration?: Layout['calibration'];
};

/**
 * Dialog for editing layout metadata, and the **required-metadata gate** (#139).
 *
 * The "Ref Size (mm)" input was removed with the v4 reduction (#19): v4's
 * calibration is a list of points each carrying its own world coordinate, so
 * the single `size_mm` distance it wrote no longer exists. Calibration
 * authoring returns with the editor spec.
 *
 * **While `requiredMissing` is non-empty the dialog opens itself and refuses to
 * close.** One rule covers both cases SPEC names: a new archive has no camera
 * height, so New opens it; an archive already carrying everything opens
 * straight through and this dialog never appears. That is why no "was this a
 * create?" flag exists anywhere — the state of the manifest is the trigger.
 *
 * It cannot fabricate a value on the author's behalf, and must not be given a
 * default that would: a made-up camera height is worse than an absent one,
 * because a single-plane calibration leaves the fit residual blind to it
 * (`SPEC.md` § Camera height).
 *
 * It also carries the site's pointer to the detector's source (#274): the
 * deployed site serves `@rails49/detector`'s weights and browser runtime,
 * which are AGPL-3.0, and rails49/detector ADR 0015 records that the site
 * meets that licence by linking there. The line is an anchor, never a fetch,
 * so [ADR 0006](../../docs/adr/0006-the-onnx-runtime-ships-from-origin.md) is
 * unaffected. It sits outside the tab group and outside the `requiredMissing`
 * branch, so the gate cannot hide it.
 *
 * @fires rr-layout-change - When a layout field (name, scale, description, contact) changes. Detail: { layout: Partial<Layout> }
 * @fires rr-camera-height-change - When the camera height changes. Detail: { camera_height_mm: number | undefined }
 */
@customElement('rr-settings-dialog')
export class RRSettingsDialog extends LitElement {
  @property({ type: Object }) layout: LayoutFields = { scale: 'N' };

  /**
   * What the layout still owes, from `requiredMetadata.ts`. Non-empty means
   * this dialog is a gate rather than a settings panel.
   */
  @property({ type: Array }) requiredMissing: readonly MissingRequirement[] = [];

  @query('look-dialog') private _dialog!: LookDialog;

  private get _blocking(): boolean {
    return this.requiredMissing.length > 0;
  }

  /**
   * The gate opens itself, and only ever opens — closing is the user's, once
   * they have satisfied it. Driving this from `updated` rather than from a
   * caller is what lets New and Open share one rule; neither knows about it.
   */
  protected updated() {
    if (this._blocking && this._dialog && !this._dialog.open) this._dialog.show();
  }

  static styles = [
    lookTheme,
    css`
    .settings-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 1rem;
      align-items: center;
      padding: 1rem 0;
    }

    .label {
      text-align: right;
      font-weight: 500;
      color: var(--sl-color-neutral-600);
      /* Align with the first line of the control, not with the middle of the
         cell. Centring on the grid centres against the whole row, so a control
         carrying help text drags its label down past the input it names. Rows
         without help text are unaffected: there the cell is exactly the input's
         height, and this lands in the same place centring did. */
      align-self: start;
      line-height: var(--sl-line-height-normal);
      padding-top: calc(
        (var(--sl-input-height-medium) - 1em * var(--sl-line-height-normal)) / 2
      );
    }

    sl-tab-panel {
      padding: 1rem 0;
    }

    .model-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .model-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem;
      border: 1px solid var(--sl-color-neutral-200);
      border-radius: var(--sl-border-radius-medium);
    }

    .model-info {
      display: flex;
      flex-direction: column;
    }

    .model-name {
      font-weight: 600;
    }

    .model-path {
      font-size: 0.8rem;
      color: var(--sl-color-neutral-500);
    }

    .required {
      border-left: 3px solid var(--sl-color-warning-600);
      background: var(--sl-color-warning-100);
      color: var(--sl-color-neutral-900);
      padding: 0.75rem 1rem;
      border-radius: var(--sl-border-radius-medium);
    }

    .required ul {
      margin: 0.5rem 0 0;
      padding-left: 1.25rem;
    }

    .required li + li {
      margin-top: 0.35rem;
    }

    .source {
      margin: 0;
      font-size: var(--sl-font-size-small);
      color: var(--sl-color-neutral-600);
    }
  `,
  ];

  public show() {
    this._dialog.show();
  }

  public hide() {
    this._dialog.hide();
  }

  /**
   * Text fields commit on `sl-change` (blur or Enter), not `sl-input`.
   *
   * Per keystroke, each character would become its own undo entry, so Cmd+Z
   * would chew backwards through a name one letter at a time while the user is
   * trying to reverse an edit from minutes ago. One entry per editing session
   * is the unit the user perceives.
   */
  private _onLayoutChange<K extends keyof LayoutFields>(field: K, value: LayoutFields[K]) {
    this.dispatchEvent(new CustomEvent('rr-layout-change', {
      detail: { layout: { [field]: value } },
      bubbles: true,
      composed: true
    }));
  }

  /**
   * The camera height leaves on its own event rather than through
   * `rr-layout-change`, because it lives inside `calibration` and a spread of
   * that object from here would carry a copy of `points` with it — a stale one
   * the moment anything else edits them.
   *
   * An emptied field emits `undefined`, not 0: absent means "unknown", which
   * the fit has a defined fallback for, while 0 would be a camera at layout
   * zero. The schema rejects the latter anyway.
   */
  private _onCameraHeightChange(raw: string) {
    const trimmed = raw.trim();
    const value = trimmed === '' ? undefined : Number(trimmed);
    if (value !== undefined && !Number.isFinite(value)) return;
    this.dispatchEvent(new CustomEvent('rr-camera-height-change', {
      detail: { camera_height_mm: value },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <look-dialog
        label="Settings"
        size="medium"
        @sl-request-close=${(e: CustomEvent) => {
          // Every route out — the close button, Escape, a click on the overlay
          // — goes through here, so one guard covers all three.
          if (this._blocking) e.preventDefault();
        }}
      >
        ${this._blocking
          ? html`<div class="required">
              <strong>This layout needs a few details before it can be edited.</strong>
              <ul>
                ${this.requiredMissing.map(r => html`<li>${r.message}</li>`)}
              </ul>
            </div>`
          : ''}
        <sl-tab-group>
          <sl-tab slot="nav" panel="layout">Layout</sl-tab>

          <sl-tab-panel name="layout">
            <div class="settings-grid">
              <div class="label">Name</div>
              <sl-input
                value=${this.layout?.name || ''}
                @sl-change=${(e: Event) => this._onLayoutChange('name', (e.target as SlInput).value)}
              ></sl-input>

              <div class="label">Scale</div>
              <sl-select 
                value=${this.layout?.scale || 'N'} 
                @sl-change=${(e: Event) => {
                  const value = (e.target as SlSelect).value;
                  const scale = VALID_SCALES.find((s) => s === value);
                  if (scale !== undefined) this._onLayoutChange('scale', scale);
                }}
              >
                ${VALID_SCALES.map(s => html`
                  <sl-option value=${s}>${s}</sl-option>
                `)}
              </sl-select>

              <div class="label">Camera height (mm)</div>
              <sl-input
                id="camera-height"
                type="number"
                min="1"
                placeholder="e.g. 1150"
                value=${this.layout?.calibration?.camera_height_mm ?? ''}
                help-text="Above layout zero. Scale varies with height, so this is what makes DPT mean the same thing at the rails as on the baseboard."
                @sl-change=${(e: Event) => this._onCameraHeightChange((e.target as SlInput).value)}
              ></sl-input>

              <div class="label">Description</div>
              <sl-input
                id="layout-description"
                value=${this.layout?.description || ''}
                @sl-change=${(e: Event) => this._onLayoutChange('description', (e.target as SlInput).value)}
              ></sl-input>

              <div class="label">Contact</div>
              <sl-input
                id="layout-contact"
                value=${this.layout?.contact || ''}
                @sl-change=${(e: Event) => this._onLayoutChange('contact', (e.target as SlInput).value)}
              ></sl-input>
            </div>
          </sl-tab-panel>
        </sl-tab-group>

        <p class="source">
          The detector's model and browser runtime are AGPL-3.0. Their source is
          <a
            href="https://github.com/rails49/detector"
            target="_blank"
            rel="noreferrer"
            >rails49/detector</a
          >.
        </p>

        <sl-button
          slot="footer"
          variant="primary"
          ?disabled=${this._blocking}
          @click=${() => this.hide()}
          >Close</sl-button
        >
      </look-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-settings-dialog': RRSettingsDialog;
  }
}
