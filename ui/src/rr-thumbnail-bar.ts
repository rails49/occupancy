import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { matteTokens } from './matte.js';

/**
 * Horizontal strip of image thumbnails for selecting and managing layout images.
 *
 * It also **shows which images are labeled complete**, which is the one thing
 * here that is not navigation: scanning a set for what is left to label is the
 * actual workflow (`SPEC.md` § Labeling completeness), and a state that had to
 * be read one image at a time would not serve it.
 *
 * The badge is a **readout and not the control**. The assertion is deliberate —
 * "a human asserts that no car in this image is unlabeled" — so it is made
 * through the editor's own checkbox for the image on screen, where the image is
 * large enough to check. A toggle sitting on a 64px thumbnail would let a click
 * aimed at selecting an image assert completeness by landing a few pixels off,
 * and this is the one flag in the format nothing else may set.
 *
 * **Properties:** `images`, `complete`, `selectedIndex`.
 *
 * @fires rr-image-select - When a thumbnail is clicked. Detail: { index: number }
 * @fires rr-image-delete - When the delete button on a thumbnail is clicked. Detail: { index: number }
 * @fires rr-image-add - When an add button is clicked. Detail: { source: 'camera' | 'file' }
 */
@customElement('rr-thumbnail-bar')
export class RRThumbnailBar extends LitElement {
  @property({ type: Array }) images: string[] = [];
  /**
   * `labeled_complete` per image, parallel to {@link images}.
   *
   * A separate array rather than a richer per-image object, because `images`
   * is a list of blob URLs the editor already builds and this element has no
   * business knowing what an `Image` record is. A short array reads as all
   * incomplete, which is the safe direction: the flag defaults to `false` and
   * nothing may claim it on a human's behalf.
   */
  @property({ type: Array }) complete: boolean[] = [];
  @property({ type: Number }) selectedIndex = -1;

  @state() private _draggedIndex: number | null = null;
  @state() private _dropIndex: number | null = null;

  static styles = [
    matteTokens,
    css`
    :host {
      display: flex;
      align-items: center;
      height: 80px;
      padding: 0 1rem;
      gap: 1rem;
      background-color: var(--sl-color-neutral-100);
      border-bottom: 1px solid var(--sl-color-neutral-200);
      overflow-x: auto;
      user-select: none;
    }

    /* Hide scrollbar but allow scrolling */
    :host::-webkit-scrollbar {
      height: 4px;
    }
    :host::-webkit-scrollbar-thumb {
      background: var(--sl-color-neutral-300);
      border-radius: 2px;
    }

    .thumbnail-wrapper {
      position: relative;
      flex-shrink: 0;
      width: 64px;
      height: 64px;
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border: 2px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      background: var(--photo-matte);
      transition: border-color 0.2s;
    }

    img.active {
      border-color: var(--sl-color-primary-500);
    }

    .delete-btn {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 20px;
      height: 20px;
      background-color: var(--sl-color-danger-600);
      color: white;
      border-radius: 50%;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 10px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
      z-index: 10;
    }

    .thumbnail-wrapper:hover .delete-btn {
      display: flex;
    }

    /* Bottom-left, which is the one corner nothing else uses: the delete button
       is top-right and the active border runs the whole edge. Placed *inside*
       the frame where the delete button hangs outside it — a badge straddling
       the gap between two thumbnails reads as belonging to either one, and this
       one is persistent where the delete button appears only under the cursor
       that already says which thumbnail is meant. */
    .complete-badge {
      position: absolute;
      bottom: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      background-color: var(--sl-color-success-600);
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
      /* A readout, so it never eats the click that selects the image under it. */
      pointer-events: none;
      z-index: 5;
    }

    .add-btn {
      flex-shrink: 0;
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px dashed var(--sl-color-neutral-400);
      border-radius: 4px;
      color: var(--sl-color-neutral-500);
      cursor: pointer;
      font-size: 1.5rem;
      transition: all 0.2s;
    }

    .add-btn:hover {
      border-color: var(--sl-color-primary-500);
      color: var(--sl-color-primary-500);
      background: var(--sl-color-neutral-200);
    }

    .thumbnail-wrapper.dragging {
      opacity: 0.4;
    }

    .thumbnail-wrapper.drop-target {
      outline: 2px solid var(--sl-color-primary-500);
      outline-offset: 2px;
      border-radius: 4px;
    }
  `,
  ];

  private _onSelect(index: number) {
    this.dispatchEvent(new CustomEvent('rr-image-select', {
      detail: { index },
      bubbles: true,
      composed: true
    }));
  }

  private _onDelete(e: Event, index: number) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('rr-image-delete', {
      detail: { index },
      bubbles: true,
      composed: true
    }));
  }

  private _onAdd(source: 'camera' | 'file') {
    this.dispatchEvent(new CustomEvent('rr-image-add', {
      detail: { source },
      bubbles: true,
      composed: true
    }));
  }

  private _onDragStart(e: DragEvent, index: number) {
    this._draggedIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    }
  }

  private _onDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (this._draggedIndex === null || this._draggedIndex === index) return;
    this._dropIndex = index;
  }

  private _onDragLeave() {
    this._dropIndex = null;
  }

  private _onDrop(e: DragEvent, index: number) {
    e.preventDefault();
    this._dropIndex = null;
    if (this._draggedIndex === null || this._draggedIndex === index) {
      this._draggedIndex = null;
      return;
    }

    this.dispatchEvent(new CustomEvent('rr-image-reorder', {
      detail: { from: this._draggedIndex, to: index },
      bubbles: true,
      composed: true
    }));

    this._draggedIndex = null;
  }

  private _onDragEnd() {
    this._draggedIndex = null;
    this._dropIndex = null;
  }

  render() {
    return html`
      ${this.images.map((url, index) => html`
        <div 
          class="thumbnail-wrapper ${this._draggedIndex === index ? 'dragging' : ''} ${this._dropIndex === index ? 'drop-target' : ''}"
          draggable="true"
          @dragstart=${(e: DragEvent) => this._onDragStart(e, index)}
          @dragover=${(e: DragEvent) => this._onDragOver(e, index)}
          @dragleave=${this._onDragLeave}
          @drop=${(e: DragEvent) => this._onDrop(e, index)}
          @dragend=${this._onDragEnd}
        >
          <sl-tooltip content="Switch to image">
            <img 
              src="${url}" 
              class="${index === this.selectedIndex ? 'active' : ''}"
              @click=${() => this._onSelect(index)}
              alt="Thumbnail ${index + 1}"
            />
          </sl-tooltip>
          <div class="delete-btn" @click=${(e: Event) => this._onDelete(e, index)}>
            <sl-icon name="x-lg"></sl-icon>
          </div>
          ${this.complete[index]
            ? html`<!-- role="img", because an aria-label on a role-less div is
                        not reliably exposed. No title: the badge takes no
                        pointer events, so a tooltip on it could never open. -->
              <div class="complete-badge" role="img" aria-label="Labeled complete">
                <sl-icon name="check-lg"></sl-icon>
              </div>`
            : ''}
        </div>
      `)}

      <sl-tooltip content="Capture from Camera">
        <div class="add-btn" @click=${() => this._onAdd('camera')}>
          <sl-icon name="camera"></sl-icon>
        </div>
      </sl-tooltip>

      <sl-tooltip content="Add Image from File">
        <div class="add-btn" @click=${() => this._onAdd('file')}>
          <sl-icon name="folder-plus"></sl-icon>
        </div>
      </sl-tooltip>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-thumbnail-bar': RRThumbnailBar;
  }
}
