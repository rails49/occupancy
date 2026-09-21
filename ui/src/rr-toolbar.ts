import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { COMPACT_MAX_HEIGHT_PX, compactStripStyles } from './layout.js';
import { lookTokens, railButtonStyles } from './look.js';
import { supportsFileSystemAccess } from './persistence.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

/**
 * Save As is advertised only where it does something Save does not. Without
 * the File System Access API every save is a fresh download, so naming the
 * modifier there would promise a distinction the browser cannot make.
 */
function saveTooltip(): string {
  return supportsFileSystemAccess()
    ? 'Save .r49 Archive (Shift-click: Save As…)'
    : 'Save .r49 Archive';
}

/**
 * Tool palette for the editor: file actions and undo/redo.
 *
 * A column at the side of the editor, and a row in the strip along its top
 * below `COMPACT_MAX_HEIGHT_PX` — see `layout.ts` for why the two elements in
 * that strip must turn together.
 *
 * The v3 labeling tools — the four marker-type
 * modes, delete, and the two-point calibrate mode — were removed with the v4
 * reduction (#19): v4 has no point markers, and its calibration is a list of
 * world-coordinate points rather than a draggable pair. The car, sensor and
 * calibration-point tools that replace them belong to the editor spec.
 *
 * The undo buttons are not a duplicate of the keyboard shortcuts in `rr-app`.
 * Their disabled state is the only honest signal that the stack has a bottom —
 * otherwise "nothing happened" is indistinguishable from an edit applied to an
 * image the user is not looking at — and touch devices have no Cmd+Z at all.
 *
 * @fires rr-file-new - When the new file button is clicked.
 * @fires rr-file-open - When the open file button is clicked.
 * @fires rr-file-save - When the save file button is clicked. `detail.rebind`
 *   is true for a Shift-click, which means Save As.
 * @fires rr-undo - When the undo button is clicked.
 * @fires rr-redo - When the redo button is clicked.
 */
@customElement('rr-toolbar')
export class RRToolbar extends LitElement {
  @property({ type: Boolean }) canUndo = false;
  @property({ type: Boolean }) canRedo = false;
  /** Phrase for the tooltip: "Undo delete image". Null when nothing to undo. */
  @property({ attribute: false }) undoLabel: string | null = null;
  @property({ attribute: false }) redoLabel: string | null = null;

  static styles = [
    lookTokens,
    railButtonStyles,
    css`
    :host {
      display: flex;
      flex-direction: column;
      /* Spacing, not buttons, is what made this column tall (#53). Measured
         across four densities on the real editor: cutting the gaps and padding
         while leaving the icons alone saved 140px of column height, where a
         uniform 30% shrink saved 103px and took the buttons to 41px — under
         the 44px touch target this app needs, since the labeling device is a
         phone. So the gaps collapse and the icons barely move.
         The width is stated again on rr-editor-view's .sidebar rule; both have
         to change together or the column stays as wide as it was. */
      gap: 0.5em;
      padding: 0.6em 0.3em;
      background-color: var(--rail);
      width: 78px;
      user-select: none;
      box-shadow: 2px 0 8px rgba(0, 0, 0, 0.3);
      align-items: center;
      box-sizing: border-box;
      /* Height is the content's, not the column's: the tool palette sits below
         this in the same sidebar, and a toolbar demanding 100% would push it
         out of the view entirely. The sidebar carries the background. */
      flex-shrink: 0;
    }

    .tool-group {
      display: flex;
      flex-direction: column;
      gap: 0.45em;
      padding: 0.35em 0;
      background-color: var(--rail-group);
      border-radius: 8px;
      width: calc(100% - 8px);
      align-items: center;
    }

    sl-icon-button {
      font-size: 2.1em;
      color: white;
      cursor: pointer;
      transition: transform 0.1s;
    }

    sl-icon-button:hover {
      transform: scale(1.1);
    }

    sl-icon-button[disabled] {
      opacity: 0.35;
      cursor: default;
    }

    sl-icon-button[disabled]:hover {
      transform: none;
    }
  `,

    // The turn itself, shared with rr-tool-palette. After the rules above,
    // which is what lets it override them.
    compactStripStyles,

    css`
      @media (max-height: ${COMPACT_MAX_HEIGHT_PX}px) {
        :host {
          /* A shadow off this element's right edge would land inside the
             strip, drawn down its middle. The sidebar casts the strip's one
             edge instead. */
          box-shadow: none;
        }
      }
    `,
  ];

  private _onFileNew() {
    this.dispatchEvent(new CustomEvent('rr-file-new', {
      bubbles: true,
      composed: true
    }));
  }

  private _onFileOpen() {
    this.dispatchEvent(new CustomEvent('rr-file-open', {
      bubbles: true,
      composed: true
    }));
  }

  /**
   * Save, or Save As when Shift is held (#48).
   *
   * A modifier rather than a sixth button, for two reasons. The button count is
   * load-bearing — `layout.ts` measures `COMPACT_MAX_HEIGHT_PX` from *five*
   * toolbar buttons and three palette ones — and on a browser without the File
   * System Access API, Save As does exactly what Save does, so a visible
   * control would be a second button needing an explanation for why it changes
   * nothing there. The tooltip carries the discoverability instead.
   */
  private _onFileSave(event: MouseEvent) {
    this.dispatchEvent(new CustomEvent('rr-file-save', {
      detail: { rebind: event.shiftKey },
      bubbles: true,
      composed: true
    }));
  }

  private _onUndo() {
    this.dispatchEvent(new CustomEvent('rr-undo', {
      bubbles: true,
      composed: true
    }));
  }

  private _onRedo() {
    this.dispatchEvent(new CustomEvent('rr-redo', {
      bubbles: true,
      composed: true
    }));
  }

  render() {
    return html`
      <div class="tool-group">
        <sl-tooltip content="New .r49 Archive">
          <sl-icon-button 
            id="file-new"
            name="file-earmark-plus"
            @click=${this._onFileNew}
          ></sl-icon-button>
        </sl-tooltip>

        <sl-tooltip content="Open .r49 Archive">
          <sl-icon-button 
            id="file-open"
            name="folder2-open"
            @click=${this._onFileOpen}
          ></sl-icon-button>
        </sl-tooltip>

        <sl-tooltip content=${saveTooltip()}>
          <sl-icon-button
            id="file-save"
            name="floppy"
            @click=${this._onFileSave}
          ></sl-icon-button>
        </sl-tooltip>
      </div>

      <div class="tool-group">
        <sl-tooltip content=${this.undoLabel ? `Undo ${this.undoLabel}` : 'Nothing to undo'}>
          <sl-icon-button
            id="edit-undo"
            name="arrow-counterclockwise"
            ?disabled=${!this.canUndo}
            @click=${this._onUndo}
          ></sl-icon-button>
        </sl-tooltip>

        <sl-tooltip content=${this.redoLabel ? `Redo ${this.redoLabel}` : 'Nothing to redo'}>
          <sl-icon-button
            id="edit-redo"
            name="arrow-clockwise"
            ?disabled=${!this.canRedo}
            @click=${this._onRedo}
          ></sl-icon-button>
        </sl-tooltip>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-toolbar': RRToolbar;
  }
}
