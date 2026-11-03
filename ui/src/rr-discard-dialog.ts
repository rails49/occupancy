import { LitElement, html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { lookTheme, type LookDialog } from '@rails49/look';
import '@shoelace-style/shoelace/dist/components/button/button.js';

/** What the person chose about unsaved changes. Closing the dialog is `cancel`. */
export type DiscardChoice = 'save' | 'discard' | 'cancel';

/**
 * Asks what to do with unsaved changes before New or Open replaces the
 * archive: save them, discard them, or stay.
 *
 * **Properties:** none. Opened imperatively with {@link ask}, which resolves
 * with the choice.
 */
@customElement('rr-discard-dialog')
export class RRDiscardDialog extends LitElement {
  @query('look-dialog') private _dialog!: LookDialog;

  /** Resolves the open {@link ask}, or null while closed. */
  private _resolve: ((choice: DiscardChoice) => void) | null = null;

  static styles = [
    lookTheme,
    css`
      p {
        margin: 0;
      }
    `,
  ];

  /** Opens the dialog. Resolves when a button is pressed or the dialog is closed. */
  public async ask(): Promise<DiscardChoice> {
    this._resolve?.('cancel');
    await this.updateComplete;
    const choice = new Promise<DiscardChoice>(resolve => (this._resolve = resolve));
    void this._dialog.show();
    return choice;
  }

  private _choose(choice: DiscardChoice) {
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(choice);
    void this._dialog.hide();
  }

  /** Escape, the close button and the overlay all close without a choice. */
  private _onHide(e: Event) {
    if (e.target === e.currentTarget) this._choose('cancel');
  }

  render() {
    return html`
      <look-dialog label="Unsaved changes" size="small" @sl-hide=${this._onHide}>
        <p>This layout has changes that are not saved.</p>

        <sl-button id="discard-cancel" slot="footer" @click=${() => this._choose('cancel')}>
          Cancel
        </sl-button>
        <sl-button
          id="discard-discard"
          slot="footer"
          variant="danger"
          outline
          @click=${() => this._choose('discard')}
        >
          Discard changes
        </sl-button>
        <sl-button id="discard-save" slot="footer" variant="primary" @click=${() => this._choose('save')}>
          Save
        </sl-button>
      </look-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-discard-dialog': RRDiscardDialog;
  }
}
