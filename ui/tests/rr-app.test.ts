import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import '../src/rr-app.js';
import { RRApp } from '../src/rr-app.js';
import { R49Archive, getDPT } from '@rails49/r49';
import type { NotifyDetail } from '../src/rr-editor-view.js';
import type { EditHistory } from '../src/history.js';
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

  describe('the occupancy service on this origin (#331)', () => {
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
    });

    const served = {
      version: 4,
      layout: { name: 'Served', scale: 'N', calibration: { points: [] }, sensors: [] },
      camera: { resolution: { width: 640, height: 480 } },
      images: [],
    };

    /**
     * Answer the manifest path with `manifest` and hold every `latest` open.
     *
     * Holding rather than answering keeps the loop parked on its first request:
     * what these tests are about is whether the page found a service, not what
     * it does with its frames.
     */
    function serve(manifest: Response | Error) {
      global.fetch = vi.fn(async (url: string) => {
        if (String(url).includes('manifest.json')) {
          if (manifest instanceof Error) throw manifest;
          return manifest.clone();
        }
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;
    }

    const jsonManifest = () =>
      new Response(JSON.stringify(served), { headers: { 'content-type': 'application/json' } });

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

    it('hands a service it found to the live view, as both of its sources', async () => {
      serve(jsonManifest());
      const { el, notify } = await mounted();

      const view = (await liveSources(el))!;
      expect(view.sources).to.not.be.null;
      // One object answers a frame and that frame's L1 together, so it is both.
      expect(view.sources!.frames).toBe(view.sources!.results);
      // And no archive: the page starts with none, and opening one is what
      // leaves the service behind.
      expect(view.archive).to.be.null;
      expect(notify).not.toHaveBeenCalled();
    });

    // The page still opens in the editor; the check only decides what Live
    // shows when the person presses it.
    it('still starts in the editor', async () => {
      serve(jsonManifest());
      const { el } = await mounted();

      expect(el.shadowRoot!.querySelector('rr-editor-view')).to.exist;
      expect(el.shadowRoot!.querySelector('rr-live-view')).to.be.null;
    });

    const noService: [string, () => Response | Error][] = [
      // The cloud copy of this page answers every unknown path with its own
      // HTML, so `response.ok` alone would find a service on a static host.
      ['a 200 text/html answer', () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })],
      ['a 404', () => new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } })],
      ['a request that failed', () => new TypeError('Failed to fetch')],
    ];

    for (const [what, answer] of noService) {
      it(`finds no service in ${what}, and says nothing about it`, async () => {
        serve(answer());
        const { el, notify } = await mounted();

        const view = (await liveSources(el))!;
        expect(view.sources).to.be.null;
        // Silent: a page with no service is the page as it has always been,
        // and a toast on every load of the deployed site would be noise.
        expect(notify).not.toHaveBeenCalled();
      });
    }

    it('leaves the service behind when an archive is created', async () => {
      serve(jsonManifest());
      const { el } = await mounted();
      expect((await liveSources(el))!.sources).to.not.be.null;

      (el as unknown as { _viewMode: string })._viewMode = 'editor';
      await (el as unknown as { _onFileNew(): Promise<void> })._onFileNew();
      await el.updateComplete;

      const view = (await liveSources(el))!;
      expect(view.sources).to.be.null;
      expect(view.archive).to.not.be.null;
    });

    it('ignores a service that answers after an archive has been opened', async () => {
      // The race the check's own latency opens: the person pressed New before
      // the manifest came back.
      let answer!: (response: Response) => void;
      global.fetch = vi.fn(
        async () => new Promise<Response>(resolve => (answer = resolve))
      ) as unknown as typeof fetch;

      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      await (el as unknown as { _onFileNew(): Promise<void> })._onFileNew();
      answer(jsonManifest());
      await new Promise(resolve => setTimeout(resolve, 0));
      await el.updateComplete;

      expect((await liveSources(el))!.sources).to.be.null;
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
