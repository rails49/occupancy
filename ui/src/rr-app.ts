import { LitElement, html, css, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { R49Archive, MANIFEST_VERSION, type Layout, type ManifestData } from '@rails49/r49';
import '@rails49/look';
import '@rails49/look/look.css';
import { lookTheme, type LookPressDetail, type LookViewDetail } from '@rails49/look';
import { missingLayoutMetadata } from './requiredMetadata.js';
import { EditSession, type LayoutSettings } from './editSession.js';
import { revealTarget, type HistoryEntry } from './history.js';
import { openArchive, supportsFileSystemAccess, writeArchive, type FileBinding } from './persistence.js';
// Shared with the diagnostics queue, which binds bare keys to `window` too —
// see `keyboard.ts` for why the rule has one home.
import { isInsideOpenDialog, isTypingTarget } from './keyboard.js';
import { GATE_REASON, TOOLS } from './tools.js';
import { addPrepared, captureFilename } from './imageAdd.js';
import { LIVE_BASE, archiveBase, findService, readEtag } from './liveContract.js';
import { occupancyService } from './occupancyService.js';
import type { LiveSources } from './liveSources.js';
import './rr-editor-view.js';
import type { NotifyDetail } from './rr-editor-view.js';
import './rr-live-view.js';
import type { FrameAddDetail } from './rr-live-view.js';
import './rr-diagnostics-view.js';
import './rr-settings-dialog.js';
import type { RRSettingsDialog } from './rr-settings-dialog.js';
import './rr-discard-dialog.js';
import type { RRDiscardDialog } from './rr-discard-dialog.js';
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import '@shoelace-style/shoelace/dist/components/alert/alert.js';
import type SlAlert from '@shoelace-style/shoelace/dist/components/alert/alert.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';

// Set the base path for Shoelace assets (icons, etc.)
setBasePath('/shoelace');

/**
 * The three things the app can be doing: the rail's views, each one click away
 * (#87), with the current one marked.
 */
const VIEW_MODES = [
  { mode: 'editor', icon: 'image-fill', label: 'Label' },
  { mode: 'live', icon: 'camera-video-fill', label: 'Live' },
  { mode: 'diagnostics', icon: 'clipboard-data', label: 'Diagnostics' },
] as const;

export type ViewMode = (typeof VIEW_MODES)[number]['mode'];

/**
 * Save As is advertised only where it does something Save does not. Without
 * the File System Access API every save is a fresh download, so naming the
 * modifier there would promise a distinction the browser cannot make.
 */
function saveLabel(): string {
  return supportsFileSystemAccess()
    ? 'Save .r49 Archive (Shift-click: Save As…)'
    : 'Save .r49 Archive';
}

/**
 * Top-level application shell: look's band and rail around the current view.
 */
@customElement('rr-app')
export class RRApp extends LitElement {
  /** The archive being edited, with its rules and history; one per New or Open. */
  @state() private _session: EditSession | null = null;
  @state() private _viewMode: ViewMode = 'editor';

  @query('rr-settings-dialog') private _settingsDialog!: RRSettingsDialog;
  @query('rr-discard-dialog') private _discardDialog!: RRDiscardDialog;

  /**
   * Where this session writes back to, or null for a layout that has never
   * been saved (#48).
   *
   * A binding carrying a service writes to the occupancy service it was opened
   * from (#333); one carrying a handle makes Save an overwrite; one with
   * neither makes it a timestamped download; null means the stem is not decided
   * yet and comes from `layout.name` at the moment of saving. New clears it —
   * the new archive is emphatically not the file that was open — and Save As
   * re-points it.
   */
  @state() private _binding: FileBinding | null = null;

  /**
   * Whether a save is running (#333).
   *
   * A save is no longer instant: writing to an occupancy service is several
   * requests over the network. A Save pressed while one is in flight does
   * nothing rather than starting a second pass over the same files.
   */
  private _saving = false;

  /**
   * The frame id of the last Freeze this acted on, or `null` before the first
   * (#334).
   *
   * A second press on one frame adds nothing: the picture has not changed, so
   * the second add would be a duplicate photograph of the same moment under a
   * second generated name. Recorded whatever the add then did — a frame this
   * page refused is refused again for the same reason, and saying so twice
   * would be the same toast twice.
   */
  private _frozenId: string | null = null;

  /**
   * Whether a Freeze is being added (#334).
   *
   * A press while one is running does nothing, for the reason a second Save
   * does nothing: the add reads the archive and writes it, and two at once
   * would interleave over one history entry.
   */
  private _freezing = false;

  /**
   * The occupancy service this origin serves, or `null` where there is none
   * (#331).
   *
   * Looked for once, at page start, and handed to the live view as both of
   * its sources. The page still opens in the editor; this only decides what
   * Live shows when the person presses it.
   */
  @state() private _service: LiveSources | null = null;
  /**
   * Whether an archive of the person's own has taken over.
   *
   * New, Open and a Save As that lands in a file leave the service behind
   * (#333). This also ignores a service check that answers after that.
   */
  private _leftService = false;

  static styles = [
    lookTheme,
    css`
      :host {
        display: block;
        background: var(--sl-color-neutral-0);
        color: var(--sl-color-neutral-900);
      }

      main {
        display: flex;
        height: 100%;
        overflow: hidden;
      }
    `,
  ];

  /** Shows `message`, as text, in a Shoelace `sl-alert` toast (#264). */
  private _notify(message: string, variant: 'primary' | 'success' | 'danger' | 'warning' = 'primary', icon = 'info-circle', duration = 3000) {
    const alert = this._alert(message, variant, icon, duration);
    return alert.toast();
  }

  /**
   * A toast that stays up until the returned function closes it — what a save
   * in flight shows (#333).
   *
   * Separate from {@link _notify} because a toast with no duration has to be
   * closed by whoever put it up, and {@link _notify}'s callers do not keep it.
   */
  private _progress(message: string): () => void {
    const alert = this._alert(message, 'primary', 'hourglass-split', Infinity);
    void alert.toast();
    return () => void alert.hide();
  }

  /** The `sl-alert` both of those show. */
  private _alert(
    message: string,
    variant: 'primary' | 'success' | 'danger' | 'warning',
    icon: string,
    duration: number
  ): SlAlert {
    const alert = Object.assign(document.createElement('sl-alert'), { variant, closable: true, duration });
    const iconEl = Object.assign(document.createElement('sl-icon'), { slot: 'icon', name: icon });
    alert.append(iconEl, message);
    this.renderRoot.appendChild(alert);
    return alert;
  }

  /**
   * A child's transient message, toasted here because this is where toasts
   * live.
   *
   * `warning` rather than `danger`: everything that reaches this event is the
   * editor **declining** to author something, which is the editor working. A
   * red alert for a refused click would read as a failure the user has to fix.
   *
   * It stays up until the user closes it (#265), or for the detail's
   * `duration` when it gives one.
   */
  private _onNotify(e: CustomEvent<NotifyDetail>) {
    this._notify(e.detail.message, 'warning', 'exclamation-triangle', e.detail.duration ?? Infinity);
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('beforeunload', this._onBeforeUnload);
    void this._lookForService();
  }

  /**
   * Ask whether this origin serves an occupancy service and, where it does,
   * watch it and open the archive it serves (#331, #333).
   *
   * No toast where there is none: only a 2xx with a JSON content type is a
   * service, and any other answer — the cloud copy's own HTML, a 404, a
   * network failure — leaves the page exactly as it has always been.
   *
   * The manifest's **`ETag` is read before the archive loads**, from the answer
   * the check already has, and `R49Archive.load` reads the manifest again. A
   * save landing between the two therefore leaves this page holding the older
   * version, and this page's first save is refused rather than overwriting
   * somebody's work — which is the right way round. An answer with no `ETag` is
   * a service serving the archive read-only, and it opens that way.
   *
   * There is no command for any of this and no re-read: a newer copy is one
   * page reload away. An archive the person opened or created first wins, here
   * and after either await.
   */
  private async _lookForService() {
    const found = await findService();
    if (found === null || this._taken()) return;
    const etag = readEtag(found);
    const service = occupancyService();
    this._service = { frames: service, results: service, service: true };

    let archive: R49Archive;
    try {
      // The base URL, not bytes: the manifest comes now and each image when
      // something asks for it.
      archive = await R49Archive.load(archiveBase(LIVE_BASE));
    } catch (err) {
      console.error('Failed to load the archive on the occupancy service', err);
      this._notify(`Load failed: ${String(err)}`, 'danger', 'exclamation-octagon');
      return;
    }
    if (this._taken()) return;
    this._open(archive, { keepService: true });
    this._binding = { stem: '', service: { base: LIVE_BASE, etag } };
    this._notify('Opened the archive on the occupancy service', 'success', 'file-earmark-check');
  }

  /** Whether an archive of the person's own has already taken this page over. */
  private _taken(): boolean {
    return this._leftService || this._session !== null;
  }

  /**
   * Stop watching the service, for good.
   *
   * Only a reload finds it again. `_leftService` also ignores an answer still
   * in flight from `_lookForService`.
   */
  private _leaveService() {
    this._leftService = true;
    this._service = null;
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    super.disconnectedCallback();
  }

  /**
   * The third act undo cannot cover: closing or reloading the tab (#49).
   *
   * `_confirmDiscard()` is not shared — it waits on `rr-discard-dialog`, which
   * this cannot do. All `beforeunload` may do is
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
    if (!this._session?.history.isDirty) return;
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
   * Cmd/Ctrl+Z and Cmd+Shift+Z / Ctrl+Y, and Cmd/Ctrl+S and Cmd/Ctrl+Shift+S
   * for Save and Save As, editor view only.
   *
   * The rail's Undo and Redo are not a duplicate of this: they carry the
   * disabled state, which is the only honest signal that the stack has a
   * bottom, and touch devices have no Cmd+Z at all.
   *
   * Save cancels the browser's Save Page everywhere in the editor, a field
   * included, but saves nothing from inside an open dialog or on a key repeat
   * (#326).
   */
  private _onKeyDown = async (event: KeyboardEvent) => {
    if (this._viewMode !== 'editor' || !this._session) return;
    if (!event.metaKey && !event.ctrlKey) return;

    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      if (event.repeat || isInsideOpenDialog(event)) return;
      await this._onFileSave(event.shiftKey);
      return;
    }
    if (isTypingTarget(event)) return;

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      await this._undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      await this._redo();
    }
  };

  /** Undo and redo, which select the image they change. See `EditSession.undo`. */
  private async _undo() {
    await this._session?.undo();
  }

  private async _redo() {
    await this._session?.redo();
  }

  /**
   * Starts editing `archive`, dropping the previous session and its history.
   *
   * New and Open leave an occupancy service behind (#331); the archive the
   * service itself serves keeps it, and the live view goes on showing that
   * service for as long as the archive is bound to it (#333). A cancelled New
   * or Open opens nothing and reaches neither this nor `_leaveService`.
   */
  private _open(archive: R49Archive, options: { keepService?: boolean } = {}) {
    this._session = new EditSession(archive);
    this._session.subscribe(() => this.requestUpdate());
    if (!options.keepService) this._leaveService();
  }

  /**
   * Guards the two acts undo structurally cannot cover: New and Open replace
   * the archive, and the stack goes with it. Resolves true to go ahead: the
   * changes were discarded, or saved. A save that is cancelled or fails stops.
   */
  private async _confirmDiscard(): Promise<boolean> {
    if (!this._session?.history.isDirty) return true;
    switch (await this._discardDialog.ask()) {
      case 'cancel':
        return false;
      case 'discard':
        return true;
      case 'save':
        await this._onFileSave();
        return !this._session?.history.isDirty;
    }
  }

  private async _onFileNew() {
    if (!(await this._confirmDiscard())) return;
    const archive = new R49Archive();
    archive.setManifest({
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
    this._open(archive);
    this._binding = null;
    this._viewMode = 'editor';
  }

  private async _onFileOpen() {
    if (!(await this._confirmDiscard())) return;
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
      this._notify(`Loading ${file.name}…`, 'primary', 'hourglass-split');
      this._open(await R49Archive.load(file));
      // Bound only once the bytes parse. A binding to a file that failed to
      // load would aim the next Save at an archive this session never held.
      this._binding = binding;
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
   * Save, and Save As when the rail reports a Shift-click (#48).
   *
   * Where the work lands is `persistence.ts`'s decision, not this component's:
   * the occupancy service the archive was opened from (#333), an overwrite
   * where the browser has a handle for it, or a timestamped download. All three
   * count as saved — the download did write a file, and refusing to mark it
   * would leave the phone permanently dirty.
   *
   * The archive goes down rather than its bytes, because the service route
   * writes the files that changed and never an archive.
   *
   * **The history position is taken before the first request** and that
   * position is what is marked saved, so an edit made while the save was in
   * flight leaves the archive dirty: it is not in what went. A Save pressed
   * while one is running does nothing, and a toast stays up while it runs.
   *
   * **A New or an Open answered while the save ran takes the binding** — the
   * outcome is applied only while `_session` is still the session that was
   * saved (#354). The toast stands either way: the write did land. Marking the
   * replaced session's history saved changes nothing anybody can see, since
   * its stack went with it.
   *
   * A refusal leaves everything where it was — dirty, and still bound to the
   * service — and says what the service said. This page does not fall back to a
   * file by itself, and it merges nothing.
   *
   * The stem is the binding's, falling back to `layout.name` for an archive
   * that has never been saved, which is every archive on a service. It does not
   * follow a later rename: the file's identity is the file, and `layout.name`
   * is metadata stored inside it.
   */
  private async _onFileSave(rebind = false) {
    const session = this._session;
    if (!session || this._saving) return;
    this._saving = true;
    const position = session.history.position;
    const done = this._progress('Saving…');
    try {
      const stem = this._binding?.stem || session.archive.getManifest().layout.name || 'layout';
      const outcome = await writeArchive(
        session.archive,
        { ...this._binding, stem },
        { rebind, notice: message => this._notify(message, 'warning', 'exclamation-triangle') }
      );
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'refused') {
        // Up until it is closed: a refusal the person has to answer with Save
        // As must not vanish after three seconds.
        this._notify(outcome.message, 'danger', 'exclamation-diamond', Infinity);
        return;
      }

      // The outcome belongs to the session that was saved, and a service save
      // is several requests: New or Open answered while they were in flight
      // replaced that session, and nothing holds either shut (#354). Binding
      // the archive that replaced it would aim the next Save at the file — or
      // the service — this one wrote, with an archive it never held, so the
      // next Save to a service puts an empty manifest there and the service
      // deletes every image the real layout named. `rr-editor-view` asks the
      // same question after each of its awaits.
      if (this._session === session) {
        // A save that landed in a file takes the work off the service, and the
        // live view goes back to the camera and the model in this page (#333).
        if (this._binding?.service && !outcome.binding.service) this._leaveService();
        this._binding = outcome.binding;
      }
      // Saving marks the position rather than clearing the stack: what was
      // written is unaffected by anything undone afterwards, so undoing past a
      // save stays legitimate. The marker is what `isDirty` is measured from.
      session.history.markSaved(position);
      // The verb is half the message: writing back to the service, overwriting
      // `west-yard.r49` and dropping a new `west-yard-20260802-1432.r49` into
      // Downloads are different enough that "Saved" would hide which one just
      // happened.
      if (outcome.kind === 'served') {
        this._notify('Saved to the occupancy service', 'success', 'floppy');
      } else if (outcome.kind === 'wrote') {
        this._notify(`Saved ${outcome.filename}`, 'success', 'floppy');
      } else {
        this._notify(`Downloaded ${outcome.filename}`, 'success', 'download');
      }
      this.requestUpdate();
    } catch (err) {
      console.error('Failed to save archive', err);
      this._notify(`Save failed: ${String(err)}`, 'danger', 'exclamation-diamond');
    } finally {
      this._saving = false;
      done();
    }
  }

  /**
   * Freeze: the frame the live view had on screen, added to the archive (#334).
   *
   * It takes the editor's path exactly — `imageAdd.ts`'s `addPrepared`, so the
   * orientation tag, the two refusals and the single history entry are the
   * ones a picked file gets — and it is **one history entry and no save**. The
   * person goes to the editor, where undo removes it and Save writes it; the
   * live view has neither, and what it draws does not change until that save,
   * because it draws the service's own manifest (#331).
   *
   * The toast names the file and where to save it, because a frame added with
   * no visible result is indistinguishable from a button that did nothing. A
   * refusal is the warning toast the editor's refusals get, in the same words.
   */
  private async _onFrameAdd(e: CustomEvent<FrameAddDetail>) {
    const session = this._session;
    const { bytes, frameId } = e.detail;
    if (this._freezing || frameId === this._frozenId) return;
    if (!session) {
      // A service whose manifest would not load leaves the live view watching
      // it with nothing open to add to. Silence would read as a dead button.
      this._notify(
        'No layout is open, so the frame was not added.',
        'warning',
        'exclamation-triangle',
        Infinity
      );
      return;
    }
    this._freezing = true;
    this._frozenId = frameId;
    try {
      const filename = captureFilename();
      const refusal = await addPrepared(
        session,
        filename,
        filename,
        new Uint8Array(await bytes.arrayBuffer())
      );
      if (refusal) {
        this._notify(refusal, 'warning', 'exclamation-triangle', Infinity);
        return;
      }
      this._notify(`Added ${filename} — save it in the editor`, 'success', 'file-earmark-plus');
    } catch (err) {
      console.error('Failed to add the frame on screen', err);
      this._notify(`Add failed: ${String(err)}`, 'danger', 'exclamation-octagon');
    } finally {
      this._freezing = false;
    }
  }

  private _onViewChange(e: CustomEvent<LookViewDetail>) {
    this._viewMode = e.detail.name as ViewMode;
  }

  /** The settings dialog's edits. */
  private async _onLayoutChange(e: CustomEvent<{ layout: LayoutSettings }>) {
    await this._session?.editLayout(e.detail.layout);
  }

  private async _onCameraHeightChange(e: CustomEvent<{ camera_height_mm: number | undefined }>) {
    await this._session?.setCameraHeight(e.detail.camera_height_mm);
  }

  /**
   * An edit's phrase, qualified with the image when it is not the one on
   * screen — "delete car — img_3.jpg".
   *
   * The disabled state says the stack has a bottom; this says *where* the next
   * undo will land. Without it "nothing happened" and "it happened on an image
   * you are not looking at" read identically, which is the whole reason the
   * buttons are not a duplicate of Cmd+Z (`SPEC.md` § Undo and redo) — and on a
   * touch device, where the labeling actually happens, there is no Cmd+Z to be
   * a duplicate of.
   */
  private _qualified(verb: string, label: string | null, entry: HistoryEntry | null): string {
    if (!label) return verb;
    const image = revealTarget(entry);
    return image && image !== this._session?.image?.filename
      ? `${verb} ${label} — ${image}`
      : `${verb} ${label}`;
  }

  /**
   * The band: the UI name, the layout's name and scale, and where a save would
   * land.
   *
   * With no archive open there is no `look-about`: it would repeat the UI
   * name. The scale is what the layout's geometry means (#52). The
   * `look-reading` is shown only where Save writes over something that exists:
   * the bound filename where there is a handle, and the occupancy service where
   * the archive came from one and it took an `ETag` (#333). The question "where
   * does my work go?" is asked before the click, and a toast answers it only
   * afterwards — and a binding that names nothing writable stays quiet, which a
   * read-only service and a download both are.
   */
  private _renderBand(layout: Layout | null) {
    return html`<look-band ui="occupancy">
      ${layout
        ? html`<look-about name=${layout.name ?? ''} detail=${layout.scale}></look-about>`
        : nothing}
      ${this._binding?.service?.etag
        ? html`<look-reading>occupancy service</look-reading>`
        : this._binding?.handle
          ? html`<look-reading>${this._binding.stem}.r49</look-reading>`
          : nothing}
      <look-gear @look-press=${() => this._settingsDialog.show()}></look-gear>
    </look-band>`;
  }

  /** The rail: the views, then the editor's commands while it is shown. */
  private _renderRail() {
    return html`<look-rail @look-view=${this._onViewChange}>
      ${VIEW_MODES.map(
        ({ mode, icon, label }) => html`<look-view
          name=${mode}
          icon=${icon}
          label=${label}
          ?current=${this._viewMode === mode}
        ></look-view>`
      )}
      ${this._viewMode === 'editor' ? this._renderEditorGroups() : nothing}
    </look-rail>`;
  }

  /**
   * File, History and, while a manifest is loaded, Tools.
   *
   * **While DPT is unresolved the labeling tools are disabled and the reason
   * is their tooltip** — car width is derived from DPT rather than stored
   * (`SPEC.md` § Location Data), so an uncalibrated archive cannot render the
   * width rectangle that is the only feedback telling a user whether their
   * clicks cover the car. The gate is on **existence, never on completion**
   * (`SPEC.md` § Labeling Workflow), and the editor enforces it too.
   */
  private _renderEditorGroups() {
    const session = this._session;
    return html`
      <look-group label="File">
        <look-command
          id="file-new"
          icon="file-earmark-plus"
          label="New .r49 Archive"
          @look-press=${this._onFileNew}
        ></look-command>
        <look-command
          id="file-open"
          icon="folder2-open"
          label="Open .r49 Archive"
          @look-press=${this._onFileOpen}
        ></look-command>
        <look-command
          id="file-save"
          icon="floppy"
          label=${saveLabel()}
          key="Mod+S"
          @look-press=${(e: CustomEvent<LookPressDetail>) => this._onFileSave(e.detail.shiftKey)}
        ></look-command>
      </look-group>
      <look-group label="History">
        <look-command
          id="edit-undo"
          icon="arrow-counterclockwise"
          label=${this._qualified('Undo', session?.history.undoLabel ?? null, session?.history.undoEntry ?? null)}
          key="Mod+Z"
          ?disabled=${!session?.history.canUndo}
          @look-press=${this._undo}
        ></look-command>
        <look-command
          id="edit-redo"
          icon="arrow-clockwise"
          label=${this._qualified('Redo', session?.history.redoLabel ?? null, session?.history.redoEntry ?? null)}
          key="Shift+Mod+Z"
          ?disabled=${!session?.history.canRedo}
          @look-press=${this._redo}
        ></look-command>
      </look-group>
      ${session
        ? html`<look-group label="Tools">
            ${TOOLS.map(spec => {
              const disabled = spec.needsDpt && !session.calibrated;
              return html`<look-command
                id="tool-${spec.tool}"
                icon=${spec.icon}
                label=${spec.label}
                ?pressed=${spec.tool === session.tool}
                ?disabled=${disabled}
                reason=${disabled ? GATE_REASON : ''}
                @look-press=${() => session.selectTool(spec.tool)}
              ></look-command>`;
            })}
          </look-group>`
        : nothing}
    `;
  }

  render() {
    // Null until a manifest has actually been read (#52).
    let manifest: ManifestData | null = null;
    try {
      if (this._session) manifest = this._session.archive.getManifest();
    } catch (e) {
      // Ignore if manifest not yet ready
    }
    const layout: Layout | null = manifest?.layout ?? null;

    return html`
      <look-shell>
        ${this._renderBand(layout)} ${this._renderRail()}
        <main>
          ${this._viewMode === 'editor'
            ? html`
                <rr-editor-view
                  .session=${this._session}
                  @rr-notify=${this._onNotify}
                ></rr-editor-view>`
            : this._viewMode === 'live'
              ? html`<rr-live-view
                  .archive=${this._session?.archive ?? null}
                  .sources=${this._service}
                  @rr-frame-add=${this._onFrameAdd}
                ></rr-live-view>`
              // Each mode is torn down when it leaves: the live view stops the
              // camera, the diagnostics view abandons an in-flight sweep and
              // releases its ORT session. Keeping them alive to preserve state
              // would leave a camera light on, or twenty seconds of WASM running
              // for a view nobody is looking at.
              : html`<rr-diagnostics-view .archive=${this._session?.archive ?? null}></rr-diagnostics-view>`
          }
        </main>
      </look-shell>

      <rr-discard-dialog></rr-discard-dialog>

      <!-- The placeholder layout is for the dialog to render against, not an
           answer any archive gave. -->
      <rr-settings-dialog
        .layout=${layout ?? { name: '', scale: 'N', calibration: { points: [] } }}
        .requiredMissing=${missingLayoutMetadata(manifest)}
        @rr-layout-change=${this._onLayoutChange}
        @rr-camera-height-change=${this._onCameraHeightChange}
      ></rr-settings-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-app': RRApp;
  }
}
