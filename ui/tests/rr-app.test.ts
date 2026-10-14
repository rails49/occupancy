import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import '../src/rr-app.js';
import { RRApp } from '../src/rr-app.js';
import { R49Archive } from '@occupancy/r49';
import type { NotifyDetail } from '../src/rr-editor-view.js';
import type { EditHistory } from '../src/history.js';

vi.mock('@occupancy/classifier/browser', () => {
  return {
    BrowserClassifier: vi.fn().mockImplementation(() => {
      return {
        load: vi.fn().mockResolvedValue(undefined),
        classify: vi.fn().mockResolvedValue('track'),
        release: vi.fn().mockResolvedValue(undefined)
      };
    })
  };
});

// Mock global fetch for config.json
global.fetch = vi.fn().mockImplementation((url: string) => {
  if (url.endsWith('config.json')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        dpt: 30,
        crop_size: 96,
        labels: ['track', 'train'],
        mean: [0.485, 0.456, 0.406],
        std: [0.229, 0.224, 0.225]
      })
    });
  }
  return Promise.resolve({ ok: false });
});

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
    (el as any)._archive = archive;

    const exportSpy = vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    const notifySpy = vi.spyOn(el as any, '_notify');

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
    (el as any)._archive = archive;
    (el as any)._binding = { stem: 'west-yard' };

    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    const notifySpy = vi.spyOn(el as any, '_notify');

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
    (el as any)._archive = archive;
    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    const markSaved = vi.spyOn((el as any)._history as EditHistory, 'markSaved');

    await (el as any)._onFileSave();

    expect(markSaved).toHaveBeenCalled();
  });

  it('leaves the history dirty when the save picker is dismissed', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._archive = archive;
    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array());
    (window as any).showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException('dismissed', 'AbortError'));

    const markSaved = vi.spyOn((el as any)._history as EditHistory, 'markSaved');
    const notifySpy = vi.spyOn(el as any, '_notify');

    await (el as any)._onFileSave();

    expect(markSaved).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    delete (window as any).showSaveFilePicker;
  });

  it('toasts a notice the editor sends up', async () => {
    // The editor states its refusals but owns no place to put them; toasts
    // live here. A refusal is a warning, never a danger — nothing failed.
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._archive = archive;
    await el.updateComplete;
    const notify = vi.spyOn(el as any, '_notify');

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
      'exclamation-triangle'
    );
  });

  describe('undo, offered to the editor first', () => {
    /** An app showing the editor, with the editor's interception stubbed. */
    async function mount(intercepts: boolean) {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._archive = archive;
      await el.updateComplete;
      const view = el.renderRoot.querySelector('rr-editor-view')!;
      const intercept = vi.spyOn(view, 'interceptUndo').mockResolvedValue(intercepts);
      const undo = vi.spyOn((el as any)._history, 'undo');
      return { el, intercept, undo };
    }

    it('leaves the stack alone when a live chain consumes it', async () => {
      // A live chain is a wall undo cannot cross (SPEC.md § Undo and redo).
      const { el, intercept, undo } = await mount(true);

      await (el as any)._undo();

      expect(intercept).toHaveBeenCalled();
      expect(undo).not.toHaveBeenCalled();
    });

    it('goes to the stack when the editor does not consume it', async () => {
      const { el, intercept, undo } = await mount(false);

      await (el as any)._undo();

      expect(intercept).toHaveBeenCalled();
      expect(undo).toHaveBeenCalled();
    });

    it('offers redo to nobody — only undo is state-dependent', async () => {
      const { el, intercept } = await mount(true);

      await (el as any)._redo();

      expect(intercept).not.toHaveBeenCalled();
    });
  });

  describe('the reveal after an undo (#37)', () => {
    /** An app on an archive of two images, with one car on the second. */
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
      (el as any)._archive = archive;
      const history = (el as any)._history as EditHistory;
      history.attach(archive);
      await el.updateComplete;

      const image = archive.getManifest().images[1];
      await history.record('place car', { kind: 'image', filename: 'img2.jpg' }, () => {
        image.labels = [
          {
            id: 'car-a',
            class: 'stock',
            provenance: 'human',
            p0: { x: 10, y: 10 },
            p1: { x: 200, y: 10 },
          },
        ];
      });

      // The editor says so after every edit it records; the record above went
      // straight to the stack, so the affordances are told here instead.
      const view = el.renderRoot.querySelector('rr-editor-view')!;
      view.dispatchEvent(new CustomEvent('rr-history-change', { bubbles: true, composed: true }));
      await el.updateComplete;

      return { el, history, view };
    }

    it('selects the image before the snapshot lands, then reveals it', async () => {
      // The order the navigation invariant states: undo may move the user, but
      // it may never change something they cannot see (SPEC.md § Undo and redo).
      const { el, history, view } = await mountWithEdit();
      const select = vi.spyOn(view, 'selectImage');
      const undo = vi.spyOn(history, 'undo');
      const sync = vi.spyOn(view, 'syncFromArchive');

      await (el as any)._undo();

      expect(select).toHaveBeenCalledWith('img2.jpg');
      expect(select.mock.invocationCallOrder[0]).toBeLessThan(undo.mock.invocationCallOrder[0]);
      expect(undo.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]);
    });

    it('hands the editor what the entry changed, to highlight', async () => {
      const { el, view } = await mountWithEdit();
      const sync = vi.spyOn(view, 'syncFromArchive');

      await (el as any)._undo();

      expect(sync).toHaveBeenCalledWith('img2.jpg', [{ kind: 'car', id: 'car-a' }]);
    });

    it('does the same on redo', async () => {
      const { el, history, view } = await mountWithEdit();
      await history.undo();
      const sync = vi.spyOn(view, 'syncFromArchive');

      await (el as any)._redo();

      expect(sync).toHaveBeenCalledWith('img2.jpg', [{ kind: 'car', id: 'car-a' }]);
    });
  });

  // These prove the listener is registered and reads `isDirty`, and nothing
  // more. No browser here renders a leave-site dialog — jsdom dispatches the
  // event and records `defaultPrevented`, exactly as the viewer's CTM stub and
  // the File System Access fakes prove routing rather than behaviour.
  describe('the guard on closing the tab (#49)', () => {
    /** An app whose history has one unsaved edit on it. */
    async function mountDirty() {
      const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
      (el as any)._archive = archive;
      const history = (el as any)._history as EditHistory;
      history.attach(archive);
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
      (el as any)._archive = archive;

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

  it('reports a save failure', async () => {
    const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
    (el as any)._archive = archive;

    vi.spyOn(archive, 'export').mockRejectedValue(new Error('disk full'));
    const notifySpy = vi.spyOn(el as any, '_notify');

    await (el as any)._onFileSave();

    expect(notifySpy).toHaveBeenCalledWith(
      expect.stringContaining('Save failed'), 'danger', 'exclamation-diamond'
    );
  });
});
