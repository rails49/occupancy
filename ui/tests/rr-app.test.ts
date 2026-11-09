import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import '../src/rr-app.js';
import { RRApp } from '../src/rr-app.js';
import { R49Archive, getDPT } from '@rails49/r49';
import type { NotifyDetail } from '../src/rr-editor-view.js';
import type { EditHistory } from '../src/history.js';
import type { FileBinding } from '../src/persistence.js';
import type SlIcon from '@shoelace-style/shoelace/dist/components/icon/icon.js';

// Mock global fetch
global.fetch = vi.fn().mockResolvedValue({ ok: false });

describe('rr-app', () => {
  let archive: R49Archive;

  beforeEach(() => {
    archive = new R49Archive();
    archive.setManifest({
      version: 4,
      layout: { name: 'Test', scale: 'N', calibration: { points: [] }, sensors: [] },
      camera: { resolution: { width: 1920, height: 1080 } },
      images: []
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  // `fixture` does not tear down on its own under vitest, and `rr-app` listens
  // on `window`: a mounted-and-forgotten app from an earlier test answers the
  // `beforeunload` a later one dispatches.
  afterEach(fixtureCleanup);

  it('is defined', () => {
    const el = document.createElement('rr-app');
    expect(el).to.be.instanceOf(RRApp);
  });

  // Save no longer validates calibration. The v3 check read {p0, p1, size_mm}
  // structurally, which v4 does not have: calibration is a list of points that
  // legitimately starts empty, so "uncalibrated" is a state to report, not an
  // error to refuse a save over (#19, SPEC.md § Reference points).
  it('saves an uncalibrated archive without complaint', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._open(archive);

    const exportSpy = vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    const notifySpy = vi.spyOn(el as any, '_notify').mockImplementation(() => {});

    await (el as any)._onFileSave();

    expect(exportSpy).toHaveBeenCalled();
    // jsdom has no File System Access API, so this is the fallback path — the
    // one Safari and every phone take. The toast names the file because the
    // two paths land in different places (#48).
    expect(notifySpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Downloaded Test-\d{8}-\d{4}\.r49$/),
      'success',
      'download'
    );
  });

  // The stem is the file's identity, taken from the file that was opened. The
  // fallback binds no handle, so the layout name is only a starting point for
  // an archive that has never been saved.
  it('names the download after the opened file, not the layout', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._open(archive);
    (el as any)._binding = { stem: 'west-yard' };

    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    const notifySpy = vi.spyOn(el as any, '_notify').mockImplementation(() => {});

    await (el as any)._onFileSave();

    expect(notifySpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Downloaded west-yard-\d{8}-\d{4}\.r49$/),
      'success',
      'download'
    );
  });

  // A download did write a file. Refusing to mark it saved would leave a phone
  // permanently dirty and make the discard gate cry wolf on every New.
  it('marks the history saved on the fallback path', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._open(archive);
    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    const markSaved = vi.spyOn((el as any)._session.history as EditHistory, 'markSaved');

    await (el as any)._onFileSave();

    expect(markSaved).toHaveBeenCalled();
  });

  it('leaves the history dirty when the save picker is dismissed', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._open(archive);
    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    (window as any).showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException('dismissed', 'AbortError'));

    const markSaved = vi.spyOn((el as any)._session.history as EditHistory, 'markSaved');
    const notifySpy = vi.spyOn(el as any, '_notify').mockImplementation(() => {});

    await (el as any)._onFileSave();

    expect(markSaved).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    delete (window as any).showSaveFilePicker;
  });

  it('toasts a notice the editor sends up, kept until closed', async () => {
    // The editor states its refusals but owns no place to put them; toasts
    // live here. A refusal is a warning, never a danger — nothing failed.
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._open(archive);
    await el.updateComplete;
    const notify = vi.spyOn(el as any, '_notify').mockImplementation(() => {});

    el.renderRoot.querySelector('rr-editor-view')!.dispatchEvent(
      new CustomEvent<NotifyDetail>('rr-notify', {
        detail: { message: 'That pixel is already inside a labeled car' },
        bubbles: true,
        composed: true,
      })
    );

    expect(notify).toHaveBeenCalledWith(
      'That pixel is already inside a labeled car',
      'warning',
      'exclamation-triangle',
      Infinity
    );
  });

  describe('toasts show their message as text (#264)', () => {
    const MARKUP = '<img src=x onerror=alert(1)>';

    /** The alerts the app built; `toast()` is stubbed so each stays where it was appended. */
    async function mountWithToasts() {
      const toast = vi
        .spyOn(customElements.get('sl-alert')!.prototype, 'toast')
        .mockResolvedValue(undefined);
      onTestFinished(() => toast.mockRestore());
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      return { el, alerts: () => [...el.renderRoot.querySelectorAll('sl-alert')] };
    }

    it('shows an opened file name as literal text', async () => {
      const { el, alerts } = await mountWithToasts();
      const file = new File([], `${MARKUP}.r49`);
      (window as any).showOpenFilePicker = vi.fn().mockResolvedValue([{ getFile: async () => file }]);
      onTestFinished(() => {
        delete (window as any).showOpenFilePicker;
      });
      const load = vi.spyOn(R49Archive, 'load').mockResolvedValue(archive);
      onTestFinished(() => load.mockRestore());

      await (el as any)._onFileOpen();

      const [loading, loaded] = alerts();
      expect(loading.textContent!.trim()).toBe(`Loading ${MARKUP}.r49…`);
      expect(loading.querySelector('img')).toBeNull();
      expect(loading.variant).toBe('primary');
      expect(loading.closable).toBe(true);
      expect(loading.duration).toBe(3000);
      expect(loading.querySelector<SlIcon>('sl-icon[slot="icon"]')!.name).toBe('hourglass-split');
      expect(loaded.querySelector('img')).toBeNull();
    });

    it('shows a notice from a child as literal text', async () => {
      const { el, alerts } = await mountWithToasts();
      (el as any)._open(archive);
      await el.updateComplete;

      el.renderRoot.querySelector('rr-editor-view')!.dispatchEvent(
        new CustomEvent<NotifyDetail>('rr-notify', {
          detail: { message: MARKUP },
          bubbles: true,
          composed: true,
        })
      );

      const [alert] = alerts();
      expect(alert.textContent!.trim()).toBe(MARKUP);
      expect(alert.querySelector('img')).toBeNull();
      expect(alert.variant).toBe('warning');
      expect(alert.closable).toBe(true);
      expect(alert.duration).toBe(Infinity);
      expect(alert.querySelector<SlIcon>('sl-icon[slot="icon"]')!.name).toBe('exclamation-triangle');
    });
  });

  describe('undo and redo', () => {
    /** An app on an archive of two images, showing the first, with a car placed on the second. */
    async function mountWithEdit() {
      archive.setManifest({
        version: 4,
        layout: { name: 'Test', scale: 'N', calibration: { points: [] }, sensors: [] },
        camera: { resolution: { width: 1920, height: 1080 } },
        images: [
          { filename: 'img1.jpg', labeled_complete: false, labels: [] },
          { filename: 'img2.jpg', labeled_complete: false, labels: [] },
        ],
      });
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);
      const history = (el as any)._session.history as EditHistory;
      await history.record('place car', { kind: 'image', filename: 'img2.jpg' }, () => {
        archive.getManifest().images[1].labels = [
          {
            id: 'car-a',
            class: 'stock',
            provenance: 'human',
            p0: { x: 10, y: 10 },
            p1: { x: 200, y: 10 },
          },
        ];
      });
      el.requestUpdate();
      await el.updateComplete;
      const view = el.renderRoot.querySelector('rr-editor-view')!;
      await view.updateComplete;
      return { el, history, view };
    }

    const selectedIndex = (view: Element) =>
      view.shadowRoot!.querySelector('rr-thumbnail-bar')!.selectedIndex;

    it('shows the image an undo changed', async () => {
      const { el, history, view } = await mountWithEdit();

      await (el as any)._undo();
      await view.updateComplete;

      expect(archive.getManifest().images[1].labels).toEqual([]);
      expect(history.canRedo).toBe(true);
      expect(selectedIndex(view)).toBe(1);
    });

    it('highlights what a redo brought back', async () => {
      const { el, view } = await mountWithEdit();
      await (el as any)._undo();
      view.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index: 0 }, bubbles: true, composed: true })
      );

      await (el as any)._redo();
      await view.updateComplete;

      expect(selectedIndex(view)).toBe(1);
      expect(view.shadowRoot!.querySelector('rr-viewer')!.highlight).toEqual({
        cars: ['car-a'],
        sensors: [],
        calibration: [],
        trackClicks: [],
      });
    });
  });

  describe('settings edits', () => {
    /** An app on a calibrated archive, showing the editor. */
    async function mountCalibrated() {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
      ];
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);
      await el.updateComplete;
      const view = el.renderRoot.querySelector('rr-editor-view')!;
      await view.updateComplete;
      return { el, view };
    }

    const readout = (view: Element) => view.shadowRoot!.querySelector('.dpt-bar')!.textContent!;

    it('re-renders the editor after a scale edit, so the DPT readout follows', async () => {
      const { el, view } = await mountCalibrated();
      expect(readout(view)).toContain('DPT 89.7');

      el.renderRoot.querySelector('rr-settings-dialog')!.dispatchEvent(
        new CustomEvent('rr-layout-change', { detail: { layout: { scale: 'HO' } } })
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.updateComplete;

      expect(archive.getManifest().layout.scale).toBe('HO');
      expect(readout(view)).toContain(`DPT ${getDPT(archive.getManifest())!.toFixed(1)}`);
      expect(readout(view)).not.toContain('DPT 89.7');
    });

    it('re-renders the editor after a camera-height edit', async () => {
      // Points above the reference plane resolve DPT only once a camera height is known.
      const { el, view } = await mountCalibrated();
      for (const point of archive.getManifest().layout.calibration.points) point.world.z = 10;
      view.requestUpdate();
      await view.updateComplete;
      expect(readout(view)).toContain('Not calibrated');

      el.renderRoot.querySelector('rr-settings-dialog')!.dispatchEvent(
        new CustomEvent('rr-camera-height-change', { detail: { camera_height_mm: 1000 } })
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.updateComplete;

      expect(archive.getManifest().layout.calibration.camera_height_mm).toBe(1000);
      expect(readout(view)).toContain(`DPT ${getDPT(archive.getManifest())!.toFixed(1)}`);
    });
  });

  // These prove the listener is registered and reads `isDirty`, and nothing
  // more. No browser here renders a leave-site dialog — jsdom dispatches the
  // event and records `defaultPrevented`, exactly as the viewer's CTM stub and
  // the File System Access fakes prove routing rather than behaviour.
  describe('unsaved changes before New', () => {
    async function mountDirty() {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);
      const history = (el as any)._session.history as EditHistory;
      await history.record('rename layout', { kind: 'layout' }, () => {
        archive.getManifest().layout.name = 'Renamed';
      });
      return el;
    }

    function answer(el: RRApp, choice: 'save' | 'discard' | 'cancel') {
      return vi.spyOn((el as any)._discardDialog, 'ask').mockResolvedValue(choice);
    }

    function currentArchive(el: RRApp): R49Archive {
      return (el as any)._session.archive;
    }

    it('stays on the layout when the person cancels', async () => {
      const el = await mountDirty();
      answer(el, 'cancel');
      await (el as any)._onFileNew();
      expect(currentArchive(el)).toBe(archive);
    });

    it('drops the changes when the person discards them', async () => {
      const el = await mountDirty();
      const save = vi.spyOn(el as any, '_onFileSave');
      answer(el, 'discard');
      await (el as any)._onFileNew();
      expect(currentArchive(el)).not.toBe(archive);
      expect(save).not.toHaveBeenCalled();
    });

    it('saves, then goes ahead, when the person saves', async () => {
      const el = await mountDirty();
      vi.spyOn(el as any, '_onFileSave').mockImplementation(async () => {
        (el as any)._session.history.markSaved();
      });
      answer(el, 'save');
      await (el as any)._onFileNew();
      expect(currentArchive(el)).not.toBe(archive);
    });

    it('stays when the save does not happen', async () => {
      const el = await mountDirty();
      vi.spyOn(el as any, '_onFileSave').mockResolvedValue(undefined);
      answer(el, 'save');
      await (el as any)._onFileNew();
      expect(currentArchive(el)).toBe(archive);
    });

    it('asks nothing of a clean session', async () => {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);
      const ask = answer(el, 'cancel');
      await (el as any)._onFileNew();
      expect(ask).not.toHaveBeenCalled();
      expect(currentArchive(el)).not.toBe(archive);
    });
  });

  describe('the guard on closing the tab (#49)', () => {
    /** An app whose history has one unsaved edit on it. */
    async function mountDirty() {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);
      const history = (el as any)._session.history as EditHistory;
      await history.record('rename layout', { kind: 'layout' }, () => {
        archive.getManifest().layout.name = 'Renamed';
      });
      return { el, history };
    }

    function fireBeforeUnload(): Event {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event;
    }

    it('cancels the unload while there are unsaved changes', async () => {
      const { history } = await mountDirty();
      expect(history.isDirty).toBe(true);

      expect(fireBeforeUnload().defaultPrevented).toBe(true);
    });

    it('lets a clean session close silently', async () => {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);

      expect(fireBeforeUnload().defaultPrevented).toBe(false);
    });

    // The registration is permanent and the predicate checked at fire time, so
    // a detached `rr-app` left listening would cancel every unload forever —
    // a regression nothing else in the suite would catch.
    it('stops guarding once disconnected', async () => {
      const { el } = await mountDirty();
      el.remove();

      expect(fireBeforeUnload().defaultPrevented).toBe(false);
    });
  });

  describe('Cmd/Ctrl+S (#326)', () => {
    async function mount() {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._open(archive);
      const save = vi.spyOn(el as any, '_onFileSave').mockResolvedValue(undefined);
      return { el, save };
    }

    function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
      const event = new KeyboardEvent('keydown', {
        key: 's', bubbles: true, composed: true, cancelable: true, ...init,
      });
      target.dispatchEvent(event);
      return event;
    }

    it('saves on Cmd+S and Ctrl+S, in place of the browser', async () => {
      const { save } = await mount();
      expect(press({ metaKey: true }).defaultPrevented).toBe(true);
      expect(press({ ctrlKey: true }).defaultPrevented).toBe(true);
      expect(save.mock.calls).toEqual([[false], [false]]);
    });

    it('does Save As on Cmd+Shift+S', async () => {
      const { save } = await mount();
      expect(press({ key: 'S', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
      expect(save).toHaveBeenCalledWith(true);
    });

    it('saves while a field has focus', async () => {
      const { save } = await mount();
      const input = document.createElement('input');
      document.body.append(input);
      onTestFinished(() => input.remove());
      press({ metaKey: true }, input);
      expect(save).toHaveBeenCalledWith(false);
    });

    it('saves nothing from inside an open dialog, and still cancels the browser', async () => {
      const { save } = await mount();
      const dialog = document.createElement('dialog');
      dialog.setAttribute('open', '');
      const input = document.createElement('input');
      dialog.append(input);
      document.body.append(dialog);
      onTestFinished(() => dialog.remove());
      expect(press({ metaKey: true }, input).defaultPrevented).toBe(true);
      expect(save).not.toHaveBeenCalled();
    });

    it('ignores a key repeat', async () => {
      const { save } = await mount();
      expect(press({ metaKey: true, repeat: true }).defaultPrevented).toBe(true);
      expect(save).not.toHaveBeenCalled();
    });

    // The save branch runs before the field check, so undo must still leave
    // a field's own Cmd+Z alone.
    it('still leaves Cmd+Z in a field to the field', async () => {
      const { el } = await mount();
      const undo = vi.spyOn(el as any, '_undo');
      const input = document.createElement('input');
      document.body.append(input);
      onTestFinished(() => input.remove());
      expect(press({ key: 'z', metaKey: true }, input).defaultPrevented).toBe(false);
      expect(undo).not.toHaveBeenCalled();
    });

    it('leaves the key to the browser with no archive open', async () => {
      await fixture<RRApp>(html`<rr-app></rr-app>`);
      expect(press({ metaKey: true }).defaultPrevented).toBe(false);
    });

    it('leaves the key to the browser outside the editor view', async () => {
      const { el, save } = await mount();
      (el as any)._viewMode = 'diagnostics';
      expect(press({ metaKey: true }).defaultPrevented).toBe(false);
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('the occupancy service on this origin (#331, #333)', () => {
    const originalFetch = global.fetch;
    // jsdom has no EventSource. The live view opens the service's stream; these
    // tests never connect it.
    beforeEach(() => {
      vi.stubGlobal(
        'EventSource',
        class {
          close() {}
        }
      );
    });
    afterEach(() => {
      // Remove the views first, so none is still opening the service when the
      // stub goes.
      fixtureCleanup();
      global.fetch = originalFetch;
      vi.unstubAllGlobals();
      delete (window as any).showSaveFilePicker;
    });

    /** The manifest the service serves. One test gives it an image to delete. */
    let served: {
      version: number;
      layout: unknown;
      camera: unknown;
      images: { filename: string; labeled_complete: boolean; labels: [] }[];
    };
    beforeEach(() => {
      served = {
        version: 4,
        layout: { name: 'Served', scale: 'N', calibration: { points: [] }, sensors: [] },
        camera: { resolution: { width: 640, height: 480 } },
        images: [],
      };
    });

    /**
     * Every request the page made, as `<METHOD> <path>`, in order.
     *
     * The path rather than the URL: the check and the writes are
     * origin-relative, and `R49Archive.load` is given the absolute base
     * `archiveBase()` resolves. Both reach the same path.
     */
    let seen: string[];

    /**
     * Answer the manifest path with `manifest` and hold every `latest` open.
     *
     * Holding rather than answering keeps the loop parked on its first request:
     * what these tests are about is whether the page found a service and what it
     * opened, not what it does with its frames.
     *
     * `manifest` is called per request, so a test can answer the `ETag` read and
     * the load that follows it differently — which is how the two reads are told
     * apart at all. Writes answer 204 unless `write` says otherwise.
     */
    function serve(
      manifest: () => Response | Error,
      write: (key: string) => Response | Promise<Response> = () => new Response(null, { status: 204, headers: { etag: '"v2"' } })
    ) {
      seen = [];
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${new URL(String(url), window.location.href).pathname}`;
        seen.push(key);
        if (init?.method !== undefined) return await write(key);
        if (String(url).includes('manifest.json')) {
          const answer = manifest();
          if (answer instanceof Error) throw answer;
          return answer;
        }
        // Any other file of the archive: bytes, as the service serves an image.
        if (String(url).includes('/archive/')) {
          return new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit);
        }
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;
    }

    const jsonManifest = (etag?: string) =>
      new Response(JSON.stringify(served), {
        headers: { 'content-type': 'application/json', ...(etag === undefined ? {} : { etag }) },
      });

    /** A service serving a writable archive: both reads carry the same version. */
    const writable = () => serve(() => jsonManifest('"v1"'));

    /** Mount, let the check settle, and hand back the app and its toasts. */
    async function mounted() {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      const notify = vi.spyOn(el as unknown as { _notify: () => void }, '_notify');
      await new Promise(resolve => setTimeout(resolve, 0));
      await el.updateComplete;
      return { el, notify };
    }

    const liveSources = (el: RRApp) => {
      (el as unknown as { _viewMode: string })._viewMode = 'live';
      return el.updateComplete.then(() => el.shadowRoot!.querySelector('rr-live-view'));
    };

    const binding = (el: RRApp) =>
      (el as unknown as { _binding: FileBinding | null })._binding;
    const session = (el: RRApp) =>
      (el as unknown as { _session: { history: EditHistory; editLayout(l: unknown): Promise<void> } | null })._session;
    const save = (el: RRApp, rebind = false) =>
      (el as unknown as { _onFileSave(rebind?: boolean): Promise<void> })._onFileSave(rebind);

    it('hands a service it found to the live view, as both of its sources', async () => {
      writable();
      const { el } = await mounted();

      const view = (await liveSources(el))!;
      expect(view.sources).to.not.be.null;
      // One object answers a frame and that frame's L1 together, so it is both.
      expect(view.sources!.frames).toBe(view.sources!.results);
      // And it says what it is, so the view shows the service's judgement
      // rather than measuring drift against the archive now bound (#333).
      expect(view.sources!.service).toBe(true);
    });

    // The page still opens in the editor; the check only decides what Live
    // shows when the person presses it.
    it('still starts in the editor', async () => {
      writable();
      const { el } = await mounted();

      expect(el.shadowRoot!.querySelector('rr-editor-view')).to.exist;
      expect(el.shadowRoot!.querySelector('rr-live-view')).to.be.null;
    });

    it('opens the archive the service serves, writable, and says so', async () => {
      writable();
      const { el, notify } = await mounted();

      expect(session(el)).to.not.be.null;
      expect(binding(el)).toEqual({ stem: '', service: { base: '/live', etag: '"v1"' } });
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('occupancy service'),
        'success',
        'file-earmark-check'
      );
      // The band says where a save goes, as it does for a bound file.
      expect(el.shadowRoot!.querySelector('look-reading')!.textContent).toContain(
        'occupancy service'
      );
    });

    // A `.r49` zip on the service, or a folder it cannot write: it serves the
    // manifest and no version to write against.
    it('opens an archive with no ETag read-only', async () => {
      serve(() => jsonManifest());
      const { el } = await mounted();

      expect(session(el)).to.not.be.null;
      expect(binding(el)).toEqual({ stem: '', service: { base: '/live', etag: null } });
      // Nothing writable is named in the band.
      expect(el.shadowRoot!.querySelector('look-reading')).to.be.null;
    });

    // The version is read from the answer the check already has, and the load
    // reads the manifest again. A save landing between the two leaves this page
    // holding the older version — and its own save refused, rather than
    // overwriting work it never saw.
    it('reads the ETag before it loads the manifest', async () => {
      const etags = ['"v1"', '"v2"'];
      serve(() => jsonManifest(etags.shift() ?? '"v3"'));
      const { el } = await mounted();

      expect(seen).toEqual([
        'GET /live/archive/manifest.json',
        'GET /live/archive/manifest.json',
      ]);
      expect(binding(el)!.service!.etag).toBe('"v1"');
    });

    const noService: [string, () => Response | Error][] = [
      // The cloud copy of this page answers every unknown path with its own
      // HTML, so `response.ok` alone would find a service on a static host.
      ['a 200 text/html answer', () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })],
      ['a 404', () => new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } })],
      ['a request that failed', () => new TypeError('Failed to fetch')],
    ];

    for (const [what, answer] of noService) {
      it(`finds no service in ${what}, opens nothing, and says nothing about it`, async () => {
        serve(answer);
        const { el, notify } = await mounted();

        expect(session(el)).to.be.null;
        expect(binding(el)).to.be.null;
        const view = (await liveSources(el))!;
        expect(view.sources).to.be.null;
        // Silent: a page with no service is the page as it has always been,
        // and a toast on every load of the deployed site would be noise.
        expect(notify).not.toHaveBeenCalled();
      });
    }

    // Found, so the live view watches it; the archive did not load, and that
    // is a failed load like any other.
    it('toasts a manifest that will not load the way it toasts any failed load', async () => {
      let first = true;
      serve(() => {
        if (first) {
          first = false;
          return jsonManifest('"v1"');
        }
        return new Response('{"version": 3}', { headers: { 'content-type': 'application/json' } });
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { el, notify } = await mounted();

      expect(session(el)).to.be.null;
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('Load failed'),
        'danger',
        'exclamation-octagon'
      );
      expect((await liveSources(el))!.sources).to.not.be.null;
    });

    it('leaves the service behind when an archive is created', async () => {
      writable();
      const { el } = await mounted();
      expect((await liveSources(el))!.sources).to.not.be.null;

      (el as unknown as { _viewMode: string })._viewMode = 'editor';
      await (el as unknown as { _onFileNew(): Promise<void> })._onFileNew();
      await el.updateComplete;

      const view = (await liveSources(el))!;
      expect(view.sources).to.be.null;
      expect(view.archive).to.not.be.null;
      expect(binding(el)).to.be.null;
    });

    it('ignores a service that answers after an archive has been created', async () => {
      // The race the check's own latency opens: the person pressed New before
      // the manifest came back.
      let answer!: (response: Response) => void;
      global.fetch = vi.fn(
        async () => new Promise<Response>(resolve => (answer = resolve))
      ) as unknown as typeof fetch;

      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      await (el as unknown as { _onFileNew(): Promise<void> })._onFileNew();
      answer(jsonManifest('"v1"'));
      await new Promise(resolve => setTimeout(resolve, 0));
      await el.updateComplete;

      expect((await liveSources(el))!.sources).to.be.null;
      // And the archive on screen is the one the person made.
      expect(binding(el)).to.be.null;
      expect(session(el)!.history.isDirty).toBe(false);
    });

    it('ignores a manifest that loads after an archive has been created', async () => {
      // The second half of the same race: the check answered, and the load it
      // started was still in flight when the person pressed New.
      let answer!: (response: Response) => void;
      let reads = 0;
      global.fetch = vi.fn(async (url: string) => {
        if (!String(url).includes('manifest.json')) return new Promise<Response>(() => {});
        if (++reads === 1) return jsonManifest('"v1"');
        return new Promise<Response>(resolve => (answer = resolve));
      }) as unknown as typeof fetch;

      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      await new Promise(resolve => setTimeout(resolve, 0));
      await (el as unknown as { _onFileNew(): Promise<void> })._onFileNew();
      answer(jsonManifest('"v1"'));
      await new Promise(resolve => setTimeout(resolve, 0));
      await el.updateComplete;

      expect(binding(el)).to.be.null;
      expect((el as unknown as { _session: { archive: R49Archive } })._session.archive
        .getManifest().layout.name).toBe('New Layout');
    });

    describe('Save on a service binding (#333)', () => {
      it('writes to the service and marks the archive saved', async () => {
        writable();
        const { el, notify } = await mounted();
        await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });
        expect(session(el)!.history.isDirty).toBe(true);

        await save(el);

        expect(seen).toContain('PUT /live/archive/manifest.json');
        expect(session(el)!.history.isDirty).toBe(false);
        // The new version, so the next save is not refused as stale.
        expect(binding(el)!.service!.etag).toBe('"v2"');
        expect(notify).toHaveBeenCalledWith(
          'Saved to the occupancy service',
          'success',
          'floppy'
        );
      });

      const refusals: [number, (key: string) => Response, RegExp][] = [
        [412, () => new Response(null, { status: 412 }), /Save As/],
        [
          422,
          () =>
            new Response(JSON.stringify({ error: 'manifest/provenance' }), {
              status: 422,
              headers: { 'content-type': 'application/json' },
            }),
          /manifest\/provenance/,
        ],
        [405, () => new Response(null, { status: 405 }), /405/],
        [403, () => new Response(null, { status: 403 }), /403/],
      ];

      for (const [status, answer, says] of refusals) {
        it(`leaves the archive dirty and bound to the service on a ${status}`, async () => {
          serve(() => jsonManifest('"v1"'), answer);
          const { el, notify } = await mounted();
          await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });

          await save(el);

          expect(session(el)!.history.isDirty).toBe(true);
          expect(binding(el)).toEqual({ stem: '', service: { base: '/live', etag: '"v1"' } });
          expect(notify).toHaveBeenCalledWith(
            expect.stringMatching(says),
            'danger',
            'exclamation-diamond',
            Infinity
          );
        });
      }

      it('reports a network failure as a failed save, dirty and still bound', async () => {
        serve(
          () => jsonManifest('"v1"'),
          () => Promise.reject(new TypeError('Failed to fetch'))
        );
        const { el, notify } = await mounted();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });

        await save(el);

        expect(session(el)!.history.isDirty).toBe(true);
        expect(binding(el)!.service).to.not.be.undefined;
        expect(notify).toHaveBeenCalledWith(
          expect.stringContaining('Save failed'),
          'danger',
          'exclamation-diamond'
        );
      });

      it('sends nothing for a Save pressed while one is running', async () => {
        let release!: () => void;
        const held = new Promise<void>(resolve => (release = resolve));
        serve(
          () => jsonManifest('"v1"'),
          async () => {
            await held;
            return new Response(null, { status: 204, headers: { etag: '"v2"' } });
          }
        );
        const { el } = await mounted();

        const first = save(el);
        await save(el);
        release();
        await first;

        expect(seen.filter(call => call.startsWith('PUT'))).toHaveLength(1);
      });

      // The position is taken when the save starts, so an edit made while the
      // requests were in flight is not in what went.
      it('leaves an edit made during the save dirty', async () => {
        let release!: () => void;
        const held = new Promise<void>(resolve => (release = resolve));
        serve(
          () => jsonManifest('"v1"'),
          async () => {
            await held;
            return new Response(null, { status: 204, headers: { etag: '"v2"' } });
          }
        );
        const { el } = await mounted();

        const saving = save(el);
        await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });
        release();
        await saving;

        expect(session(el)!.history.isDirty).toBe(true);
      });

      // occupancy-service#7 accepts an orphan file, so a delete that did not
      // land is a stray file on the service rather than a save that did not
      // happen. The archive is what the manifest names.
      it('marks the archive saved when a DELETE fails', async () => {
        served.images = [{ filename: 'img_1.jpg', labeled_complete: false, labels: [] }];
        serve(() => jsonManifest('"v1"'), key =>
          key.startsWith('DELETE')
            ? new Response(null, { status: 405 })
            : new Response(null, { status: 204, headers: { etag: '"v2"' } })
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { el } = await mounted();
        await (
          el as unknown as { _session: { deleteImage(name: string): Promise<void> } }
        )._session.deleteImage('img_1.jpg');
        expect(session(el)!.history.isDirty).toBe(true);

        await save(el);

        expect(seen).toContain('DELETE /live/archive/img_1.jpg');
        expect(session(el)!.history.isDirty).toBe(false);
        expect(binding(el)!.service!.etag).toBe('"v2"');
      });

      it('moves the work to the file a Save As chose, and the live view with it', async () => {
        writable();
        const { el } = await mounted();
        const written: unknown[] = [];
        const chosen = {
          name: 'west-yard.r49',
          createWritable: vi.fn().mockResolvedValue({
            write: vi.fn(async (data: unknown) => void written.push(data)),
            close: vi.fn(async () => {}),
            abort: vi.fn(),
          }),
        };
        (window as any).showSaveFilePicker = vi.fn().mockResolvedValue(chosen);

        await save(el, true);

        expect(written).toHaveLength(1);
        expect(binding(el)).toEqual({ stem: 'west-yard', handle: chosen });
        expect(seen.filter(call => call.startsWith('PUT'))).toHaveLength(0);
        // The archive is the person's file now, so the live view goes back to
        // the camera and the model in this page.
        const view = (await liveSources(el))!;
        expect(view.sources).to.be.null;
        expect(view.archive).to.not.be.null;

        // And the next plain Save goes to that file, not to the service.
        (el as unknown as { _viewMode: string })._viewMode = 'editor';
        await save(el);
        expect(written).toHaveLength(2);
        expect(seen.filter(call => call.startsWith('PUT'))).toHaveLength(0);
      });

      it('names the layout in the picker, since an archive on a service has no filename here', async () => {
        writable();
        const { el } = await mounted();
        const picker = vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError'));
        (window as any).showSaveFilePicker = picker;

        await save(el, true);

        expect(picker).toHaveBeenCalledWith(
          expect.objectContaining({ suggestedName: 'Served.r49' })
        );
      });

      it('says a read-only archive is read-only, and downloads instead', async () => {
        serve(() => jsonManifest());
        const { el, notify } = await mounted();

        await save(el);

        expect(seen.filter(call => call.startsWith('PUT'))).toHaveLength(0);
        expect(notify).toHaveBeenCalledWith(
          expect.stringContaining('read-only'),
          'warning',
          'exclamation-triangle'
        );
        expect(notify).toHaveBeenCalledWith(
          expect.stringMatching(/^Downloaded Served-\d{8}-\d{4}\.r49$/),
          'success',
          'download'
        );
        // A download binds nothing: the archive is still the service's.
        expect(binding(el)!.service).toEqual({ base: '/live', etag: null });
      });
    });
  });

  it('reports a save failure', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._open(archive);

    vi.spyOn(archive, 'export').mockRejectedValue(new Error('disk full'));
    const notifySpy = vi.spyOn(el as any, '_notify').mockImplementation(() => {});

    await (el as any)._onFileSave();

    expect(notifySpy).toHaveBeenCalledWith(
      expect.stringContaining('Save failed'), 'danger', 'exclamation-diamond'
    );
  });
});
