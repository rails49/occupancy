import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import '../src/rr-app.js';
import { RRApp } from '../src/rr-app.js';
import { R49Archive, getDPT, type ManifestData } from '@rails49/r49';
import type { NotifyDetail } from '../src/rr-editor-view.js';
import type { EditHistory } from '../src/history.js';
import type { FileBinding } from '../src/persistence.js';
import type { FrameAddDetail } from '../src/rr-live-view.js';
import { FRAME_BYTES, multipartAnswer, useNodeFileGlobals } from './liveFixture.js';
import type { LookCommand } from '@rails49/look';
import { press as pressCommand } from '@rails49/look/testing';
import { AUTOSAVE_MS, LOST_EDIT_MESSAGE, NO_FRAME_MESSAGE, NO_RAILROAD_MESSAGE } from '../src/rr-app.js';
import type { RRSettingsDialog } from '../src/rr-settings-dialog.js';
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

  it('keeps a toast inside the app, so removing the app removes it (#376)', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    void (el as unknown as { _notify(message: string): Promise<void> })._notify('Saved');

    fixtureCleanup();

    expect(document.body.querySelector('sl-alert')).toBeNull();
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

    /** The alerts the app built, each where it was appended: `setup.ts` stubs `toast()`. */
    async function mountWithToasts() {
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
      (el as unknown as { _session: { history: EditHistory; archive: R49Archive; editLayout(l: unknown): Promise<void> } | null })._session;
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

      expect(seen.filter(call => call.includes('/archive/'))).toEqual([
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

    const command = (el: RRApp, id: string) =>
      el.shadowRoot!.querySelector<LookCommand>(`#${id}`);
    const groups = (el: RRApp) =>
      [...el.shadowRoot!.querySelectorAll('look-rail look-group')].map(g => g.getAttribute('label'));
    const editor = (el: RRApp) => el.shadowRoot!.querySelector('rr-editor-view')!;

    // The service page holds only the service's archive (#381).
    it('offers Download alone in File: no New, Open or Save', async () => {
      writable();
      const { el } = await mounted();

      for (const id of ['file-new', 'file-open', 'file-save']) {
        expect(command(el, id), id).toBeNull();
      }
      expect(command(el, 'file-download')).not.toBeNull();
      expect(groups(el)).toEqual(['File', 'History', 'Tools']);
      expect(editor(el).service).toBe(true);
      expect(editor(el).readOnly).toBe(false);
    });

    it('keeps New, Open and Save, and the device camera, on the cloud page', async () => {
      serve(() => new TypeError('Failed to fetch'));
      const { el } = await mounted();

      for (const id of ['file-new', 'file-open', 'file-save']) {
        expect(command(el, id), id).not.toBeNull();
      }
      expect(command(el, 'file-download')).toBeNull();
      expect(editor(el).service).toBe(false);
    });

    it('downloads the archive as a file, and sends nothing to the service', async () => {
      writable();
      const { el, notify } = await mounted();
      vi.spyOn(session(el)!.archive, 'export').mockResolvedValue(new Uint8Array());
      await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });

      pressCommand(command(el, 'file-download')!);
      await vi.waitFor(() =>
        expect(notify).toHaveBeenCalledWith(
          expect.stringMatching(/^Downloaded Renamed-\d{8}-\d{4}\.r49$/),
          'success',
          'download'
        )
      );

      expect(seen.filter(call => call.startsWith('PUT'))).toHaveLength(0);
      // A download is not the save: the edit still goes to the service.
      expect(session(el)!.history.isDirty).toBe(true);
    });

    // A service with no `ETag` serves the archive and takes no writes.
    describe('read-only', () => {
      it('turns editing off and leaves the views and Download', async () => {
        serve(() => jsonManifest());
        const { el } = await mounted();

        expect(editor(el).readOnly).toBe(true);
        expect(groups(el)).toEqual(['File']);
        expect(command(el, 'file-download')).not.toBeNull();
      });

      it('takes no settings edit, and says why', async () => {
        serve(() => jsonManifest());
        const { el, notify } = await mounted();

        await (el as unknown as { _onLayoutChange(e: unknown): Promise<void> })._onLayoutChange(
          new CustomEvent('rr-layout-change', { detail: { layout: { name: 'Renamed', scale: 'N' } } })
        );

        expect(session(el)!.archive.getManifest().layout.name).toBe('Served');
        expect(session(el)!.history.isDirty).toBe(false);
        expect(notify).toHaveBeenCalledWith(
          'This occupancy service does not accept changes.',
          'warning',
          'exclamation-triangle',
          Infinity
        );
      });
    });

    // Autosave (#381): 10 s after the last edit, and at once on a switch
    // between the editor and the live view or when the tab is hidden.
    describe('autosave', () => {
      const puts = () => seen.filter(call => call === 'PUT /live/archive/manifest.json');

      afterEach(() => {
        vi.useRealTimers();
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      });

      it('saves 10 s after the last edit, quietly', async () => {
        writable();
        const { el, notify } = await mounted();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        await session(el)!.editLayout({ name: 'One', scale: 'N' });
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1000);
        await session(el)!.editLayout({ name: 'Two', scale: 'N' });
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
        expect(puts()).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => expect(session(el)!.history.isDirty).toBe(false));
        expect(puts()).toHaveLength(1);
        expect(notify).not.toHaveBeenCalledWith('Saved to the occupancy service', 'success', 'floppy');
      });

      it('saves what an undo restored', async () => {
        writable();
        const { el } = await mounted();
        await session(el)!.editLayout({ name: 'One', scale: 'N' });
        await save(el);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        await (session(el) as unknown as { undo(): Promise<void> }).undo();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);

        await vi.waitFor(() => expect(puts()).toHaveLength(2));
      });

      it('saves at once on a switch to the live view', async () => {
        writable();
        const { el } = await mounted();
        await session(el)!.editLayout({ name: 'One', scale: 'N' });

        el.shadowRoot!.querySelector('look-rail')!.dispatchEvent(
          new CustomEvent('look-view', { detail: { name: 'live' } })
        );

        await vi.waitFor(() => expect(puts()).toHaveLength(1));
      });

      it('saves at once when the settings dialog closes', async () => {
        writable();
        const { el } = await mounted();
        await session(el)!.editLayout({ name: 'One', scale: 'N' });

        el.shadowRoot!.querySelector('rr-settings-dialog')!.dispatchEvent(
          new CustomEvent('rr-settings-close', { bubbles: true, composed: true })
        );

        await vi.waitFor(() => expect(puts()).toHaveLength(1));
      });

      it('saves at once when the tab is hidden', async () => {
        writable();
        const { el } = await mounted();
        await session(el)!.editLayout({ name: 'One', scale: 'N' });

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        await vi.waitFor(() => expect(puts()).toHaveLength(1));
      });

      it('saves nothing on the cloud page', async () => {
        serve(() => new TypeError('Failed to fetch'));
        const { el } = await mounted();
        (el as any)._open(archive);
        vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
        const click = vi.mocked(HTMLAnchorElement.prototype.click);
        click.mockClear();
        await session(el)!.editLayout({ name: 'One', scale: 'N' });

        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(click).not.toHaveBeenCalled();
        expect(session(el)!.history.isDirty).toBe(true);
      });

      it('still asks before the tab closes on an unsaved edit', async () => {
        writable();
        const { el } = await mounted();
        await session(el)!.editLayout({ name: 'One', scale: 'N' });

        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
      });
    });

    // A 412: the archive changed on another page (#381).
    describe('a refused save', () => {
      afterEach(() => vi.useRealTimers());

      it('says the archive changed on another page, and reloads without asking', async () => {
        serve(() => jsonManifest('"v1"'), () => new Response(null, { status: 412 }));
        const { el, notify } = await mounted();
        const reload = vi
          .spyOn(el as unknown as { _reload(): void }, '_reload')
          .mockImplementation(() => {});
        await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        await save(el);

        expect(notify).toHaveBeenCalledWith(
          expect.stringContaining('changed on another page'),
          'danger',
          'exclamation-diamond',
          Infinity
        );
        expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/Save As/), expect.anything(), expect.anything(), expect.anything());
        await vi.advanceTimersByTimeAsync(5000);
        expect(reload).toHaveBeenCalledTimes(1);

        // The edits are lost on purpose, so the browser does not ask.
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      });
    });

    // A service with no archive (#382): the page makes a fresh one from the
    // service's camera, and the first save creates it there.
    describe('no archive', () => {
      const fileGlobals = useNodeFileGlobals();
      beforeEach(() => {
        fileGlobals.install();
        // jsdom has no decoder; this stands for the size of the service's frames.
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1280, height: 720, close() {} })));
      });
      afterEach(() => {
        fileGlobals.restore();
        vi.useRealTimers();
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      });

      /** The manifest the create sent, once one landed. The service serves it after. */
      let created: ManifestData | null;
      /** The headers of each create. */
      let creates: Record<string, string>[];

      /**
       * A service with no archive, answering the manifest with `body` until a
       * create lands, and each `latest` with a frame unless `frame` is false.
       * The create answers `create`; every other write 204 with `"v2"`.
       */
      function serveNone(
        body: Record<string, unknown>,
        { create = () => new Response(null, { status: 204, headers: { etag: '"v1"' } }), frame = true }:
          { create?: () => Response | Promise<Response>; frame?: boolean } = {}
      ) {
        created = null;
        creates = [];
        seen = [];
        let frameIds = 0;
        global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
          const key = `${init?.method ?? 'GET'} ${new URL(String(url), window.location.href).pathname}`;
          seen.push(key);
          if (key === 'PUT /live/archive.r49') {
            creates.push(init!.headers as Record<string, string>);
            const answer = await create();
            if (answer.ok) {
              const bytes = new Uint8Array(await (init!.body as Blob).arrayBuffer());
              created = (await R49Archive.load(bytes)).getManifest();
            }
            return answer;
          }
          if (init?.method !== undefined) {
            return new Response(null, { status: 204, headers: { etag: '"v2"' } });
          }
          if (String(url).includes('manifest.json')) {
            return created
              ? new Response(JSON.stringify(created), {
                  headers: { 'content-type': 'application/json', etag: '"v1"' },
                })
              : new Response(JSON.stringify(body), {
                  status: 404,
                  headers: { 'content-type': 'application/json' },
                });
          }
          if (String(url).includes('/latest')) {
            await new Promise(resolve => setTimeout(resolve, 5));
            return frame
              ? multipartAnswer({ version: 1, frame_id: `f-${++frameIds}`, captured_at: '2026-11-12T10:00:00Z', l1: {} })
              : multipartAnswer({ version: 1, frame_id: null, captured_at: null, l1: {} }, null);
          }
          return new Promise<Response>(() => {});
        }) as unknown as typeof fetch;
      }

      const named = (railroad?: string | null) =>
        serveNone({ error: 'archive/none', ...(railroad === undefined ? {} : { railroad }) });

      const settings = (el: RRApp) => el.shadowRoot!.querySelector('rr-settings-dialog') as RRSettingsDialog;
      const manifestOf = (el: RRApp) => session(el)!.archive.getManifest();
      const writes = () => seen.filter(call => !call.startsWith('GET '));

      /** Mounted, with the fresh archive open. */
      async function opened() {
        const mount = await mounted();
        await vi.waitFor(() => expect(session(mount.el)).to.not.be.null);
        await mount.el.updateComplete;
        return mount;
      }

      /** The settings dialog's camera height, as the person types it. */
      async function enterHeight(el: RRApp, mm = 1150) {
        settings(el).dispatchEvent(
          new CustomEvent('rr-camera-height-change', { detail: { camera_height_mm: mm } })
        );
        await vi.waitFor(() => expect(manifestOf(el).layout.calibration.camera_height_mm).toBe(mm));
      }

      const closeSettings = (el: RRApp) =>
        settings(el).dispatchEvent(new CustomEvent('rr-settings-close', { bubbles: true, composed: true }));

      /** The settings dialog closed as the person closes it, which fires `rr-settings-close`. */
      async function closeDialog(el: RRApp) {
        await vi.waitFor(() => expect(settings(el).open).toBe(true));
        settings(el).hide();
        await vi.waitFor(() => expect(settings(el).open).toBe(false));
      }

      /** A create that answers 204 with `"v1"` once `release` is called. */
      function heldCreate() {
        let release!: () => void;
        const held = new Promise<void>(resolve => (release = resolve));
        serveNone(
          { error: 'archive/none', railroad: 'Gleis 49' },
          { create: async () => (await held, new Response(null, { status: 204, headers: { etag: '"v1"' } })) }
        );
        return () => release();
      }

      it('opens a fresh archive named for the railroad, at the size of its frames, and asks for the camera height', async () => {
        named('Gleis 49');
        const { el } = await opened();

        const manifest = manifestOf(el);
        expect(manifest.layout.name).toBe('Gleis 49');
        expect(manifest.layout.scale).toBe('N');
        expect(manifest.camera.resolution).toEqual({ width: 1280, height: 720 });
        expect(manifest.images).toEqual([]);
        expect(binding(el)).toEqual({ stem: '', service: { base: '/live', etag: null, create: true } });
        expect(settings(el).requiredMissing.map(r => r.field)).toEqual(['camera_height_mm']);
        expect(writes()).toEqual([]);
      });

      // The frame that sized the archive leaves the camera ready before the
      // watch starts, and the watch reports only a change.
      it('enables the camera button', async () => {
        named('Gleis 49');
        const { el } = await opened();
        await vi.waitFor(() => expect(editor(el).cameraReady).toBe(true));
      });

      it('fills in no name where the archive path names no railroad', async () => {
        named();
        const { el } = await opened();

        expect(manifestOf(el).layout.name).toBe('');
        expect(settings(el).requiredMissing.map(r => r.field)).toEqual(['name', 'camera_height_mm']);
      });

      it('creates it with one PUT archive.r49 when the settings dialog closes, then saves file by file', async () => {
        named('Gleis 49');
        const { el } = await opened();
        const fresh = session(el);

        await enterHeight(el);
        await closeDialog(el);
        await vi.waitFor(() => expect(binding(el)!.service!.etag).toBe('"v1"'));

        expect(writes()).toEqual(['PUT /live/archive.r49']);
        expect(creates[0]['If-None-Match']).toBe('*');
        expect(created!.layout.name).toBe('Gleis 49');
        expect(created!.layout.calibration.camera_height_mm).toBe(1150);
        expect(binding(el)!.service).toEqual({ base: '/live', etag: '"v1"' });
        // Reopened from the service, so the next save is #333's.
        expect(session(el)).not.toBe(fresh);
        expect(session(el)!.history.isDirty).toBe(false);

        await session(el)!.editLayout({ name: 'Gleis 49 Nord', scale: 'N' });
        await save(el);

        expect(writes()).toEqual(['PUT /live/archive.r49', 'PUT /live/archive/manifest.json']);
      });

      it('saves nothing while the settings dialog still asks for the camera height', async () => {
        named('Gleis 49');
        const { el } = await opened();
        await session(el)!.editLayout({ name: 'Renamed', scale: 'N' });

        closeSettings(el);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(writes()).toEqual([]);
        expect(binding(el)!.service!.create).toBe(true);
      });

      it('creates nothing while the dialog stays open, even after the autosave time', async () => {
        named('Gleis 49');
        const { el } = await opened();
        await vi.waitFor(() => expect(settings(el).open).toBe(true));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        await enterHeight(el);
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 1000);

        expect(writes()).toEqual([]);
      });

      it('adds a frame captured while the create runs to the archive it reopens', async () => {
        const release = heldCreate();
        const { el, notify } = await opened();
        await vi.waitFor(() => expect(editor(el).cameraReady).toBe(true));
        await enterHeight(el);
        await closeDialog(el);
        await vi.waitFor(() => expect(writes()).toEqual(['PUT /live/archive.r49']));

        editor(el).dispatchEvent(new CustomEvent('rr-frame-capture', { bubbles: true, composed: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
        release();

        await vi.waitFor(() => expect(manifestOf(el).images).toHaveLength(1));
        expect(binding(el)!.service!.etag).toBe('"v1"');
        expect(notify).not.toHaveBeenCalledWith(LOST_EDIT_MESSAGE, expect.anything(), expect.anything(), expect.anything());
      });

      it('says so when an edit made while the create ran is not in the reopened archive', async () => {
        const release = heldCreate();
        const { el, notify } = await opened();
        await enterHeight(el);
        await closeDialog(el);
        await vi.waitFor(() => expect(writes()).toEqual(['PUT /live/archive.r49']));

        await session(el)!.editLayout({ name: 'Gleis 49 Nord', scale: 'N' });
        release();

        await vi.waitFor(() =>
          expect(notify).toHaveBeenCalledWith(LOST_EDIT_MESSAGE, 'warning', 'exclamation-triangle', Infinity)
        );
      });

      it('says another page created it first, and reloads, on a 412', async () => {
        serveNone({ error: 'archive/none', railroad: 'Gleis 49' }, { create: () => new Response(null, { status: 412 }) });
        const { el, notify } = await opened();
        const reload = vi
          .spyOn(el as unknown as { _reload(): void }, '_reload')
          .mockImplementation(() => {});
        await enterHeight(el);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        await save(el);

        expect(notify).toHaveBeenCalledWith(
          "Another page created this railroad's archive first. This page reloads, and the edits it had not saved are lost.",
          'danger',
          'exclamation-diamond',
          Infinity
        );
        await vi.advanceTimersByTimeAsync(5000);
        expect(reload).toHaveBeenCalledTimes(1);
      });

      it('quotes the rule of a 422, and stays fresh and dirty', async () => {
        serveNone(
          { error: 'archive/none', railroad: 'Gleis 49' },
          { create: () => new Response(JSON.stringify({ error: 'images/missing' }), { status: 422, headers: { 'content-type': 'application/json' } }) }
        );
        const { el, notify } = await opened();
        await enterHeight(el);

        await save(el);

        expect(notify).toHaveBeenCalledWith(
          'The occupancy service refused the save: images/missing',
          'danger',
          'exclamation-diamond',
          Infinity
        );
        expect(binding(el)!.service!.create).toBe(true);
        expect(session(el)!.history.isDirty).toBe(true);
      });

      it('says no railroad is loaded, and opens no archive', async () => {
        named(null);
        const { el } = await mounted();
        await new Promise(resolve => setTimeout(resolve, 20));
        await el.updateComplete;

        expect(session(el)).to.be.null;
        expect(binding(el)).to.be.null;
        expect(editor(el).shadowRoot!.querySelector('.placeholder')!.textContent!.trim()).toBe(
          NO_RAILROAD_MESSAGE
        );
        expect(writes()).toEqual([]);
      });

      it('says so, and opens no archive, when the camera sends no picture to size one from', async () => {
        serveNone({ error: 'archive/none', railroad: 'Gleis 49' }, { frame: false });
        const { el } = await mounted();
        await vi.waitFor(() =>
          expect(editor(el).shadowRoot!.querySelector('.placeholder')!.textContent!.trim()).toBe(
            NO_FRAME_MESSAGE
          )
        );
        expect(session(el)).to.be.null;
      });
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
        // Quiet: it runs every few seconds while the person edits (#381).
        expect(notify).not.toHaveBeenCalledWith(
          'Saved to the occupancy service',
          'success',
          'floppy'
        );
      });

      const refusals: [number, (key: string) => Response, RegExp][] = [
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
    });

    // A service save is several requests, and nothing holds New or Open shut
    // while one runs — `_saving` stops only a second Save. The outcome belongs
    // to the session that was saved (#354).
    describe('Save on a session that was replaced while it ran (#354)', () => {
      /** A writable service whose `PUT` waits for the returned release. */
      function heldService() {
        let release!: () => void;
        const held = new Promise<void>(resolve => (release = resolve));
        serve(
          () => jsonManifest('"v1"'),
          async () => {
            await held;
            return new Response(null, { status: 204, headers: { etag: '"v2"' } });
          }
        );
        return () => release();
      }

      it('binds nothing to the archive New made, and keeps the next Save off the service', async () => {
        const release = heldService();
        const { el, notify } = await mounted();

        const saving = save(el);
        await (el as unknown as { _onFileNew(): Promise<void> })._onFileNew();
        release();
        await saving;

        // The empty archive is this page's, not the service's.
        expect(binding(el)).to.be.null;
        expect((await liveSources(el))!.sources).to.be.null;

        // Which is the harm: a second Save would otherwise put the empty
        // manifest on the service, and the service deletes every image the
        // real layout named.
        (el as unknown as { _viewMode: string })._viewMode = 'editor';
        await save(el);
        expect(seen.filter(call => call.startsWith('PUT'))).toHaveLength(1);
        expect(notify).toHaveBeenCalledWith(
          expect.stringMatching(/^Downloaded New Layout-\d{8}-\d{4}\.r49$/),
          'success',
          'download'
        );
      });

      it('leaves the binding Open set', async () => {
        const release = heldService();
        const { el } = await mounted();
        const handle = { getFile: async () => new File([], 'west-yard.r49') };
        (window as any).showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
        onTestFinished(() => {
          delete (window as any).showOpenFilePicker;
        });
        const load = vi.spyOn(R49Archive, 'load').mockResolvedValue(archive);
        onTestFinished(() => load.mockRestore());

        const saving = save(el);
        await (el as unknown as { _onFileOpen(): Promise<void> })._onFileOpen();
        release();
        await saving;

        // The opened file, not the service: the next Save overwrites that file.
        expect(binding(el)).toEqual({ stem: 'west-yard', handle });
      });
    });

    describe('Freeze adds the frame on screen (#334)', () => {
      // The multipart bodies are real bytes, so the frame travels the whole
      // way: `readLatest`, the source, the live view's button, this component's
      // add. `Response.formData()` here is Node's, which brand-checks the
      // global `File` — see `liveFixture.ts`.
      const fileGlobals = useNodeFileGlobals();
      beforeEach(() => {
        fileGlobals.install();
        // jsdom implements neither, and the source's decode step needs both.
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:frame');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        HTMLImageElement.prototype.decode = () => Promise.resolve();
      });
      afterEach(() => fileGlobals.restore());

      /** How many `latest` answers the stand-in has sent. `serve` does not see those. */
      let frames = 0;

      /**
       * The manifest, writable unless `readOnly`, and a frame per `latest`.
       *
       * The frames go through a wrapper around `serve`'s stub rather than
       * through it, because `serve` holds every `latest` open on purpose:
       * these tests are the ones that need the loop to be fed.
       */
      function serveFrames({ readOnly = false, frame = true } = {}) {
        frames = 0;
        serve(() => (readOnly ? jsonManifest() : jsonManifest('"v1"')));
        const manifests = global.fetch;
        global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
          if (!String(url).includes('/latest')) {
            return await (manifests as unknown as typeof fetch)(url, init);
          }
          // Paced as `after` paces a service, so the loop does not spin.
          await new Promise(resolve => setTimeout(resolve, 5));
          if (!frame) {
            return multipartAnswer({ version: 1, frame_id: null, captured_at: null, l1: {} }, null);
          }
          return multipartAnswer({
            version: 1,
            frame_id: `f-${++frames}`,
            captured_at: '2026-11-09T10:00:01.500Z',
            l1: {},
          });
        }) as unknown as typeof fetch;
      }

      const archiveOf = (el: RRApp) =>
        (el as unknown as { _session: { archive: R49Archive } })._session.archive;
      const images = (el: RRApp) => archiveOf(el).getManifest().images;

      /** The live view, mounted, with the frame it last rendered ready to add. */
      async function live(el: RRApp) {
        const view = (await liveSources(el))!;
        for (let waited = 0; waited < 1000; waited += 10) {
          await new Promise(resolve => setTimeout(resolve, 10));
          await view.updateComplete;
          if (freeze(view)?.disabled === false) break;
        }
        return view;
      }

      const freeze = (view: Element) =>
        [...view.shadowRoot!.querySelectorAll('button')].find(
          b => b.textContent!.trim() === 'Freeze'
        );

      /** A press the view would send, for the cases a real frame cannot stage. */
      const press = (view: Element, frameId: string, bytes: Uint8Array) =>
        view.dispatchEvent(
          new CustomEvent<FrameAddDetail>('rr-frame-add', {
            detail: { frameId, bytes: new Blob([bytes as BlobPart]) },
            bubbles: true,
            composed: true,
          })
        );

      const adding = (el: RRApp) =>
        el as unknown as { _freezing: boolean; _frozenId: string | null };

      /**
       * Resolves once no add is running. A press the guard lets through sets
       * `_freezing` before `rr-frame-add` returns, and the add clears it when it
       * has finished, history entry included, or been refused (#373).
       */
      const idle = (el: RRApp) =>
        vi.waitFor(() => expect(adding(el)._freezing).toBe(false), {
          timeout: 2000,
          interval: 5,
        });

      it('stores the frame the service sent, under a capture_ name, and says so', async () => {
        serveFrames();
        const { el, notify } = await mounted();
        const view = await live(el);

        freeze(view)!.click();
        await idle(el);

        expect(images(el)).toHaveLength(1);
        const { filename } = images(el)[0];
        expect(filename).to.match(/^capture_[^.]+\.jpg$/);
        // The `frame` part byte for byte: this JPEG carries no orientation tag,
        // so preparing it changes nothing.
        expect(await archiveOf(el).getImage(filename)).toEqual(FRAME_BYTES);
        // One entry, and the archive is dirty until autosave writes it (#381).
        expect(session(el)!.history.isDirty).toBe(true);
        expect(notify).toHaveBeenCalledWith(`Added ${filename}`, 'success', 'file-earmark-plus');
      });

      it('keeps the feed running, and the live view drawing the service', async () => {
        serveFrames();
        const { el } = await mounted();
        const view = await live(el);
        const sent = frames;

        freeze(view)!.click();

        // The picture does not stop: the loop asks again after the press.
        await vi.waitFor(() => expect(frames).toBeGreaterThan(sent + 1), {
          timeout: 2000,
          interval: 5,
        });
        await idle(el);
        // The held manifest is untouched until a save (#331): the image added
        // is in this page's archive and not in what the view draws.
        expect(view.sources).to.not.be.null;
      });

      it('adds nothing on a second press on the same frame', async () => {
        writable();
        const { el } = await mounted();
        const view = (await liveSources(el))!;

        press(view, 'f-1', FRAME_BYTES);
        await idle(el);
        press(view, 'f-1', FRAME_BYTES);
        await idle(el);

        expect(images(el)).toHaveLength(1);
      });

      it('adds nothing for a press while an add is running', async () => {
        writable();
        const { el } = await mounted();
        const view = (await liveSources(el))!;
        let release!: () => void;
        const held = new Promise<void>(resolve => (release = resolve));
        const stored = R49Archive.prototype.addImage;
        const gated = vi
          .spyOn(R49Archive.prototype, 'addImage')
          .mockImplementation(async function (
            this: R49Archive,
            name: string,
            bytes: Parameters<R49Archive['addImage']>[1]
          ) {
            await held;
            return await stored.call(this, name, bytes);
          });

        press(view, 'f-1', FRAME_BYTES);
        // A different frame: the second press is dropped because an add is
        // running, not because it is the same picture.
        press(view, 'f-2', FRAME_BYTES);
        expect(adding(el)._frozenId).toBe('f-1');
        release();
        await idle(el);
        gated.mockRestore();

        expect(images(el)).toHaveLength(1);
      });

      // Editing is off on a read-only service (#381).
      it('adds nothing on a read-only service, and says why', async () => {
        serveFrames({ readOnly: true });
        const { el, notify } = await mounted();
        expect(binding(el)).toEqual({ stem: '', service: { base: '/live', etag: null } });
        const view = await live(el);

        freeze(view)!.click();
        await idle(el);

        expect(images(el)).toHaveLength(0);
        expect(notify).toHaveBeenCalledWith(
          'This occupancy service does not accept changes.',
          'warning',
          'exclamation-triangle',
          Infinity
        );
      });

      // The editor's camera button on a service page (#381): the same add,
      // from the service's next frame.
      describe('the camera button', () => {
        const capture = (el: RRApp) =>
          editor(el).dispatchEvent(new CustomEvent('rr-frame-capture', { bubbles: true, composed: true }));

        it('adds the service\'s next frame, once per press', async () => {
          serveFrames();
          const { el, notify } = await mounted();
          await vi.waitFor(() => expect(editor(el).cameraReady).toBe(true));

          capture(el);
          await idle(el);
          capture(el);
          await idle(el);

          expect(images(el)).toHaveLength(2);
          const [first, second] = images(el).map(image => image.filename);
          expect(first).to.match(/^capture_[^.]+\.jpg$/);
          expect(second).not.toBe(first);
          expect(await archiveOf(el).getImage(first)).toEqual(FRAME_BYTES);
          expect(notify).toHaveBeenCalledWith(`Added ${first}`, 'success', 'file-earmark-plus');
        });

        it('is disabled while the service sends no frame', async () => {
          serveFrames({ frame: false });
          const { el } = await mounted();
          // Long enough for the watch to have had its answer.
          await new Promise(resolve => setTimeout(resolve, 50));
          await el.updateComplete;

          expect(editor(el).cameraReady).toBe(false);
        });

        it('says so when the service sends no frame for a press', async () => {
          serveFrames({ frame: false });
          const { el, notify } = await mounted();

          capture(el);
          await idle(el);

          expect(images(el)).toHaveLength(0);
          expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('No new picture'),
            'warning',
            'exclamation-triangle',
            Infinity
          );
        });
      });

      it('says so rather than nothing when a service left nothing open', async () => {
        // The service was found and its manifest would not load, so the live
        // view watches it with no session behind this component.
        let first = true;
        serve(() => {
          if (first) {
            first = false;
            return jsonManifest('"v1"');
          }
          return new Response('{"version": 3}', {
            headers: { 'content-type': 'application/json' },
          });
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { el, notify } = await mounted();
        expect(session(el)).to.be.null;
        const view = (await liveSources(el))!;

        press(view, 'f-1', FRAME_BYTES);

        expect(notify).toHaveBeenCalledWith(
          expect.stringContaining('No layout is open'),
          'warning',
          'exclamation-triangle',
          Infinity
        );
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
