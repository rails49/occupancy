import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { R49Archive, MANIFEST_VERSION, type Layout } from '@occupancy/r49';
import { missingLayoutMetadata } from './requiredMetadata.js';
import { EditHistory, revealTarget, type HistoryEntry } from './history.js';
import { openArchive, writeArchive, type FileBinding } from './persistence.js';
// Shared with the diagnostics queue, which binds bare keys to `window` too —
// see `keyboard.ts` for why the rule has one home.
import { isTypingTarget } from './keyboard.js';
import './rr-header.js';
import type { ViewMode } from './rr-header.js';
import './rr-editor-view.js';
import type { NotifyDetail, RREditorView } from './rr-editor-view.js';
import './rr-live-view.js';
import './rr-diagnostics-view.js';
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import '@shoelace-style/shoelace/dist/components/alert/alert.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';

// Set the base path for Shoelace assets (icons, etc.)
setBasePath('/shoelace');

/**
 * Top-level application shell.
 */
@customElement('rr-app')
export class RRApp extends LitElement {
  @state() private _archive: R49Archive | null = null;
  @state() private _viewMode: ViewMode = 'editor';
  @state() private _status = 'No archive loaded';

  /**
   * The file this session writes back to, or null for a layout that has never
   * been saved (#48).
   *
   * A binding carrying a handle makes Save an overwrite; one without makes it a
   * timestamped download; null means the stem is not decided yet and comes from
   * `layout.name` at the moment of saving. New clears it — the new archive is
   * emphatically not the file that was open — and Save As re-points it.
   */
  @state() private _binding: FileBinding | null = null;

