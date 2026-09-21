import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { lookTokens } from './look.js';
import './rr-settings-dialog.js';
import type { RRSettingsDialog } from './rr-settings-dialog.js';
import type { MissingRequirement } from './requiredMetadata.js';

/**
 * Where the source lives — a constant, not bound state, so it is no property.
 *
 * `href` makes that button an anchor rather than a button, so the app's page —
 * and the unsaved archive held in memory with it — is never navigated away
 * from. `rel` is deliberately **not** written here: `sl-icon-button` forwards
 * only `href`, `target` and `download`, so a `rel` on the host would be inert
 * decoration. Shoelace emits `rel="noreferrer noopener"` on the anchor itself
 * whenever `target` is set, which is what actually severs the opened tab's
 * handle on this one; `tests/rr-header.test.ts` asserts it on the rendered
 * anchor so an upgrade that dropped it fails there rather than silently.
 */
const REPO_URL = 'https://github.com/rails49/occupancy';

/**
 * The three things the app can be doing, and how each is offered.
 *
 * A **segmented control, not a toggle** since #87. Two modes could cycle on one
 * button, because "the other one" is unambiguous; three cannot — a user who
 * wants Diagnostics from Live would have to guess whether the button steps
 * forward or backward, and either way one destination is two clicks away with
 * no way to tell which. Every mode is one click, and the current one is shown
 * rather than implied by an icon that means "where you would go next".
 */
const VIEW_MODES = [
  { mode: 'editor', icon: 'image-fill', label: 'Label' },
  { mode: 'live', icon: 'camera-video-fill', label: 'Live' },
  { mode: 'diagnostics', icon: 'clipboard-data', label: 'Diagnostics' },
] as const;

export type ViewMode = (typeof VIEW_MODES)[number]['mode'];

/**
 * Top app bar with title/status, mode control, source link, and settings gear.
 *
 * @fires rr-view-change - A mode was chosen. Detail: { mode: ViewMode }
 */
@customElement('rr-header')
export class RRHeader extends LitElement {
  @property({ type: String }) viewMode: ViewMode = 'editor';
  @property({ type: Object }) layout: any = null;
  /**
   * Passed straight through to the settings dialog, which opens itself on it
   * (#139). The header decides nothing about it — it owns the dialog, so it is
   * the only route from `rr-app` to a component the app does not render.
   */
  @property({ type: Array }) requiredMissing: readonly MissingRequirement[] = [];

  @query('rr-settings-dialog') settingsDialog!: RRSettingsDialog;

  static styles = [
    lookTokens,
    css`
    /* The band. One value in both themes, which is the whole reason it is a
       token: it was --sl-color-primary-600 until #148, and that moves with
       the Shoelace theme the work pane follows. */
    :host {
      display: block;
      height: 60px;
      background-color: var(--band);
      color: var(--band-ink);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      z-index: 100;
    }

    nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 100%;
      padding: 0 1rem;
    }

    .left-section {
      display: flex;
      align-items: center;
      gap: 1rem;
      /* Without this a flex item refuses to shrink below its content, so the
         status would push past the gear rather than ellipsis — which the bound
         filename beside the layout name (#48) makes reachable. */
      min-width: 0;
    }

    .title-status {
      font-size: 1.25rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .right-section {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    sl-icon-button {
      font-size: 1.5rem;
      color: var(--band-ink);
    }

    /* Dimmed ink, not a Shoelace colour. The hover was --sl-color-primary-100
       while the dark theme was the only one linked; now that the operating
       system decides (#148) that would flip from dark blue to near-white on a
       band that has not moved. Translucent white is the same gesture in either
       theme, and the .modes rules below already use it. */
    sl-icon-button::part(base):hover {
      color: rgba(255, 255, 255, 0.7);
    }

    .modes {
      display: flex;
      align-items: center;
      gap: 0.1rem;
      padding: 0.1rem;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.18);
      flex-shrink: 0;
    }

    /* The current mode is stated, not implied. The old toggle showed the icon
       of where you would *go*, which reads backwards the moment there are
       three destinations. */
    .modes sl-icon-button.active::part(base) {
      background: rgba(255, 255, 255, 0.22);
      border-radius: 50%;
      color: var(--band-ink);
    }
  `,
  ];

  private _onSelectView(mode: ViewMode) {
    if (mode === this.viewMode) return;
    this.dispatchEvent(new CustomEvent('rr-view-change', {
      detail: { mode },
      bubbles: true,
      composed: true
    }));
  }

  private _onOpenSettings() {
    this.settingsDialog.show();
  }

  render() {
    return html`
      <nav>
        <div class="left-section">
          <!-- A group of buttons, not a tablist. The ARIA tab pattern promises
               things this does not deliver: the roles would sit on the
               sl-icon-button hosts while focus lands on the native button
               inside each shadow root, nothing here is a tabpanel or is named
               by aria-controls, and there is no roving tabindex — the arrow
               keys belong to the diagnostics queue. Three buttons that behave
               like buttons are honest; aria-current states which one you are
               on without claiming a widget that isn't here. -->
          <div class="modes" role="group" aria-label="View">
            ${VIEW_MODES.map(
              ({ mode, icon, label }) => html`
                <sl-tooltip content=${label}>
                  <sl-icon-button
                    name=${icon}
                    label=${label}
                    aria-current=${this.viewMode === mode ? 'true' : nothing}
                    class=${this.viewMode === mode ? 'active' : ''}
                    @click=${() => this._onSelectView(mode)}
                  ></sl-icon-button>
                </sl-tooltip>
              `
            )}
          </div>
          <div class="title-status">
            <slot name="status">Occupancy UI</slot>
          </div>
        </div>

        <div class="right-section">
          <sl-tooltip content="Source on GitHub">
            <sl-icon-button
              name="github"
              label="Source on GitHub"
              href=${REPO_URL}
              target="_blank"
            ></sl-icon-button>
          </sl-tooltip>
          <sl-icon-button name="gear" @click=${this._onOpenSettings}></sl-icon-button>
        </div>
      </nav>

      <rr-settings-dialog
        .layout=${this.layout}
        .requiredMissing=${this.requiredMissing}
      ></rr-settings-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-header': RRHeader;
  }
}
