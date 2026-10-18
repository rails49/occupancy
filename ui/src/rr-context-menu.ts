import { LitElement, html, css } from 'lit';
import { lookTheme } from '@rails49/look';
import type { TemplateResult } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import '@shoelace-style/shoelace/dist/components/menu/menu.js';
import '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js';
import type { SlMenuItem } from '@shoelace-style/shoelace';
import { clampToViewport } from './geometry.js';

/**
 * One row of the menu.
 *
 * `id` is what a selection reports and is never shown; `label` is what the user
 * reads. Keeping them apart is what lets the wording of a verb change without
 * touching the code that acts on it.
 *
 * `items` nests: a row that carries children opens a **submenu** instead of
 * reporting anything, which is what the dotted class taxonomy is rendered as
 * (`SPEC.md` § Right-click is state-dependent). The nesting is arbitrarily
 * deep, because the taxonomy is — it is read out of `lib/r49/r49.json` and
 * this element learns its shape from the rows it is handed, as it learns
 * everything else.
 */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  /** Subtypes of this row. A row with children is opened, never chosen. */
  readonly items?: readonly ContextMenuItem[];
}

/** What a selection reports: which row, by `id`. */
export interface ContextMenuSelectDetail {
  readonly id: string;
}

/**
 * A position in **screen** (client) coordinates.
 *
 * Named apart from `Point` deliberately: everything else the editor passes
 * around is in image pixels — `rr-viewer` converts before it emits so nobody
 * can confuse the two — but a menu is placed where the cursor is on the glass,
 * which is the one editor position that is genuinely a screen coordinate.
 */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Gap kept between the menu and the window edge when it has to be clamped. */
const VIEWPORT_MARGIN_PX = 4;

/**
 * The editor's right-click menu: a short list of verbs acting on one object.
 *
 * It is the reason the editor needs no delete mode at all (`SPEC.md`
 * § Right-click is state-dependent) — deleting is a verb on the thing under the
 * cursor rather than a mode the user enters and must remember to leave.
 *
 * It knows nothing about what the object is. The editor hit-tests, names the
 * verbs, and interprets the selection; this element renders rows and reports
 * which one was chosen. That is what lets cars and sensors plug into the same
 * menu as they arrive, along with the reclassify submenu the spec puts here.
 *
 * Opened imperatively like `rr-calibration-dialog`, and for the same reason:
 * what it shows belongs to the gesture that opened it, not to any parent state
 * worth binding. Nothing is rendered while it is closed.
 *
 * **Properties:** none. Use {@link show} / {@link hide}, and {@link open}.
 *
 * @fires rr-context-menu-select - A row was chosen. Detail: {@link ContextMenuSelectDetail}
 */
@customElement('rr-context-menu')
export class RRContextMenu extends LitElement {
  /** The rows currently shown. Empty while closed. */
  @state() private _items: readonly ContextMenuItem[] = [];
  /** Where the menu was asked to open, or null while closed. */
  @state() private _at: ScreenPoint | null = null;

  @query('sl-menu') private _menu!: HTMLElement | null;

  static styles = [
    lookTheme,
    css`
    :host {
      /* Fixed, so the menu is placed in the same frame the cursor was reported
         in — a client coordinate. The custom properties are written once the
         rows are measured; nothing else about the position is dynamic. */
      position: fixed;
      left: var(--menu-x, 0px);
      top: var(--menu-y, 0px);
      z-index: 10;
    }

    sl-menu {
      min-width: 12rem;
      box-shadow: var(--sl-shadow-large);
    }
  `,
  ];

  /** Whether the menu is currently showing. */
  public get open(): boolean {
    return this._at !== null;
  }

  /**
   * Opens the menu at a screen position, showing `items`.
   *
   * Resolves once the rows are in the DOM, so a caller — or a test — can read
   * back what it opened.
   *
   * @param at Where the cursor was, in client coordinates.
   * @param items The verbs to offer. Opening with none is a caller bug; the
   *   editor decides there is nothing to offer *before* it opens anything.
   */
  public async show(at: ScreenPoint, items: readonly ContextMenuItem[]): Promise<void> {
    this._items = items;
    this._at = at;
    this._listen(true);
    await this.updateComplete;
  }

