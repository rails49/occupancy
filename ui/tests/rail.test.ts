import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { R49Archive } from '@occupancy/r49';
import type { LookCommand, LookView } from '@rails49/look';
import '../src/rr-app.js';
import { RRApp } from '../src/rr-app.js';
import type { EditHistory } from '../src/history.js';
import { GATE_REASON } from '../src/tools.js';

/**
 * The rail, as `rr-app` declares it on look's elements: the views, then File,
 * History and Tools while the editor is shown. How the rail draws is look's;
 * these assert what this app puts on it and what a press does.
 */

let archive: R49Archive;

beforeEach(() => {
  archive = new R49Archive();
  archive.setManifest({
    version: 4,
    layout: { name: 'Test', scale: 'N', calibration: { points: [] }, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [
      { filename: 'img1.jpg', labeled_complete: false, labels: [] },
      { filename: 'img2.jpg', labeled_complete: false, labels: [] },
    ],
  });
  vi.spyOn(archive, 'getImage').mockResolvedValue(new Uint8Array());
});

// `rr-app` listens on `window`, so a mounted-and-forgotten app would answer a
// later test's keystrokes.
afterEach(fixtureCleanup);

/** A spy on one of the app's handlers, taken before the template binds it. */
function spyOnHandler(name: string) {
  const spy = vi.spyOn(RRApp.prototype as any, name).mockResolvedValue(undefined);
  onTestFinished(() => spy.mockRestore());
  return spy;
}

/** Lets the editor report its state and the app draw the rail from it. */
async function settle(el: RRApp) {
  for (let i = 0; i < 5; i++) {
    await el.updateComplete;
    await el.renderRoot.querySelector('rr-editor-view')?.updateComplete;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function mount(open: R49Archive | null = archive) {
  const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
  if (open) {
    (el as any)._archive = open;
    ((el as any)._history as EditHistory).attach(open);
  }
  await settle(el);
  return el;
}

const command = (el: RRApp, id: string) => el.renderRoot.querySelector<LookCommand>(`#${id}`)!;

const groups = (el: RRApp) =>
  [...el.renderRoot.querySelectorAll('look-rail look-group')].map(g => g.getAttribute('label'));

/** A press as a person makes one: a click on the button inside the command. */
function press(cmd: LookCommand, init: MouseEventInit = {}) {
  cmd.shadowRoot!.querySelector('sl-icon-button')!.dispatchEvent(
    new MouseEvent('click', { bubbles: true, composed: true, ...init })
  );
}

/** Two calibration points at a nonzero separation: exactly "DPT resolves". */
function calibrate() {
  archive.getManifest().layout.calibration.points = [
    { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
    { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
  ];
}

describe('the views', () => {
  it('offers every mode as its own view, so none is two clicks away (#87)', async () => {
    const el = await mount(null);
    const labels = [...el.renderRoot.querySelectorAll<LookView>('look-view')].map(v => v.label);
    expect(labels).toEqual(['Label', 'Live', 'Diagnostics']);
  });

  it('marks the current view, on exactly one', async () => {
    const el = await mount(null);
    const current = el.renderRoot.querySelectorAll<LookView>('look-view[current]');
    expect(current).toHaveLength(1);
    expect(current[0].label).toBe('Label');
  });

  it('switches to the view chosen', async () => {
    const el = await mount(null);
    const diagnostics = el.renderRoot.querySelector<LookView>('look-view[name="diagnostics"]')!;

    diagnostics.shadowRoot!.querySelector('button')!.click();
    await settle(el);

    expect(el.renderRoot.querySelector('rr-diagnostics-view')).not.toBeNull();
    expect(el.renderRoot.querySelector<LookView>('look-view[current]')!.label).toBe('Diagnostics');
  });

  it('shows only the views outside the editor', async () => {
    const el = await mount();
    expect(groups(el)).toEqual(['File', 'History', 'Tools']);

    (el as any)._viewMode = 'diagnostics';
    await settle(el);

    expect(groups(el)).toEqual([]);
  });
});

describe('File', () => {
  it('offers New, Open and Save', async () => {
    const el = await mount(null);
    for (const id of ['file-new', 'file-open', 'file-save']) {
      expect(command(el, id), id).not.toBeNull();
    }
    expect(groups(el)).toEqual(['File', 'History']);
  });

  it('starts a new layout on New', async () => {
    const el = await mount(null);

    press(command(el, 'file-new'));
    await settle(el);

    expect(el.renderRoot.querySelector('look-about')!.getAttribute('name')).toBe('New Layout');
  });

  it('opens the file picker on Open', async () => {
    const open = spyOnHandler('_onFileOpen');
    const el = await mount(null);

    press(command(el, 'file-open'));

    expect(open).toHaveBeenCalled();
  });

  // Save As is a modifier rather than a button: on a browser without the File
  // System Access API it would do exactly what Save does (#48).
  it('saves on a click, and saves as on a Shift-click', async () => {
    const save = spyOnHandler('_onFileSave');
    const el = await mount();

    press(command(el, 'file-save'));
    press(command(el, 'file-save'), { shiftKey: true });

    expect(save.mock.calls).toEqual([[false], [true]]);
  });

  it('advertises Save As only where the browser can do it', async () => {
    const el = await mount(null);
    // jsdom has no File System Access API, so this is the fallback wording.
    expect(command(el, 'file-save').label).toBe('Save .r49 Archive');
  });
});

describe('History', () => {
  /** An app on the first image, with one car placed on the second. */
  async function mountWithEdit() {
    const el = await mount();
    const history = (el as any)._history as EditHistory;
    await history.record('place car', { kind: 'image', filename: 'img2.jpg' }, () => {
      archive.getManifest().images[1].labels = [
        { id: 'car-a', class: 'stock', provenance: 'human', p0: { x: 10, y: 10 }, p1: { x: 200, y: 10 } },
      ];
    });
    el.requestUpdate();
    await settle(el);
    return { el, history };
  }

  // The disabled state is the point of having buttons at all: it is the only
  // signal that distinguishes "the stack is empty" from "the undo landed on an
  // image you are not looking at". Keys alone cannot say that.
  it('disables Undo and Redo when there is no history', async () => {
    const el = await mount();
    expect(command(el, 'edit-undo').disabled).toBe(true);
    expect(command(el, 'edit-redo').disabled).toBe(true);
  });

  it('names the keys', async () => {
    const el = await mount();
    expect(command(el, 'edit-undo').key).toBe('Mod+Z');
    expect(command(el, 'edit-redo').key).toBe('Shift+Mod+Z');
  });

  it('names the image when the undo would land on another one', async () => {
    const { el } = await mountWithEdit();
    expect(command(el, 'edit-undo').disabled).toBe(false);
    expect(command(el, 'edit-undo').label).toBe('Undo place car — img2.jpg');
  });

  it('says only the edit when it lands on the image on screen', async () => {
    const { el } = await mountWithEdit();
    el.renderRoot.querySelector('rr-editor-view')!.selectImage('img2.jpg');
    await settle(el);

    expect(command(el, 'edit-undo').label).toBe('Undo place car');
  });

  it('says only the edit for a layout-scoped entry, which has no image', async () => {
    const el = await mount();
    const history = (el as any)._history as EditHistory;
    await history.record('rename layout', { kind: 'layout' }, () => {
      archive.getManifest().layout.name = 'Renamed';
    });
    el.requestUpdate();
    await settle(el);

    expect(command(el, 'edit-undo').label).toBe('Undo rename layout');
  });

  it('undoes on Undo, and moves the edit to Redo', async () => {
    const { el, history } = await mountWithEdit();

    press(command(el, 'edit-undo'));
    await settle(el);

    expect(history.canUndo).toBe(false);
    expect(command(el, 'edit-redo').disabled).toBe(false);
    expect(command(el, 'edit-redo').label).toBe('Redo place car');
  });
});

describe('Tools', () => {
  it('shows only while a manifest is loaded', async () => {
    expect(groups(await mount(null))).not.toContain('Tools');
    fixtureCleanup();
    expect(groups(await mount())).toContain('Tools');
  });

  it('offers calibration point, sensor and car', async () => {
    const el = await mount();
    for (const tool of ['calibration', 'sensor', 'car']) {
      expect(command(el, `tool-${tool}`), tool).not.toBeNull();
    }
  });

  it('marks the active tool, because a click means something different per tool', async () => {
    const el = await mount();
    expect(command(el, 'tool-calibration').pressed).toBe(true);
    expect(command(el, 'tool-sensor').pressed).toBe(false);
  });

  it('hands the chosen tool to the editor, and marks what the editor reports', async () => {
    calibrate();
    const el = await mount();

    press(command(el, 'tool-sensor'));
    await settle(el);

    expect(el.renderRoot.querySelector('rr-editor-view')!.railState.tool).toBe('sensor');
    expect(command(el, 'tool-sensor').pressed).toBe(true);
    expect(command(el, 'tool-calibration').pressed).toBe(false);
  });

  describe('the calibration gate', () => {
    it('disables the labeling tools while DPT is unresolved, and says why', async () => {
      const el = await mount();

      for (const tool of ['sensor', 'car']) {
        expect(command(el, `tool-${tool}`).disabled, tool).toBe(true);
        expect(command(el, `tool-${tool}`).reason, tool).toBe(GATE_REASON);
      }
      // Calibration is the tool that *produces* the DPT: gating it deadlocks.
      expect(command(el, 'tool-calibration').disabled).toBe(false);
      expect(command(el, 'tool-calibration').reason).toBe('');
    });

    it('names calibration and DPT in the reason', () => {
      expect(GATE_REASON.toLowerCase()).toContain('calibrate');
      expect(GATE_REASON).toContain('DPT');
    });

    it('opens them the moment calibration resolves', async () => {
      // Gated on existence, never on completion.
      calibrate();
      const el = await mount();

      for (const tool of ['sensor', 'car']) {
        expect(command(el, `tool-${tool}`).disabled, tool).toBe(false);
        expect(command(el, `tool-${tool}`).reason, tool).toBe('');
      }
    });
  });
});