  /**
   * The editor's undo stack. Owned here because the archive is owned here, and
   * passed down; see `history.ts` for why it is not part of `@occupancy/r49`.
   */
  private _history = new EditHistory();

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      background: var(--sl-color-neutral-0);
      color: var(--sl-color-neutral-900);
    }

    main {
      flex-grow: 1;
      display: flex;
      overflow: hidden;
    }

    /* Slotted into rr-header, so these are styled here — the slot's content is
       this component's DOM. Lighter than the layout name: each qualifies the
       name rather than competing with it. */
    .bound-file,
    .layout-scale {
      font-weight: 400;
      opacity: 0.75;
    }
  `;

  /**
   * Helper to show a toast notification using Shoelace sl-alert
   */
  private _notify(message: string, variant: 'primary' | 'success' | 'danger' | 'warning' = 'primary', icon = 'info-circle', duration = 3000) {
    const alert = Object.assign(document.createElement('sl-alert'), {
      variant,
      closable: true,
      duration,
      innerHTML: `
        <sl-icon slot="icon" name="${icon}"></sl-icon>
        ${message}
      `
    });
    this.renderRoot.appendChild(alert);
    return (alert as any).toast();
  }

  /**
   * A child's transient message, toasted here because this is where toasts
   * live.
   *
   * `warning` rather than `danger`: everything that reaches this event is the
   * editor **declining** to author something, which is the editor working. A
   * red alert for a refused click would read as a failure the user has to fix.
   */
  private _onNotify(e: CustomEvent<NotifyDetail>) {
    this._notify(e.detail.message, 'warning', 'exclamation-triangle');
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('beforeunload', this._onBeforeUnload);
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    super.disconnectedCallback();
  }

  /**
   * The third act undo cannot cover: closing or reloading the tab (#49).
   *
   * `_confirmDiscard()` is not shared — it answers with a boolean out of
   * `window.confirm`, which this cannot use. All `beforeunload` may do is
   * cancel and let the browser ask, in wording nobody can set. That generic
   * dialog is accepted on the cost asymmetry `SPEC.md` § Undo and redo states:
   * one extra click on a deliberate close, against a whole hand-labeling
   * session, since the history is never persisted and there is no autosave.
   *
   * Registration is permanent and the predicate checked here, at fire time —
   * `EditHistory` does not expose `isDirty`'s edges to add and remove on, and
   * the bfcache eligibility that would buy is worthless in an app with no
   * back-navigation to restore.
   */
  private _onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!this._history.isDirty) return;
    event.preventDefault();
    // The legacy property stays alongside `preventDefault()` deliberately: the
    // engines converged on the modern form at different times, and one still
    // gating on `returnValue` would leave this guard silently inert in exactly
    // the situation it exists for, with nothing to surface it. It is set
    // **truthy, not `''`** — the legacy gate gives the dialog only when
    // `returnValue` is *non-empty*, so the empty string is the value that means
    // "do not ask" and would be the inert guard this line exists to prevent.
    event.returnValue = true;
  };

  /**
   * Cmd/Ctrl+Z and Cmd+Shift+Z / Ctrl+Y, editor view only.
   *
   * The buttons in `rr-toolbar` are not a duplicate of this: they carry the
   * disabled state, which is the only honest signal that the stack has a
   * bottom, and touch devices have no Cmd+Z at all.
   */
  private _onKeyDown = async (event: KeyboardEvent) => {
    if (this._viewMode !== 'editor' || !this._archive) return;
    if (!event.metaKey && !event.ctrlKey) return;
    if (isTypingTarget(event)) return;

    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      await this._undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      await this._redo();
    }
  };

  /**
   * Undo, offered to the editor before it reaches the stack.
   *
   * The editor owns one state undo means something else in — a live chain,
   * which is **a wall undo cannot cross** (`SPEC.md` § Undo and redo) — and
   * this component owns undo and cannot see it. So the protocol is one
   * question, asked here rather than a state pushed up: whatever the chain
   * consumes it handles in full, stack included.
   */
  private async _undo() {
    if (await this._editorView()?.interceptUndo()) {
      this.requestUpdate();
      return;
    }
    // Before the snapshot lands, not after — see {@link _reveal}.
    this._editorView()?.selectImage(revealTarget(this._history.undoEntry));
    const entry = await this._history.undo();
    if (entry) await this._reveal(entry);
  }

  private async _redo() {
    this._editorView()?.selectImage(revealTarget(this._history.redoEntry));
    const entry = await this._history.redo();
    if (entry) await this._reveal(entry);
  }

  /**
   * The navigation invariant: undo may move the user, but it may never change
   * something they cannot see (`SPEC.md` § Undo and redo).
   *
   * Three steps, in this order: **select** the image the entry targets, which
   * the caller has already done from the *pending* entry; **apply**, which the
   * stack does; and **highlight** what changed, here. Selecting first means the
   * snapshot never lands while the editor's own state still points at the frame
   * the user is leaving. What it does *not* buy is an intermediate paint — Lit
   * batches the selection and the apply into one update — so the highlight, not
   * the ordering, is what actually shows the user what moved.
   *
   * The highlight is object-level (#37) and resolved by the editor, because
   * only it knows which image is on screen. What the entry changed is diffed
   * out of its own snapshots, so a gesture that moved two cars lights both and
   * an undone *add* lights nothing at all.
   */
  private async _reveal(entry: HistoryEntry) {
    const view = this._editorView();
    await view?.syncFromArchive(revealTarget(entry), entry.highlights);
    if (this._archive) {
      this._status = this._archive.getManifest().layout.name || this._status;
    }
    this.requestUpdate();
  }

  /** The editor, or null in the live view, where it is not rendered. */
  private _editorView(): RREditorView | null {
    return this.renderRoot.querySelector('rr-editor-view');
  }

  /** Re-renders the undo affordances after a child records an edit. */
  private _onHistoryChange() {
    this.requestUpdate();
  }

  /**
   * Guards the two acts undo structurally cannot cover: New and Open replace
   * the archive, and the stack goes with it.
   */
  private _confirmDiscard(): boolean {
    if (!this._history.isDirty) return true;
    return window.confirm('Discard unsaved changes to this layout?');
  }

  private _onFileNew() {
    if (!this._confirmDiscard()) return;
    this._archive = new R49Archive();
    this._archive.setManifest({
      version: MANIFEST_VERSION,
      layout: {
        name: 'New Layout',
        scale: 'N',
        // Uncalibrated is a real state, expressed as an empty point list.
        calibration: { points: [] },
        sensors: []
      },
      camera: {
        resolution: { width: 1920, height: 1080 }
      },
      images: []
    });
    this._status = 'New Layout';
    this._binding = null;
    this._viewMode = 'editor';
    this._history.attach(this._archive);
  }

  private async _onFileOpen() {
    if (!this._confirmDiscard()) return;
    let opened;
    try {
      opened = await openArchive();
    } catch (err) {
      console.error('Failed to open archive', err);
      this._notify(`Open failed: ${String(err)}`, 'danger', 'exclamation-octagon');
      return;
    }
    if (!opened) return;

    const { file, binding } = opened;
    try {
      this._status = `Loading ${file.name}...`;
      this._archive = await R49Archive.load(file);
      this._history.attach(this._archive);
      // Bound only once the bytes parse. A binding to a file that failed to
      // load would aim the next Save at an archive this session never held.
      this._binding = binding;
      this._status = this._archive.getManifest().layout.name || file.name;
      this._notify(`Loaded ${file.name}`, 'success', 'file-earmark-check');
    } catch (err) {
      console.error('Failed to load archive', err);
      this._notify(`Load failed: ${String(err)}`, 'danger', 'exclamation-octagon');
    }
  }

  // Saving does not validate calibration. The v3 check read {p0, p1, size_mm}
  // structurally, which v4 does not have — calibration is a list of points that
  // legitimately starts empty, and "uncalibrated" is a state the format
  // expresses rather than an error to refuse a save over. The editor reports
  // DPT instead, and gating the labeling tools on it belongs to the editor
  // spec. See SPEC.md § Reference points.
  /**
   * Save, and Save As when the toolbar reports a Shift-click (#48).
   *
   * Where the bytes land is `persistence.ts`'s decision, not this component's:
   * an overwrite where the browser has a handle for it, a timestamped download
   * everywhere else. Both count as saved — the fallback did write a file, and
   * refusing to mark it would leave the phone permanently dirty.
   *
   * The stem is the binding's, falling back to `layout.name` for an archive
   * that has never been saved. It does not follow a later rename: the file's
   * identity is the file, and `layout.name` is metadata stored inside it.
   */
  private async _onFileSave(e?: CustomEvent<{ rebind?: boolean }>) {
    if (!this._archive) return;
    const rebind = e?.detail?.rebind === true;
    try {
      const data = await this._archive.export();
      const stem = this._binding?.stem || this._archive.getManifest().layout.name || 'layout';
      const outcome = await writeArchive(data, { ...this._binding, stem }, { rebind });
      if (outcome.kind === 'cancelled') return;

      this._binding = outcome.binding;
      // Saving marks the position rather than clearing the stack: the bytes on
      // disk are unaffected by anything undone afterwards, so undoing past a
      // save stays legitimate. The marker is what `isDirty` is measured from.
      this._history.markSaved();
      // The verb is half the message: overwriting `west-yard.r49` and dropping
      // a new `west-yard-20260802-1432.r49` into Downloads are different
      // enough that "Saved to disk" would hide which one just happened.
      if (outcome.kind === 'wrote') {
        this._notify(`Saved ${outcome.filename}`, 'success', 'floppy');
      } else {
        this._notify(`Downloaded ${outcome.filename}`, 'success', 'download');
      }
      this.requestUpdate();
    } catch (err) {
      console.error('Failed to save archive', err);
      this._notify(`Save failed: ${String(err)}`, 'danger', 'exclamation-diamond');
    }
  }

  private _onViewChange(e: CustomEvent<{ mode: ViewMode }>) {
    this._viewMode = e.detail.mode;
  }

  private async _onLayoutChange(e: CustomEvent) {
    if (!this._archive) return;
    const manifest = this._archive.getManifest();
    const field = Object.keys(e.detail.layout)[0] ?? 'layout';
    await this._history.record(`edit ${field}`, { kind: 'layout' }, () => {
      manifest.layout = { ...manifest.layout, ...e.detail.layout };
    });
    this._status = manifest.layout.name || this._status;
    this.requestUpdate();
  }

  /**
   * The camera height, applied where it lives. It arrives on its own event
   * rather than through `rr-layout-change` because it sits inside
   * `calibration`, and spreading that object in from the dialog would carry a
   * copy of `points` with it — stale the moment anything else edits them.
   *
   * `undefined` deletes the key rather than storing it: the schema is
   * `.optional()` and never `.default()`, so an absent height must stay absent
   * in the bytes (#139).
   */
  private async _onCameraHeightChange(e: CustomEvent<{ camera_height_mm: number | undefined }>) {
    if (!this._archive) return;
    const manifest = this._archive.getManifest();
    const height = e.detail.camera_height_mm;
    await this._history.record('edit camera height', { kind: 'layout' }, () => {
      const calibration = { ...manifest.layout.calibration };
      if (height === undefined) delete calibration.camera_height_mm;
      else calibration.camera_height_mm = height;
      manifest.layout = { ...manifest.layout, calibration };
    });
    this.requestUpdate();
  }

  render() {
    // Widened for the required-metadata gate, which reads `calibration` too.
    let layout: Layout = { name: '', scale: 'N', calibration: { points: [] }, sensors: [] };
    // Null until a manifest has actually been read (#52). The `N` above is a
    // placeholder for the dialog to render against, not an answer any archive
    // gave, so with nothing open the header states no scale rather than
    // inventing one. Read on every render, so a scale changed in the dialog is
    // the one shown.
    let scale: Layout['scale'] | null = null;
    try {
      if (this._archive) {
        layout = this._archive.getManifest().layout as any;
        scale = layout.scale;
      }
    } catch (e) {
      // Ignore if manifest not yet ready
    }

    return html`
      <rr-header
        .viewMode=${this._viewMode}
        .layout=${layout}
        .requiredMissing=${missingLayoutMetadata(this._archive ? layout : null)}
        @rr-view-change=${this._onViewChange}
        @rr-layout-change=${this._onLayoutChange}
        @rr-camera-height-change=${this._onCameraHeightChange}
      >
        <!-- Three things, each qualifying the one before: the layout's name,
             the scale its geometry is read in (#52, resolved above), and the
             file a save would land in. The bound filename is shown only when
             Save would overwrite it: the question "where does my work go?" is
             asked before the click, and a toast answers it only afterwards. A
             binding without a handle names no file that exists yet, so it
             stays quiet. -->
        <span slot="status"
          >${this._status}${scale ? html`<span class="layout-scale"> · ${scale}</span>` : ''}${this
            ._binding?.handle
            ? html`<span class="bound-file"> — ${this._binding.stem}.r49</span>`
            : ''}</span
        >
      </rr-header>

      <main>
        ${this._viewMode === 'editor'
          ? html`
              <rr-editor-view
                .archive=${this._archive}
                .history=${this._history}
                .canUndo=${this._history.canUndo}
                .canRedo=${this._history.canRedo}
                .undoLabel=${this._history.undoLabel}
                .redoLabel=${this._history.redoLabel}
                .undoImage=${revealTarget(this._history.undoEntry) ?? null}
                .redoImage=${revealTarget(this._history.redoEntry) ?? null}
                @rr-file-new=${this._onFileNew}
                @rr-file-open=${this._onFileOpen}
                @rr-file-save=${this._onFileSave}
                @rr-history-change=${this._onHistoryChange}
                @rr-notify=${this._onNotify}
                @rr-undo=${this._undo}
                @rr-redo=${this._redo}
              ></rr-editor-view>`
          : this._viewMode === 'live'
            ? html`<rr-live-view .archive=${this._archive}></rr-live-view>`
            // Each mode is torn down when it leaves: the live view stops the
            // camera, the diagnostics view abandons an in-flight sweep and
            // releases its ORT session. Keeping them alive to preserve state
            // would leave a camera light on, or twenty seconds of WASM running
            // for a view nobody is looking at.
            : html`<rr-diagnostics-view .archive=${this._archive}></rr-diagnostics-view>`
        }
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-app': RRApp;
  }
}