  /** Closes the menu. Safe to call when it is already closed. */
  public hide(): void {
    if (!this._at) return;
    this._at = null;
    this._items = [];
    this._listen(false);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    // `hide()` is what drops the document listeners: an element removed while
    // open would otherwise keep swallowing presses for the rest of the session.
    this.hide();
  }

  /**
   * The two ways out that do not choose anything.
   *
   * Bound to the document rather than to this element, because both gestures
   * are by definition aimed somewhere else — a menu the user has to aim at in
   * order to dismiss is worse than no menu. Capture phase, so a press that
   * lands on something interactive still closes the menu first.
   */
  private _listen(on: boolean): void {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', this._onDocumentPointerDown, true);
    document[method]('keydown', this._onDocumentKeyDown, true);
  }

  private readonly _onDocumentPointerDown = (event: Event) => {
    // A press *on* the menu is how a row gets chosen, so only presses that miss
    // it dismiss. `composedPath` is what sees through the shadow boundary.
    if (event.composedPath().includes(this)) return;
    // The dismissing press is **swallowed**, as it is for a native menu: it
    // lands on the labeling surface, where the editor would otherwise read it
    // as a click and place a calibration point behind the menu the user was
    // only trying to close. Stopping it in the capture phase is what keeps it
    // from ever reaching the viewer.
    event.stopPropagation();
    event.preventDefault();
    this.hide();
  };

  private readonly _onDocumentKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Escape') return;
    // **Swallowed**, exactly as the dismissing press is: Escape also means
    // "zoom to fit" in the editor (#44), and one keystroke that closed a menu
    // must not also move the view underneath it. It has to be stopped rather
    // than merely raced — this listener is on the document in the capture
    // phase, so by the time a listener further out could ask whether a menu is
    // open, `hide()` has already answered no.
    event.stopPropagation();
    this.hide();
  };

  /**
   * `sl-menu` reports the chosen element; the editor wants the id.
   *
   * A nested menu's selection bubbles through this same listener, so the
   * already-closed check is what keeps **one click one selection**: a second
   * report of the same click would be a second history entry for one gesture.
   */
  private _onSelect(event: CustomEvent<{ item: SlMenuItem }>): void {
    if (!this._at) return;
    const id = event.detail.item?.value;
    this.hide();
    if (!id) return;
    this.dispatchEvent(
      new CustomEvent<ContextMenuSelectDetail>('rr-context-menu-select', {
        detail: { id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Places the menu, clamped so it stays inside the window.
   *
   * The measurement happens here rather than in `show()` because the size is
   * only known once the rows are rendered, and the result is written to the
   * style directly rather than through reactive state, which would re-enter
   * this update. `clampToViewport` is in `geometry.ts` so it is covered by a
   * test; with an unmeasured menu — jsdom, where every rect is zero — it is the
   * identity, and the menu simply lands at the cursor.
   */
  protected updated(): void {
    const at = this._at;
    if (!at || !this._menu) return;

    const { width, height } = this._menu.getBoundingClientRect();
    const placed = clampToViewport(
      at,
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
      VIEWPORT_MARGIN_PX
    );

    this.style.setProperty('--menu-x', `${placed.x}px`);
    this.style.setProperty('--menu-y', `${placed.y}px`);
  }

  /**
   * One row, and the submenu under it when it has children.
   *
   * A row with children carries **no `value`**: it is opened rather than
   * chosen, and a value would let a stray selection report an id that names no
   * verb. `data-id` carries the id regardless, so a row is still addressable —
   * by a test, and by anything that needs to find the row it rendered.
   */
  private _renderItem(item: ContextMenuItem): TemplateResult {
    const children = item.items ?? [];
    if (children.length === 0) {
      return html`<sl-menu-item data-id=${item.id} value=${item.id}>${item.label}</sl-menu-item>`;
    }

    return html`<sl-menu-item data-id=${item.id}>
      ${item.label}
      <sl-menu slot="submenu">${children.map(child => this._renderItem(child))}</sl-menu>
    </sl-menu-item>`;
  }

  render() {
    if (!this._at) return html``;

    return html`
      <sl-menu @sl-select=${this._onSelect}>${this._items.map(item => this._renderItem(item))}</sl-menu>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-context-menu': RRContextMenu;
  }

  interface HTMLElementEventMap {
    'rr-context-menu-select': CustomEvent<ContextMenuSelectDetail>;
  }
}
