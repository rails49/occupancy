import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive, getDPT } from '@occupancy/r49';
import type { CalibrationPoint, CarLabel, Point, Sensor, WorldPoint } from '@occupancy/r49';
import { EditHistory } from '../src/history.js';
import { HIGHLIGHT_DURATION_MS } from '../src/highlight.js';
import { classChoices, rootClass } from '../src/vocabulary.js';
import '../src/rr-editor-view.js';
import { RREditorView } from '../src/rr-editor-view.js';
import type { RRCalibrationDialog } from '../src/rr-calibration-dialog.js';
import type { RRSensorDialog } from '../src/rr-sensor-dialog.js';
import type { EditorTool } from '../src/tools.js';
import type { RRContextMenu } from '../src/rr-context-menu.js';
import type { EditorStateDetail, NotifyDetail } from '../src/rr-editor-view.js';
import type { SlCheckbox } from '@shoelace-style/shoelace';
import type { Rect } from '../src/geometry.js';

// The camera and the drift check are both mocked: one needs `getUserMedia` and
// the other decodes blobs through `createImageBitmap` and reads pixels back out
// of a canvas, and jsdom has none of the three. What the tests below prove is
// that a drift verdict reaches the screen and blocks nothing — the measurement
// is `lib/drift`'s to prove and `tools/drift-bench` scores it.
const captureFromCamera = vi.fn(async () => new Uint8Array([1, 2, 3]));
const check = vi.fn(async () => ({ displacementPx: 0, refIndex: 0 }));
const openDriftCheck = vi.fn(async (..._args: unknown[]) => ({
  check: { check },
  refName: 'img1.jpg',
}));

vi.mock('../src/capture.js', () => ({
  DEFAULT_CAMERA_CONSTRAINTS: { video: true, audio: false },
  getCameraStream: async () => ({ getTracks: () => [] }),
  captureFromCamera: () => captureFromCamera(),
}));

// `maxDriftPx` is the real implementation: it is pure arithmetic over
// MAX_DRIFT_TRACK_FRACTION and a DPT, and it is what makes the tolerance
// geometric rather than an absolute pixel count. Only the IO is stubbed.
vi.mock('../src/driftSession.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/driftSession.js')>();
  return {
    maxDriftPx: actual.maxDriftPx,
    openDriftCheck: (...args: unknown[]) => (openDriftCheck as any)(...args),
    planeFromBytes: async () => ({ width: 4, height: 4, data: new Float32Array(16) }),
    grabPlane: () => ({ width: 4, height: 4, data: new Float32Array(16) }),
  };
});

// Mock ResizeObserver for RRViewer
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver for Shoelace
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock matchMedia for Shoelace
window.matchMedia = vi.fn().mockImplementation(query => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

// Mock getAnimations/animate for Shoelace
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = vi.fn().mockReturnValue([]);
}
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockImplementation(() => ({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(),
    reverse: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('rr-editor-view', () => {
  let archive: R49Archive;

  beforeEach(async () => {
    // Create a dummy archive
    archive = new R49Archive();
    archive.setManifest({
      version: 4,
      layout: { name: 'Test Layout', scale: 'N', calibration: { points: [] }, sensors: [] },
      camera: { resolution: { width: 100, height: 100 } },
      images: [
        { filename: 'img1.jpg', labeled_complete: false, labels: [] }
      ]
    });

    // Mock getImage to return empty data
    vi.spyOn(archive, 'getImage').mockResolvedValue(new Uint8Array());

    // Mock URL.createObjectURL
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  it('is defined', () => {
    const el = document.createElement('rr-editor-view');
    expect(el).to.be.instanceOf(RREditorView);
  });

  it('renders placeholder when no archive is provided', async () => {
    const el = await fixture<RREditorView>(html`<rr-editor-view></rr-editor-view>`);
    expect(el.shadowRoot!.textContent).to.contain('No archive loaded');
  });

  it('renders components when archive is provided', async () => {
    const el = await fixture<RREditorView>(html`
      <rr-editor-view .archive=${archive}></rr-editor-view>
    `);

    expect(el.shadowRoot!.querySelector('rr-viewer')).to.exist;
    expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')).to.exist;
  });

  describe('DPT readout', () => {
    it('reports "not calibrated" when no DPT resolves', async () => {
      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      const bar = el.shadowRoot!.querySelector('.dpt-bar')!;
      expect(bar).to.exist;
      expect(bar.classList.contains('uncalibrated')).to.be.true;
      expect(bar.textContent).to.contain('Not calibrated');
    });

    it('reports the DPT when calibration resolves', async () => {
      // 100 px over 10 mm in N scale (gauge 1435/160 mm) => 10 px/mm * 8.97 mm
      archive.getManifest().layout.calibration = {
        points: [
          { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
          { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
        ],
      };

      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      const bar = el.shadowRoot!.querySelector('.dpt-bar')!;
      expect(bar.classList.contains('uncalibrated')).to.be.false;
      expect(bar.textContent).to.contain('DPT 89.7');
    });
  });

  describe('the frame-mismatch warning (#41)', () => {
    /** What `rr-viewer` emits when the media reports its own size. */
    function reportMedia(
      el: RREditorView,
      media: { width: number; height: number },
      aspectMismatch: boolean
    ) {
      el.shadowRoot!.querySelector('rr-viewer')!.dispatchEvent(
        new CustomEvent('rr-media-frame', {
          detail: { media, frame: { width: 100, height: 100 }, aspectMismatch },
          bubbles: true,
          composed: true,
        })
      );
    }

    it('says nothing while the image is the shape the archive declares', async () => {
      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      reportMedia(el, { width: 400, height: 400 }, false);
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.frame-warning')).to.not.exist;
    });

    it('names both sizes when the shapes disagree', async () => {
      // The two numbers are what says which half is wrong: a re-cropped photo
      // and a mis-typed `camera.resolution` read identically without them.
      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      reportMedia(el, { width: 200, height: 100 }, true);
      await el.updateComplete;

      const bar = el.shadowRoot!.querySelector('.frame-warning')!;
      expect(bar).to.exist;
      expect(bar.textContent).to.contain('200×100');
      expect(bar.textContent).to.contain('100×100');
    });

    it('clears the warning when another image is selected', async () => {
      // It belongs to the image that earned it; the next one reports its own
      // size when it decodes, and one that never decodes must not inherit this.
      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      reportMedia(el, { width: 200, height: 100 }, true);
      await el.updateComplete;

      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index: 0 }, bubbles: true, composed: true })
      );
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.frame-warning')).to.not.exist;
    });

    it('does not block editing', async () => {
      // Like a below-minimum DPT: the archive is inconsistent, and the labeler
      // still has work to do on it.
      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      reportMedia(el, { width: 200, height: 100 }, true);
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('rr-viewer')).to.exist;
    });
  });

  describe('the camera-drift readout (#95, #118)', () => {
    /**
     * The tolerance is a fraction of a track width, so these tests need a DPT.
     *
     * 100 px over 10 model mm in N scale resolves DPT 89.6875, putting the
     * tolerance at 22.42 px. The outer suite's archive is uncalibrated on purpose
     * — the DPT readout tests up there depend on it — so this is added here.
     */
    const TOLERANCE_PX = 0.25 * 89.6875;

    beforeEach(() => {
      captureFromCamera.mockClear();
      check.mockClear();
      openDriftCheck.mockClear();
      check.mockImplementation(async () => ({ displacementPx: 0, refIndex: 0 }));
      openDriftCheck.mockImplementation(async () => ({ check: { check }, refName: 'img1.jpg' }));
      const manifest = archive.getManifest();
      manifest.layout.calibration = {
        points: [
          { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
          { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
        ],
      };
      // Three images, so there is a reference and two things measured against it.
      manifest.images = [
        { filename: 'img1.jpg', labeled_complete: false, labels: [] },
        { filename: 'img2.jpg', labeled_complete: false, labels: [] },
        { filename: 'img3.jpg', labeled_complete: false, labels: [] },
      ];
    });

    /** What `rr-thumbnail-bar` emits when the user adds an image. */
    function addImage(el: RREditorView, source: 'camera' | 'file') {
      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-add', { detail: { source }, bubbles: true, composed: true })
      );
    }

    function select(el: RREditorView, index: number) {
      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index }, bubbles: true, composed: true })
      );
    }

    function reorder(el: RREditorView, from: number, to: number) {
      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-reorder', { detail: { from, to }, bubbles: true, composed: true })
      );
    }

    function remove(el: RREditorView, index: number) {
      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-delete', { detail: { index }, bubbles: true, composed: true })
      );
    }

    const bar = (el: RREditorView) => el.shadowRoot!.querySelector('.drift-warning');
    /** Amber only: a finding, not the reference row and not a measured-fine row. */
    const warning = (el: RREditorView) =>
      el.shadowRoot!.querySelector('.drift-warning:not(.reference):not(.steady):not(.checking)');

    /** The sweep is deliberately not awaited, so wait for its effect. */
    async function waitFor(el: RREditorView, done: () => boolean) {
      for (let i = 0; i < 200 && !done(); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        await el.updateComplete;
      }
      await el.updateComplete;
    }

    async function mount() {
      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      await waitFor(el, () => check.mock.calls.length >= 2);
      return el;
    }

    it('calls the first image the reference, rather than measuring it', async () => {
      // "Zero because it is the reference" and "measured and found steady" are
      // different claims, and only the first is true at position 0. It also opens
      // on this image, so it is the first thing a labeler reads.
      const el = await mount();

      const row = bar(el)!;
      expect(row.classList.contains('reference')).to.be.true;
      expect(row.textContent).to.match(/reference image/i);
      expect(row.textContent).to.match(/zero drift by definition/i);
      // And it says how to change it, because the reference is user-movable.
      expect(row.textContent).to.match(/drag another thumbnail/i);
    });

    it('measures every other image against the reference, and never the reference itself', async () => {
      // Three images means two measurements. Asking whether image 0 matches
      // itself would be asking a question with a fixed answer.
      const el = await mount();

      expect(check).toHaveBeenCalledTimes(2);
      expect(el).to.exist;
    });

    it('reports a measurement inside tolerance rather than staying silent', async () => {
      // The property that keeps a user-movable reference honest (#118): if the
      // row appeared only past the tolerance, a reorder could re-point the pose
      // with nothing on screen moving.
      check.mockImplementation(async () => ({ displacementPx: 6, refIndex: 0 }));
      const el = await mount();

      select(el, 1);
      await el.updateComplete;

      const row = bar(el)!;
      expect(row.classList.contains('steady')).to.be.true;
      expect(row.textContent).to.contain('6.0 px');
      expect(row.textContent).to.contain(TOLERANCE_PX.toFixed(1));
      // Not a finding: amber is reserved for a measurement past the tolerance.
      expect(warning(el)).to.not.exist;
    });

    it('warns about an image past the tolerance', async () => {
      check.mockImplementation(async () => ({ displacementPx: 40.4, refIndex: 0 }));
      const el = await mount();

      select(el, 1);
      await el.updateComplete;

      const row = warning(el)!;
      expect(row).to.exist;
      expect(row.textContent).to.contain('40.4 px');
      // In track widths too, the unit the tolerance is set in.
      expect(row.textContent).to.contain('0.45 track widths');
      expect(row.textContent).to.contain(TOLERANCE_PX.toFixed(1));
      // The corrected consequence: a car span is authored on this image's own
      // pixels, so labeling it is fine. What is off is the per-layout overlay.
      expect(row.textContent).to.match(/Labeling this image is unaffected/i);
      expect(row.textContent).to.match(/nothing is blocked/i);
    });

    it('blocks nothing — the image stays selectable and labelable', async () => {
      check.mockImplementation(async () => ({ displacementPx: 60, refIndex: 0 }));
      const el = await mount();
      select(el, 1);
      await el.updateComplete;

      // The MIN_DPT precedent: a human is present and can judge, and blocking
      // authoring on a heuristic would be worse than the disease.
      expect(warning(el)).to.exist;
      expect(el.shadowRoot!.querySelector('rr-viewer')).to.exist;
    });

    it('keeps each image its own verdict when the user browses away and back', async () => {
      // Persistent, not a toast: it is a property of the image, and it matters at
      // labeling time rather than at capture time.
      check.mockImplementation(async () => ({ displacementPx: 40, refIndex: 0 }));
      const el = await mount();

      select(el, 1);
      await el.updateComplete;
      expect(warning(el)).to.exist;

      select(el, 0);
      await el.updateComplete;
      expect(bar(el)!.classList.contains('reference')).to.be.true;

      select(el, 1);
      await el.updateComplete;
      expect(warning(el)).to.exist;
    });

    it('re-measures the whole archive when the strip is reordered', async () => {
      // A reorder can change which image is the reference, which is the design
      // rather than a hazard (#118) — but only if every number on screen moves
      // with it. Stale measurements against a former reference would be worse
      // than none.
      const el = await mount();
      const before = check.mock.calls.length;

      reorder(el, 2, 0);
      await waitFor(el, () => check.mock.calls.length > before);

      expect(check.mock.calls.length).to.be.greaterThan(before);
    });

    it('measures only the new image on an add, since appending cannot move the reference', async () => {
      const el = await mount();
      check.mockClear();
      openDriftCheck.mockClear();

      addImage(el, 'camera');
      await waitFor(el, () => check.mock.calls.length > 0);

      // One check, not a re-sweep of the archive: a labeler adding a dozen
      // captures in a row should not pay for the whole archive a dozen times.
      expect(check).toHaveBeenCalledTimes(1);
      expect(archive.getManifest().images).to.have.lengthOf(4);
    });

    it('checks an image picked off the filesystem too', async () => {
      // #95 names the capture path, and a fresh capture is what it was written
      // about — but a file picked from disk is as likely to come from a session
      // where the tripod had moved, and two paths would mean one of them
      // silently trusting what the other checked.
      const el = await mount();
      check.mockClear();
      check.mockImplementation(async () => ({ displacementPx: 30.5, refIndex: 0 }));

      const create = document.createElement.bind(document);
      const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const node = create(tag as 'input');
        if (tag === 'input') {
          node.click = () =>
            (node as any).onchange({
              target: { files: [{ arrayBuffer: async () => new Uint8Array([9, 9]).buffer }] },
            });
        }
        return node;
      }) as typeof document.createElement);
      addImage(el, 'file');
      spy.mockRestore();

      await waitFor(el, () => check.mock.calls.length > 0);
      await waitFor(el, () => warning(el) !== null);
      expect(warning(el)!.textContent).to.contain('30.5 px');
    });

    it('re-measures when the reference image is deleted, and only drops a row otherwise', async () => {
      const el = await mount();

      // Rebuilding the reference is the signal, not the number of measurements:
      // deleting down to a single image leaves a valid reference and nothing to
      // measure against it.
      openDriftCheck.mockClear();

      // Deleting a non-reference image invalidates nothing.
      remove(el, 2);
      await el.updateComplete;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(openDriftCheck).not.toHaveBeenCalled();

      // Deleting position 0 promotes the next image to reference, so every
      // measurement taken was against an image that no longer defines the pose.
      remove(el, 0);
      await waitFor(el, () => openDriftCheck.mock.calls.length > 0);
      expect(openDriftCheck).toHaveBeenCalled();
    });

    it('says nothing at all on an uncalibrated layout, which has no track width', async () => {
      archive.getManifest().layout.calibration = { points: [] };

      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      await new Promise(resolve => setTimeout(resolve, 50));
      await el.updateComplete;

      // Not even the reference row: a fraction of a track width needs a track
      // width, and the calibration gate already has the labeler's attention.
      expect(bar(el)).to.not.exist;
      expect(openDriftCheck).not.toHaveBeenCalled();
    });

    it('leaves no row for an image whose measurement failed', async () => {
      // Silence beats a fabricated zero. The image is in the archive and
      // labelable; the console gets the error.
      openDriftCheck.mockImplementation(async () => {
        throw new Error('decode failed');
      });

      const el = await fixture<RREditorView>(html`
        <rr-editor-view .archive=${archive}></rr-editor-view>
      `);
      await waitFor(el, () => openDriftCheck.mock.calls.length > 0);

      select(el, 1);
      await el.updateComplete;
      expect(bar(el)).to.not.exist;
      expect(archive.getManifest().images).to.have.lengthOf(3);
    });
  });

  // Car authoring and sensor placement are still absent — they belong to the
  // editor spec's later tickets (#31). Calibration points are the one thing
  // this editor authors, and they go through `calibrationPoints`.
  it('passes no interactive or marker state to the viewer', async () => {
    const el = await fixture<RREditorView>(html`
      <rr-editor-view .archive=${archive}></rr-editor-view>
    `);
    const viewer = el.shadowRoot!.querySelector('rr-viewer')! as any;

    expect(viewer.interactive).to.be.undefined;
    expect(viewer.activeTool).to.be.undefined;
    expect(viewer.calibration).to.be.undefined;
    // Nor the live view's two: the editor shows what a human authored, never
    // what a model predicted. `sensorStates` is `null` rather than empty —
    // nothing is reading these sensors, which is not the same as reading them
    // and finding nothing (#85).
    expect(viewer.detections).to.deep.equal([]);
    expect(viewer.sensorStates).to.be.null;
  });

  /** Lets the editor's async pointer and commit handlers settle. */
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  /**
   * One `rr-pointer-*` event, shaped the way `rr-viewer` emits it.
   *
   * `pointerId` tells a second finger from the first; `button` is 0 for the
   * primary press and 2 for a right-click, which the editor must not author
   * on.
   */
  function gesture(
    el: RREditorView,
    name: string,
    point: Point,
    imagePxPerScreenPx: number,
    {
      pointerId = 1,
      button = 0,
      shiftKey = false,
      client,
    }: {
      pointerId?: number;
      button?: number;
      /** Shift means "zoom to a rect wherever this drag began" (#44). */
      shiftKey?: boolean;
      /** Where the pointer is on the **glass** — only a pan reads it. */
      client?: { x: number; y: number };
    } = {}
  ) {
    el.shadowRoot!.querySelector('rr-viewer')!.dispatchEvent(
      new CustomEvent(name, {
        detail: {
          point,
          imagePxPerScreenPx,
          originalEvent: Object.assign(
            new MouseEvent(name, {
              button,
              shiftKey,
              clientX: client?.x ?? 0,
              clientY: client?.y ?? 0,
            }),
            { pointerId }
          ),
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** A press and a release at the same pixel: a click. */
  async function clickAt(el: RREditorView, point: Point, imagePxPerScreenPx = 1) {
    gesture(el, 'rr-pointer-down', point, imagePxPerScreenPx);
    gesture(el, 'rr-pointer-up', point, imagePxPerScreenPx);
    await flush();
    await el.updateComplete;
  }

  /** A press, a run of moves, and a release. One gesture, one pointerId. */
  async function drag(el: RREditorView, path: readonly Point[], imagePxPerScreenPx = 1) {
    gesture(el, 'rr-pointer-down', path[0], imagePxPerScreenPx);
    for (const point of path.slice(1)) {
      gesture(el, 'rr-pointer-move', point, imagePxPerScreenPx);
    }
    gesture(el, 'rr-pointer-up', path[path.length - 1], imagePxPerScreenPx);
    await flush();
    await el.updateComplete;
  }

  /** What the dialog emits when the user confirms a coordinate. */
  async function commit(el: RREditorView, world: WorldPoint) {
    el.shadowRoot!.querySelector('rr-calibration-dialog')!.dispatchEvent(
      new CustomEvent('rr-calibration-commit', {
        detail: { world },
        bubbles: true,
        composed: true,
      })
    );
    await flush();
    await el.updateComplete;
  }

  function dialogOf(el: RREditorView): RRCalibrationDialog {
    return el.shadowRoot!.querySelector('rr-calibration-dialog')!;
  }

  /** Silences the real dialog's DOM work and records how it was opened. */
  function stubDialog(el: RREditorView) {
    const dialog = dialogOf(el);
    return vi.spyOn(dialog, 'show').mockResolvedValue(undefined);
  }

  /** The same, for the sensor name dialog. */
  function stubSensorDialog(el: RREditorView) {
    const dialog = el.shadowRoot!.querySelector<RRSensorDialog>('rr-sensor-dialog')!;
    return vi.spyOn(dialog, 'show').mockResolvedValue(undefined);
  }

  function points(): CalibrationPoint[] {
    return archive.getManifest().layout.calibration.points;
  }

  function sensors(): Sensor[] {
    return archive.getManifest().layout.sensors;
  }

  async function mount(history?: EditHistory) {
    const el = await fixture<RREditorView>(html`
      <rr-editor-view .archive=${archive} .history=${history ?? null}></rr-editor-view>
    `);
    stubDialog(el);
    stubSensorDialog(el);
    return el;
  }

  function menuOf(el: RREditorView): RRContextMenu {
    return el.shadowRoot!.querySelector('rr-context-menu')!;
  }

  /**
   * The menu's **top-level** rows, by id. Empty when it is closed.
   *
   * A row that opens a submenu carries its id in `data-id` rather than in
   * `value`, because it is opened rather than chosen — see `rr-context-menu`.
   */
  function menuItems(el: RREditorView): string[] {
    const menu = menuOf(el).shadowRoot!.querySelector('sl-menu');
    return menu ? [...menu.children].map(item => item.getAttribute('data-id') ?? '') : [];
  }

  /** The rows of the submenu under the top-level row with `id`, by id. */
  function submenuItems(el: RREditorView, id: string): string[] {
    const parent = menuOf(el).shadowRoot!.querySelector(`sl-menu-item[data-id="${id}"]`)!;
    return [...parent.querySelector('sl-menu[slot="submenu"]')!.children].map(
      item => item.getAttribute('data-id') ?? ''
    );
  }

  /**
   * A right-click, shaped the way `rr-viewer` emits one. Returns the
   * underlying event so the caller can check the native menu was suppressed.
   */
  async function rightClickAt(
    el: RREditorView,
    point: Point,
    client: { x: number; y: number } = { x: 0, y: 0 },
    imagePxPerScreenPx = 1
  ): Promise<MouseEvent> {
    const originalEvent = new MouseEvent('contextmenu', {
      cancelable: true,
      clientX: client.x,
      clientY: client.y,
    });
    el.shadowRoot!.querySelector('rr-viewer')!.dispatchEvent(
      new CustomEvent('rr-pointer-contextmenu', {
        detail: { point, imagePxPerScreenPx, originalEvent },
        bubbles: true,
        composed: true,
      })
    );
    await flush();
    await el.updateComplete;
    await menuOf(el).updateComplete;
    return originalEvent;
  }

  /**
   * Chooses a row the way `sl-menu` reports one, so the whole chain runs:
   * the menu closes itself and the editor hears the selection.
   */
  async function choose(el: RREditorView, id: string) {
    const menu = menuOf(el);
    const item = menu.shadowRoot!.querySelector(`sl-menu-item[value="${id}"]`)!;
    menu.shadowRoot!.querySelector('sl-menu')!.dispatchEvent(
      new CustomEvent('sl-select', { detail: { item }, bubbles: true, composed: true })
    );
    await flush();
    await el.updateComplete;
  }

  describe('calibration authoring', () => {
    it('shows the layout\'s calibration points on the viewer', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 10, y: 20 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.calibrationPoints).to.deep.equal(points());
    });

    it('asks for a coordinate on a click, and places nothing until it is given', async () => {
      const el = await mount();
      const show = stubDialog(el);

      await clickAt(el, { x: 120, y: 200 });

      expect(show).toHaveBeenCalledOnce();
      expect(points()).to.have.length(0);
    });

    it('places the clicked pixel once the coordinate commits', async () => {
      const el = await mount();
      await clickAt(el, { x: 120.4, y: 200.6 });
      await commit(el, { x: 0, y: 250, z: 0 });

      // The click names a pixel, so the stored position is a whole one.
      expect(points()).to.deep.equal([
        { px: { x: 120, y: 201 }, world: { x: 0, y: 250, z: 0 } },
      ]);
    });

    it('records one layout entry per placement, and undo reverses it', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await clickAt(el, { x: 10, y: 10 });
      await commit(el, { x: 0, y: 0, z: 0 });
      await clickAt(el, { x: 110, y: 10 });
      await commit(el, { x: 10, y: 0, z: 0 });

      expect(history.size).to.equal(2);
      expect(points()).to.have.length(2);

      const entry = await history.undo();
      expect(entry!.target).to.deep.equal({ kind: 'layout' });
      expect(entry!.label).to.contain('calibration');
      expect(points()).to.have.length(1);

      await history.redo();
      expect(points()).to.have.length(2);
    });

    it('edits the point under the click instead of stacking another on it', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);
      const show = stubDialog(el);

      // Within the grab radius of the existing point.
      await clickAt(el, { x: 105, y: 103 });
      expect(show).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { mode: 'edit' });

      await commit(el, { x: 0, y: 250, z: 0 });

      expect(points()).to.deep.equal([
        { px: { x: 100, y: 100 }, world: { x: 0, y: 250, z: 0 } },
      ]);
      expect(history.size).to.equal(1);

      await history.undo();
      expect(points()[0].world).to.deep.equal({ x: 0, y: 0, z: 0 });
    });

    it('places a new point when the click is beyond the grab radius', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();
      await clickAt(el, { x: 300, y: 300 });
      await commit(el, { x: 20, y: 0, z: 0 });

      expect(points()).to.have.length(2);
    });

    it('scales the grab radius with the zoom the viewer reports', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();
      const show = stubDialog(el);

      // 40 image px away: outside the radius at 1:1, inside it when each screen
      // pixel covers four image pixels.
      await clickAt(el, { x: 140, y: 100 }, 4);

      expect(show).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { mode: 'edit' });
    });

    it('ignores a drag, so a swipe over the image places nothing', async () => {
      const el = await mount();
      const show = stubDialog(el);

      await drag(el, [{ x: 100, y: 100 }, { x: 400, y: 250 }]);

      expect(show).not.toHaveBeenCalled();
      expect(points()).to.have.length(0);
    });

    it('tolerates the hand tremor inside a click, and uses the press position', async () => {
      const el = await mount();
      // Two image pixels apart at 1:1 — inside the slop.
      gesture(el, 'rr-pointer-down', { x: 300, y: 200 }, 1);
      gesture(el, 'rr-pointer-up', { x: 302, y: 201 }, 1);
      await flush();
      await el.updateComplete;
      await commit(el, { x: 0, y: 0, z: 0 });

      expect(points()[0].px).to.deep.equal({ x: 300, y: 200 });
    });

    describe('dragging', () => {
      /** One calibration point, at a round pixel. */
      function seed(...pixels: readonly Point[]) {
        archive.getManifest().layout.calibration.points = pixels.map((px, i) => ({
          px,
          world: { x: i * 10, y: 0, z: 0 },
        }));
      }

      it('moves the point that was grabbed, keeping the grab offset', async () => {
        seed({ x: 100, y: 100 });
        const el = await mount();
        const show = stubDialog(el);

        // Pressed three pixels off-center: the point must translate by the
        // delta, not teleport under the cursor.
        await drag(el, [
          { x: 103, y: 102 },
          { x: 150, y: 150 },
          { x: 203, y: 202 },
        ]);

        expect(points()[0].px).to.deep.equal({ x: 200, y: 200 });
        expect(show).not.toHaveBeenCalled();
      });

      it('records exactly one entry however many move events fired', async () => {
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        const path: Point[] = [{ x: 100, y: 100 }];
        for (let i = 1; i <= 200; i++) path.push({ x: 100 + i, y: 100 });
        await drag(el, path);

        expect(points()[0].px).to.deep.equal({ x: 300, y: 100 });
        expect(history.size).to.equal(1);
        expect(history.undoLabel).to.contain('calibration');
      });

      it('undo returns the point to where the drag began, and redo reapplies it', async () => {
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        await drag(el, [
          { x: 100, y: 100 },
          { x: 400, y: 250 },
        ]);
        expect(points()[0].px).to.deep.equal({ x: 400, y: 250 });

        const entry = await history.undo();
        expect(entry!.target).to.deep.equal({ kind: 'layout' });
        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });

        await history.redo();
        expect(points()[0].px).to.deep.equal({ x: 400, y: 250 });
      });

      it('records nothing for a drag returned to its origin', async () => {
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);
        const show = stubDialog(el);

        await drag(el, [
          { x: 100, y: 100 },
          { x: 400, y: 250 },
          { x: 100, y: 100 },
        ]);

        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
        expect(history.size).to.equal(0);
        expect(history.isDirty).to.be.false;
        // And it is still a drag, not a click: the dialog must not open on a
        // gesture the user spent moving something.
        expect(show).not.toHaveBeenCalled();
      });

      it('commits a drag that leaves the viewer, since the pointer is captured', async () => {
        // The capture lives in `rr-viewer`; what the editor owes it is not
        // bailing on coordinates outside the image. The overlay covers the
        // letterbox and a captured drag reports past the element entirely.
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        await drag(el, [
          { x: 100, y: 100 },
          { x: -400, y: -300 },
        ]);

        expect(points()[0].px).to.deep.equal({ x: -400, y: -300 });
        expect(history.size).to.equal(1);
      });

      it('restores the point and records nothing when the browser cancels', async () => {
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
        gesture(el, 'rr-pointer-move', { x: 400, y: 250 }, 1);
        gesture(el, 'rr-pointer-cancel', { x: 400, y: 250 }, 1);
        await flush();
        await el.updateComplete;

        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
        expect(history.size).to.equal(0);
      });

      it('ignores a second finger arriving mid-drag', async () => {
        seed({ x: 100, y: 100 }, { x: 500, y: 500 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1, { pointerId: 1 });
        gesture(el, 'rr-pointer-down', { x: 500, y: 500 }, 1, { pointerId: 2 });
        gesture(el, 'rr-pointer-move', { x: 600, y: 600 }, 1, { pointerId: 2 });
        gesture(el, 'rr-pointer-up', { x: 600, y: 600 }, 1, { pointerId: 2 });
        gesture(el, 'rr-pointer-move', { x: 140, y: 130 }, 1, { pointerId: 1 });
        gesture(el, 'rr-pointer-up', { x: 140, y: 130 }, 1, { pointerId: 1 });
        await flush();
        await el.updateComplete;

        // The second finger moved nothing, and the first still committed once.
        expect(points()[1].px).to.deep.equal({ x: 500, y: 500 });
        expect(points()[0].px).to.deep.equal({ x: 140, y: 130 });
        expect(history.size).to.equal(1);
      });

      it('restores a cancelled drag with no history attached at all', async () => {
        // The restore is by handle, not by snapshot, precisely so it does not
        // depend on a stack being there.
        seed({ x: 100, y: 100 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
        gesture(el, 'rr-pointer-move', { x: 400, y: 250 }, 1);
        gesture(el, 'rr-pointer-cancel', { x: 400, y: 250 }, 1);
        await flush();
        await el.updateComplete;

        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
      });

      it('closes a gesture whose end never arrived, rather than wedging on it', async () => {
        // `rr-viewer` emits nothing when it has no transform to convert with, so
        // an up can go missing. A press on the same pointerId cannot be a second
        // finger — a pointer does not go down twice — so it ends the stale one,
        // which keeps both the editor and undo responsive.
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
        gesture(el, 'rr-pointer-move', { x: 300, y: 300 }, 1);
        await flush();
        // No pointer-up: the gesture is left open.

        await drag(el, [{ x: 300, y: 300 }, { x: 350, y: 350 }]);

        expect(points()[0].px).to.deep.equal({ x: 350, y: 350 });
        // One entry for the abandoned gesture, one for the drag that followed.
        expect(history.size).to.equal(2);
        expect(await history.undo()).to.not.be.null;
      });

      it('closes an open gesture when the element goes away', async () => {
        // `rr-app` replaces this element on the view toggle. An entry left open
        // there would refuse every undo for the rest of the session.
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
        gesture(el, 'rr-pointer-move', { x: 300, y: 300 }, 1);
        await flush();
        el.remove();
        await flush();

        expect(history.size).to.equal(1);
        expect(await history.undo()).to.not.be.null;
        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
      });

      it('moves nothing when the drag starts on empty image', async () => {
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);
        const show = stubDialog(el);

        await drag(el, [
          { x: 600, y: 600 },
          { x: 700, y: 700 },
        ]);

        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
        expect(history.size).to.equal(0);
        expect(show).not.toHaveBeenCalled();
      });

      it('takes the DPT readout with it', async () => {
        // 100 px over 10 mm, then 200 px over the same 10 mm: the scale doubles
        // under the drag, live, without a save or a reopen.
        seed({ x: 0, y: 0 }, { x: 100, y: 0 });
        const el = await mount();
        const bar = () => el.shadowRoot!.querySelector('.dpt-bar')!.textContent!;
        expect(bar()).to.contain('DPT 89.7');

        gesture(el, 'rr-pointer-down', { x: 100, y: 0 }, 1);
        gesture(el, 'rr-pointer-move', { x: 200, y: 0 }, 1);
        await flush();
        await el.updateComplete;

        // Mid-gesture, before the pointer is even released.
        expect(bar()).to.contain('DPT 179.4');
      });

      it('still opens the dialog for a click on a point', async () => {
        // The click path is unchanged: a press and a release inside the slop
        // edits, and only a gesture that actually moved suppresses that.
        seed({ x: 100, y: 100 });
        const el = await mount();
        const show = stubDialog(el);

        await clickAt(el, { x: 102, y: 101 });

        expect(show).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { mode: 'edit' });
        expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
      });
    });

    describe('right-click context menu', () => {
      /** One calibration point per pixel, as `seed` does for the drag tests. */
      function seed(...pixels: readonly Point[]) {
        archive.getManifest().layout.calibration.points = pixels.map((px, i) => ({
          px,
          world: { x: i * 10, y: 0, z: 0 },
        }));
      }

      it('opens on the object under the cursor, carrying delete', async () => {
        seed({ x: 100, y: 100 });
        const el = await mount();

        await rightClickAt(el, { x: 103, y: 101 }, { x: 640, y: 400 });

        expect(menuOf(el).open).to.be.true;
        expect(menuItems(el)).to.deep.equal(['delete']);
        // At the cursor, in the client frame the right-click was reported in.
        expect(menuOf(el).style.getPropertyValue('--menu-x')).to.equal('640px');
        expect(menuOf(el).style.getPropertyValue('--menu-y')).to.equal('400px');
      });

      it('opens nothing on empty image', async () => {
        seed({ x: 100, y: 100 });
        const el = await mount();

        await rightClickAt(el, { x: 500, y: 500 });

        expect(menuOf(el).open).to.be.false;
      });

      it('suppresses the browser menu inside the viewer, hit or miss', async () => {
        // Right-click is an editor gesture wherever it lands in the viewer —
        // idle on empty image is the one case that does nothing, and once a
        // chain can be live the same press ends it. Outside the viewer nothing
        // listens, so the browser's own menu is untouched there.
        seed({ x: 100, y: 100 });
        const el = await mount();

        expect((await rightClickAt(el, { x: 100, y: 100 })).defaultPrevented).to.be.true;
        expect((await rightClickAt(el, { x: 500, y: 500 })).defaultPrevented).to.be.true;
      });

      it('deletes the point as one layout entry, and undo restores it exactly', async () => {
        seed({ x: 100, y: 100 }, { x: 400, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);
        const before = structuredClone(points());

        await rightClickAt(el, { x: 400, y: 100 });
        await choose(el, 'delete');

        expect(points()).to.deep.equal([before[0]]);
        expect(history.size).to.equal(1);
        expect(history.undoLabel).to.contain('calibration');

        const entry = await history.undo();
        expect(entry!.target).to.deep.equal({ kind: 'layout' });
        expect(points()).to.deep.equal(before);

        await history.redo();
        expect(points()).to.deep.equal([before[0]]);
      });

      it('takes the DPT readout with it', async () => {
        seed({ x: 0, y: 0 }, { x: 100, y: 0 });
        const el = await mount();
        expect(el.shadowRoot!.querySelector('.dpt-bar')!.textContent).to.contain('DPT 89.7');

        await rightClickAt(el, { x: 100, y: 0 });
        await choose(el, 'delete');

        expect(el.shadowRoot!.querySelector('.dpt-bar')!.textContent).to.contain('Not calibrated');
      });

      it('closes the menu once a row is chosen', async () => {
        seed({ x: 100, y: 100 });
        const el = await mount();

        await rightClickAt(el, { x: 100, y: 100 });
        await choose(el, 'delete');

        expect(menuOf(el).open).to.be.false;
      });

      it('drops a delete whose point moved underneath the open menu', async () => {
        // Same staleness as the dialog: an undo landing while the menu is up can
        // slide the index onto a point the menu was never opened on, and points
        // carry no id to tell them apart.
        const layout = archive.getManifest().layout;
        seed({ x: 100, y: 100 }, { x: 400, y: 100 });
        const el = await mount();

        await rightClickAt(el, { x: 400, y: 100 });
        layout.calibration = { points: [layout.calibration.points[1]] };
        await choose(el, 'delete');

        expect(points()).to.deep.equal([
          { px: { x: 400, y: 100 }, world: { x: 10, y: 0, z: 0 } },
        ]);
      });

      it('does not run the click path for the right button', async () => {
        // A right-click arrives through the same pointer events as a left one.
        // Without the button filter the press that opens the menu also places
        // or edits a point, and the dialog comes up behind the menu.
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);
        const show = stubDialog(el);

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1, { button: 2 });
        gesture(el, 'rr-pointer-up', { x: 100, y: 100 }, 1, { button: 2 });
        await flush();
        await el.updateComplete;

        expect(show).not.toHaveBeenCalled();
        expect(history.size).to.equal(0);
      });

      it('leaves a live drag alone when a secondary button is released', async () => {
        // One `pointerId` covers every mouse button, so the right button's
        // release carries the left drag's id. Ending the drag on it would
        // commit a gesture the user has not finished.
        seed({ x: 100, y: 100 });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mount(history);

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
        gesture(el, 'rr-pointer-move', { x: 300, y: 300 }, 1);
        gesture(el, 'rr-pointer-up', { x: 300, y: 300 }, 1, { button: 2 });
        await flush();
        expect(history.size).to.equal(0);

        gesture(el, 'rr-pointer-move', { x: 350, y: 350 }, 1);
        gesture(el, 'rr-pointer-up', { x: 350, y: 350 }, 1);
        await flush();
        await el.updateComplete;

        expect(points()[0].px).to.deep.equal({ x: 350, y: 350 });
        expect(history.size).to.equal(1);
      });

      it('ignores a right-click during a drag', async () => {
        seed({ x: 100, y: 100 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
        gesture(el, 'rr-pointer-move', { x: 300, y: 300 }, 1);
        await flush();
        await rightClickAt(el, { x: 300, y: 300 });

        expect(menuOf(el).open).to.be.false;
      });
    });

    it('drops an edit whose point moved underneath the open dialog', async () => {
      const layout = archive.getManifest().layout;
      layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 400, y: 100 }, world: { x: 10, y: 0, z: 0 } },
      ];
      const el = await mount();

      // Open the dialog on the second point, then have the first vanish — an
      // undo landing while the dialog is up. Index 1 now names a point the
      // dialog was never opened on.
      await clickAt(el, { x: 400, y: 100 });
      layout.calibration = { points: [layout.calibration.points[1]] };
      await commit(el, { x: 999, y: 999, z: 999 });

      expect(points()).to.deep.equal([
        { px: { x: 400, y: 100 }, world: { x: 10, y: 0, z: 0 } },
      ]);
    });

    it('round-trips through a save and reopen', async () => {
      const el = await mount();
      await clickAt(el, { x: 0, y: 0 });
      await commit(el, { x: 0, y: 0, z: 0 });
      await clickAt(el, { x: 100, y: 0 });
      await commit(el, { x: 10, y: 0, z: 0 });

      const reopened = await R49Archive.load(await archive.export());

      expect(reopened.getManifest().layout.calibration.points).to.deep.equal(points());
      expect(getDPT(reopened.getManifest())).to.equal(getDPT(archive.getManifest()));
    });

    it('places nothing when the dialog is dismissed', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await clickAt(el, { x: 10, y: 10 });
      // No commit: the user cancelled.

      expect(points()).to.have.length(0);
      expect(history.size).to.equal(0);
    });

    it('updates the DPT readout as points are added', async () => {
      const el = await mount();
      const bar = () => el.shadowRoot!.querySelector('.dpt-bar')!;

      expect(bar().textContent).to.contain('Not calibrated');

      await clickAt(el, { x: 0, y: 0 });
      await commit(el, { x: 0, y: 0, z: 0 });
      expect(bar().textContent).to.contain('Not calibrated');

      await clickAt(el, { x: 100, y: 0 });
      await commit(el, { x: 10, y: 0, z: 0 });
      expect(bar().textContent).to.contain('DPT 89.7');
      expect(getDPT(archive.getManifest())).to.be.closeTo(89.7, 0.1);
    });

    it('shows the fit residual only once the fit is over-determined', async () => {
      const layout = archive.getManifest().layout;
      layout.calibration.points = [
        { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
      ];
      const el = await mount();
      expect(el.shadowRoot!.querySelector('.dpt-bar')!.textContent).to.not.contain('residual');

      // A third point that disagrees: 210 px where the fitted scale says 200.
      await clickAt(el, { x: 210, y: 0 });
      await commit(el, { x: 20, y: 0, z: 0 });

      const text = el.shadowRoot!.querySelector('.dpt-bar')!.textContent!;
      expect(text).to.contain('residual');
      expect(text).to.match(/residual \d/);
    });

    it('warns persistently below the minimum DPT without blocking anything', async () => {
      // 100 px over 50 mm in N scale => DPT 17.9, where the fixture corpus sits.
      archive.getManifest().layout.calibration.points = [
        { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 100, y: 0 }, world: { x: 50, y: 0, z: 0 } },
      ];
      const el = await mount();

      const bar = el.shadowRoot!.querySelector('.dpt-bar')!;
      expect(bar.classList.contains('below-minimum')).to.be.true;
      expect(bar.textContent).to.contain('DPT 17.9');
      expect(bar.textContent).to.contain('20');

      // Never blocks: the warning is still up and a third point still lands.
      await clickAt(el, { x: 200, y: 0 });
      await commit(el, { x: 100, y: 0, z: 0 });

      expect(points()).to.have.length(3);
      expect(el.shadowRoot!.querySelector('.dpt-bar')!.classList.contains('below-minimum')).to.be.true;
    });
  });

  /**
   * Two calibration points at a nonzero separation — exactly "DPT resolves",
   * which is the whole of the gate.
   */
  function calibrate() {
    archive.getManifest().layout.calibration.points = [
      { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
      { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
    ];
  }

  /** A choice on the rail's Tools group, which `rr-app` hands to the editor. */
  async function selectTool(el: RREditorView, tool: EditorTool) {
    el.selectTool(tool);
    await el.updateComplete;
  }

  describe('the tools and the calibration gate', () => {
    it('reports the tool, the gate and the image on screen to the rail', async () => {
      const seen: EditorStateDetail[] = [];
      const el = await fixture<RREditorView>(html`
        <rr-editor-view
          .archive=${archive}
          @rr-editor-state=${(e: CustomEvent<EditorStateDetail>) => seen.push(e.detail)}
        ></rr-editor-view>
      `);
      await el.updateComplete;

      expect(seen).to.deep.equal([{ tool: 'calibration', calibrated: false, image: 'img1.jpg' }]);
    });

    it('reports again only when something the rail shows changes', async () => {
      calibrate();
      const seen: EditorStateDetail[] = [];
      const el = await fixture<RREditorView>(html`
        <rr-editor-view
          .archive=${archive}
          @rr-editor-state=${(e: CustomEvent<EditorStateDetail>) => seen.push(e.detail)}
        ></rr-editor-view>
      `);
      await el.updateComplete;
      el.requestUpdate();
      await el.updateComplete;
      expect(seen).to.have.length(1);

      await selectTool(el, 'sensor');
      expect(seen.at(-1)).to.deep.equal({ tool: 'sensor', calibrated: true, image: 'img1.jpg' });
    });

    it('opens an uncalibrated archive in calibration mode, with the rest gated', async () => {
      const el = await mount();

      expect(el.railState.tool).to.equal('calibration');
      expect(el.railState.calibrated).to.be.false;
    });

    it('enables the labeling tools the moment a second point resolves DPT', async () => {
      const el = await mount();

      await clickAt(el, { x: 0, y: 0 });
      await commit(el, { x: 0, y: 0, z: 0 });
      expect(el.railState.calibrated).to.be.false;

      await clickAt(el, { x: 100, y: 0 });
      await commit(el, { x: 10, y: 0, z: 0 });

      // Existence, not completion: two points at a nonzero separation is it.
      expect(el.railState.calibrated).to.be.true;
    });

    it('leaves the tools gated for two points at the same position', async () => {
      // A zero separation resolves no scale, so it is not calibration.
      archive.getManifest().layout.calibration.points = [
        { px: { x: 50, y: 50 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 50, y: 50 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();

      expect(el.railState.calibrated).to.be.false;
    });

    it('drops a gated tool back to calibration when the DPT stops resolving', async () => {
      // The DPT can vanish through an undo, which no handler here sees — so the
      // demotion is enforced on render rather than at the delete.
      calibrate();
      const el = await mount();
      await selectTool(el, 'sensor');
      expect(el.railState.tool).to.equal('sensor');

      await rightClickAt(el, { x: 100, y: 0 });
      await choose(el, 'delete');

      expect(el.railState.calibrated).to.be.false;
      expect(el.railState.tool).to.equal('calibration');
      // And a click means calibrate again, rather than silently placing nothing.
      const show = stubDialog(el);
      await clickAt(el, { x: 400, y: 400 });
      expect(show).toHaveBeenCalledOnce();
      expect(sensors()).to.have.length(0);
    });

    it('re-enters calibration mode for the next archive', async () => {
      calibrate();
      const el = await mount();
      await selectTool(el, 'sensor');

      const next = new R49Archive();
      next.setManifest({
        version: 4,
        layout: { name: 'Next', scale: 'N', calibration: { points: [] }, sensors: [] },
        camera: { resolution: { width: 100, height: 100 } },
        images: [],
      });
      vi.spyOn(next, 'getImage').mockResolvedValue(new Uint8Array());
      el.archive = next;
      await el.updateComplete;
      await flush();
      await el.updateComplete;

      expect(el.railState.tool).to.equal('calibration');
    });
  });

  describe('sensor authoring', () => {
    /** A calibrated archive with the sensor tool live. */
    async function mountWithSensorTool(history?: EditHistory) {
      calibrate();
      const el = await mount(history);
      await selectTool(el, 'sensor');
      return el;
    }

    /** What the sensor dialog emits when the user confirms a name. */
    async function commitName(el: RREditorView, name: string | null) {
      el.shadowRoot!.querySelector('rr-sensor-dialog')!.dispatchEvent(
        new CustomEvent('rr-sensor-name-commit', {
          detail: { name },
          bubbles: true,
          composed: true,
        })
      );
      await flush();
      await el.updateComplete;
    }

    it('places a sensor at the clicked pixel, unnamed and with a snowflake id', async () => {
      const el = await mountWithSensorTool();

      await clickAt(el, { x: 320.4, y: 240.6 });

      expect(sensors()).to.have.length(1);
      const [sensor] = sensors();
      // The click names a pixel, so the stored position is a whole one.
      expect(sensor.x).to.equal(320);
      expect(sensor.y).to.equal(241);
      // Never auto-generated: consumers key on `id`, and a made-up name would be
      // indistinguishable from one a human chose.
      expect(sensor.name).to.be.undefined;
      expect(sensor.id).to.have.length(11);
    });

    it('gives every sensor its own id', async () => {
      const el = await mountWithSensorTool();

      await clickAt(el, { x: 100, y: 400 });
      await clickAt(el, { x: 200, y: 400 });
      await clickAt(el, { x: 300, y: 400 });

      expect(new Set(sensors().map(s => s.id)).size).to.equal(3);
    });

    it('records one layout entry per sensor, and undo reverses it', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithSensorTool(history);

      await clickAt(el, { x: 320, y: 240 });

      expect(history.size).to.equal(1);
      expect(history.undoLabel).to.contain('sensor');

      const entry = await history.undo();
      expect(entry!.target).to.deep.equal({ kind: 'layout' });
      expect(sensors()).to.have.length(0);

      await history.redo();
      expect(sensors()).to.have.length(1);
    });

    it('shows the layout\'s sensors on the viewer', async () => {
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 320, y: 240 });

      expect(el.shadowRoot!.querySelector('rr-viewer')!.sensors).to.deep.equal(sensors());
    });

    it('hands the viewer the DPT, which is what sizes a sensor', async () => {
      // A sensor is drawn one track width across, and a track width in image
      // pixels *is* DPT — so the viewer needs the number, not just the points.
      const el = await mountWithSensorTool();
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.dpt).to.equal(getDPT(archive.getManifest()));

      // And it follows the calibration live, mid-session.
      await drag(el, [
        { x: 100, y: 0 },
        { x: 200, y: 0 },
      ]);
      expect(viewer.dpt).to.equal(getDPT(archive.getManifest()));
    });

    it('asks no dialog on placement — a sensor with no name is complete', async () => {
      const el = await mountWithSensorTool();
      const show = stubSensorDialog(el);

      await clickAt(el, { x: 320, y: 240 });

      expect(show).not.toHaveBeenCalled();
      expect(sensors()).to.have.length(1);
    });

    it('names a sensor from the context menu', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithSensorTool(history);
      await clickAt(el, { x: 320, y: 240 });
      const show = stubSensorDialog(el);

      await rightClickAt(el, { x: 320, y: 240 });
      expect(menuItems(el)).to.deep.equal(['name', 'delete']);

      await choose(el, 'name');
      expect(show).toHaveBeenCalledWith(null, { id: sensors()[0].id });

      await commitName(el, 'Yard throat');
      expect(sensors()[0].name).to.equal('Yard throat');
      expect(history.undoLabel).to.contain('sensor');

      await history.undo();
      expect(sensors()[0].name).to.be.undefined;
    });

    it('names a sensor from a click on it, whatever the tool is', async () => {
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 320, y: 240 });
      await selectTool(el, 'calibration');
      const show = stubSensorDialog(el);
      const calibrationShow = stubDialog(el);

      await clickAt(el, { x: 322, y: 241 });

      // The object under the cursor is edited; the calibration tool must not
      // stack a point on top of the sensor the user was aiming at.
      expect(show).toHaveBeenCalledOnce();
      expect(calibrationShow).not.toHaveBeenCalled();
      expect(points()).to.have.length(2);
    });

    it('removes the name when the field comes back blank', async () => {
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 320, y: 240 });

      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'name');
      await commitName(el, 'Yard throat');

      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'name');
      await commitName(el, null);

      // Absent, not empty: a stored `""` would be a name that displays as
      // nothing while still counting as one.
      expect('name' in sensors()[0]).to.be.false;
    });

    it('records nothing for a name that did not change', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithSensorTool(history);
      await clickAt(el, { x: 320, y: 240 });
      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'name');
      await commitName(el, 'Yard throat');
      const size = history.size;

      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'name');
      await commitName(el, 'Yard throat');

      expect(history.size).to.equal(size);
    });

    it('grabs a sensor anywhere on the symbol it is drawn as', async () => {
      // The archive calibrates to DPT 89.7, so the diamond is ~90 image px
      // across — far wider than the pointer's own 14 screen px of reach, and a
      // symbol you can see but cannot click reads as a bug.
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 600, y: 400 });
      const show = stubSensorDialog(el);

      // 40 px off centre: inside the diamond, outside the pointer radius.
      await clickAt(el, { x: 640, y: 400 });

      expect(show).toHaveBeenCalledOnce();
      expect(sensors()).to.have.length(1);
    });

    it('drags a sensor, one entry per gesture, targeting layout', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithSensorTool(history);
      await clickAt(el, { x: 320, y: 240 });
      const placed = history.size;

      // Pressed three pixels off-centre: the sensor translates by the delta
      // rather than teleporting under the cursor.
      await drag(el, [
        { x: 323, y: 242 },
        { x: 400, y: 300 },
        { x: 423, y: 342 },
      ]);

      expect(sensors()[0]).to.include({ x: 420, y: 340 });
      expect(history.size).to.equal(placed + 1);
      expect(history.undoLabel).to.contain('sensor');

      const entry = await history.undo();
      expect(entry!.target).to.deep.equal({ kind: 'layout' });
      expect(sensors()[0]).to.include({ x: 320, y: 240 });
    });

    it('keeps a dragged sensor\'s id and name', async () => {
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 320, y: 240 });
      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'name');
      await commitName(el, 'Yard throat');
      const before = sensors()[0].id;

      await drag(el, [
        { x: 320, y: 240 },
        { x: 500, y: 400 },
      ]);

      expect(sensors()[0].id).to.equal(before);
      expect(sensors()[0].name).to.equal('Yard throat');
    });

    it('deletes a sensor from the context menu, and undo restores it whole', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithSensorTool(history);
      await clickAt(el, { x: 320, y: 240 });
      await clickAt(el, { x: 500, y: 240 });
      const before = structuredClone(sensors());

      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'delete');

      expect(sensors()).to.deep.equal([before[1]]);
      expect(history.undoLabel).to.contain('sensor');

      const entry = await history.undo();
      expect(entry!.target).to.deep.equal({ kind: 'layout' });
      expect(sensors()).to.deep.equal(before);
    });

    it('leaves the calibration points alone when a sensor is written', async () => {
      // `_writeLayout` takes only what changed, so a sensor edit cannot rewrite
      // the calibration beside it.
      const el = await mountWithSensorTool();
      const before = structuredClone(points());

      await clickAt(el, { x: 320, y: 240 });
      await drag(el, [
        { x: 320, y: 240 },
        { x: 400, y: 300 },
      ]);

      expect(points()).to.deep.equal(before);
    });

    it('grabs whichever object is nearest, sensor or calibration point', async () => {
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 320, y: 240 });

      // The calibration point at (100, 0) is what this drag grabs, even with the
      // sensor tool live: a drag moves what is under it, never what is selected.
      await drag(el, [
        { x: 100, y: 0 },
        { x: 150, y: 50 },
      ]);

      expect(points()[1].px).to.deep.equal({ x: 150, y: 50 });
      expect(sensors()[0]).to.include({ x: 320, y: 240 });
    });

    it('survives a save and reopen', async () => {
      const el = await mountWithSensorTool();
      await clickAt(el, { x: 320, y: 240 });
      await rightClickAt(el, { x: 320, y: 240 });
      await choose(el, 'name');
      await commitName(el, 'Yard throat');

      const reopened = await R49Archive.load(await archive.export());

      expect(reopened.getManifest().layout.sensors).to.deep.equal(sensors());
    });
  });

  describe('car authoring', () => {
    /** A calibrated archive with the car tool live. */
    async function mountWithCarTool(history?: EditHistory) {
      calibrate();
      const el = await mount(history);
      await selectTool(el, 'car');
      return el;
    }

    /** A hand-drawn car — the only kind this editor authors. */
    type HumanCar = Extract<CarLabel, { provenance: 'human' }>;

    /** The current image's labels — cars are per image. */
    function cars(index = 0): CarLabel[] {
      return archive.getManifest().images[index].labels;
    }

    /** Adds a second image, so the per-image rules have something to switch to. */
    function addSecondImage() {
      archive.getManifest().images.push({
        filename: 'img2.jpg',
        labeled_complete: false,
        labels: [],
      });
    }

    /**
     * Right-click over empty image: the gesture that ends a chain.
     *
     * Every car after the first in a train is chained onto the one before it,
     * so authoring two *separate* cars means ending the chain in between.
     */
    async function endChain(el: RREditorView) {
      await rightClickAt(el, { x: 900, y: 900 });
    }

    /** The rubber band the viewer is currently drawing — the anchor made visible. */
    function band(el: RREditorView) {
      return el.shadowRoot!.querySelector('rr-viewer')!.pendingCar;
    }

    /** Selects an image the way `rr-thumbnail-bar` reports one. */
    async function selectImage(el: RREditorView, index: number) {
      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index }, bubbles: true, composed: true })
      );
      await el.updateComplete;
    }

    it('creates a car from two clicks on the visible ends', async () => {
      const el = await mountWithCarTool();

      await clickAt(el, { x: 200.4, y: 300.6 });
      // The first click names one end and writes nothing.
      expect(cars()).to.have.length(0);

      await clickAt(el, { x: 500, y: 300 });

      expect(cars()).to.have.length(1);
      // The click names a pixel, so both ends are whole ones.
      expect(cars()[0].p0).to.deep.equal({ x: 200, y: 301 });
      expect(cars()[0].p1).to.deep.equal({ x: 500, y: 300 });
    });

    it('creates it as a human-authored car at the taxonomy root', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 200, y: 300 });
      await clickAt(el, { x: 500, y: 300 });

      const [car] = cars();
      expect(car.class).to.equal('stock');
      expect(car.provenance).to.equal('human');
      // The schema forbids the key on a human label; a default of `human` on
      // model output is the loop provenance exists to make measurable.
      expect('proposed_by' in car).to.be.false;
      expect(car.id).to.have.length(11);
    });

    it('gives every car its own id', async () => {
      const el = await mountWithCarTool();
      for (const y of [100, 200, 300]) {
        await clickAt(el, { x: 100, y });
        await clickAt(el, { x: 400, y });
        await endChain(el);
      }

      expect(cars()).to.have.length(3);
      expect(new Set(cars().map(c => c.id)).size).to.equal(3);
    });

    it('records one entry per car, targeting the image it is on', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithCarTool(history);

      await clickAt(el, { x: 200, y: 300 });
      expect(history.size).to.equal(0);

      await clickAt(el, { x: 500, y: 300 });

      expect(history.size).to.equal(1);
      expect(history.undoLabel).to.contain('car');

      const entry = await history.undo();
      expect(entry!.target).to.deep.equal({ kind: 'image', filename: 'img1.jpg' });
      expect(cars()).to.have.length(0);

      await history.redo();
      expect(cars()).to.have.length(1);
    });

    it('hands the cars and the DPT to the viewer', async () => {
      // The width rectangle is derived from DPT, never stored, so the viewer
      // needs the number as well as the spans.
      const el = await mountWithCarTool();
      await clickAt(el, { x: 200, y: 300 });
      await clickAt(el, { x: 500, y: 300 });

      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.cars).to.deep.equal(cars());
      expect(viewer.dpt).to.equal(getDPT(archive.getManifest()));
    });

    it('writes nothing for a placement the user abandons', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithCarTool(history);

      await clickAt(el, { x: 200, y: 300 });
      await selectTool(el, 'sensor');

      expect(cars()).to.have.length(0);
      expect(history.size).to.equal(0);

      // And the anchor is gone: the next click is the sensor tool's, not the
      // second half of a car the user stopped drawing.
      await clickAt(el, { x: 500, y: 300 });
      expect(cars()).to.have.length(0);
      expect(sensors()).to.have.length(1);
    });

    it('ends a placement on right-click, opening no menu', async () => {
      // The same gesture that will end a chain (#33). Nothing was written, so
      // nothing is undone.
      const history = new EditHistory();
      history.attach(archive);
      const el = await mountWithCarTool(history);

      await clickAt(el, { x: 200, y: 300 });
      await rightClickAt(el, { x: 500, y: 300 });

      expect(menuOf(el).open).to.be.false;
      expect(cars()).to.have.length(0);
      expect(history.size).to.equal(0);

      // The next click starts a new car rather than completing the old anchor.
      await clickAt(el, { x: 600, y: 600 });
      await clickAt(el, { x: 800, y: 600 });
      expect(cars()[0].p0).to.deep.equal({ x: 600, y: 600 });
    });

    it('completes the car even when the second click lands on another object', async () => {
      // A placement in progress outranks the object under the cursor: the
      // second click is what gives the car its other end, and interpreting it
      // as an edit would strand the anchor.
      const el = await mountWithCarTool();
      const show = stubDialog(el);

      await clickAt(el, { x: 200, y: 300 });
      // (100, 0) is a calibration point.
      await clickAt(el, { x: 100, y: 0 });

      expect(cars()).to.have.length(1);
      expect(cars()[0].p1).to.deep.equal({ x: 100, y: 0 });
      expect(show).not.toHaveBeenCalled();
    });

    it('starts no car from a click on an existing car end', async () => {
      // Once the chain has ended, the object under the cursor wins again, and
      // a car end has nothing a click can edit — so the click does nothing at
      // all rather than stacking a second label on the one being aimed at.
      // Abutting cars are authored by **chaining**, not by clicking a free
      // anchor onto an existing end.
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await endChain(el);

      await clickAt(el, { x: 400, y: 100 });
      await clickAt(el, { x: 700, y: 100 });

      expect(cars()).to.have.length(1);
    });

    describe('a click inside an existing car (#43)', () => {
      /** One car across the middle of the image, and the chain ended. */
      async function withOneCar(history?: EditHistory) {
        const el = await mountWithCarTool(history);
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await endChain(el);
        return el;
      }

      it('takes no anchor and writes nothing', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await withOneCar(history);
        const before = history.size;

        // Squarely on the body of the car just drawn — a pixel that already
        // carries a label, so a second one would be a duplicate box.
        await clickAt(el, { x: 250, y: 100 });

        expect(cars()).to.have.length(1);
        expect(band(el)).to.equal(null);
        expect(history.size).to.equal(before);
      });

      /** Every reason the editor gave, in order. */
      function noticesOf(el: RREditorView): string[] {
        const notices: string[] = [];
        el.addEventListener('rr-notify', e =>
          notices.push((e as CustomEvent<NotifyDetail>).detail.message)
        );
        return notices;
      }

      it('says why it refused, rather than doing nothing visibly', async () => {
        const el = await withOneCar();
        const notices = noticesOf(el);

        await clickAt(el, { x: 250, y: 100 });

        expect(notices).to.have.length(1);
        expect(notices[0]).to.contain('already');
      });

      it('gives a click on the car\'s own end handle the same reason', async () => {
        // The hit-test routes that click to the object under it rather than to
        // the tool, but it lands inside the same rectangle — one rule to the
        // user, so one wording.
        const el = await withOneCar();
        const notices = noticesOf(el);

        await clickAt(el, { x: 400, y: 100 });

        expect(cars()).to.have.length(1);
        expect(band(el)).to.equal(null);
        expect(notices).to.deep.equal([
          'That pixel is already inside a labeled car — a car is labeled once.',
        ]);
      });

      it('says nothing about a car end under another tool', async () => {
        // Nothing to explain: the user was not trying to author a car.
        const el = await withOneCar();
        await selectTool(el, 'sensor');
        const notices = noticesOf(el);

        await clickAt(el, { x: 400, y: 100 });

        expect(notices).to.deep.equal([]);
      });

      it('starts a chain as before outside every car', async () => {
        const el = await withOneCar();

        await clickAt(el, { x: 250, y: 400 });
        expect(band(el)).to.not.equal(null);

        await clickAt(el, { x: 600, y: 400 });
        expect(cars()).to.have.length(2);
      });

      it('lets a live chain run its next click through an existing car', async () => {
        // Only the click that *starts* a chain is checked. Coupling onto a
        // train already drawn is exactly a click on an existing car's end.
        const el = await withOneCar();

        await clickAt(el, { x: 250, y: 400 });
        await clickAt(el, { x: 250, y: 100 });

        expect(cars()).to.have.length(2);
        expect(cars()[1].p1).to.deep.equal({ x: 250, y: 100 });
      });

      it('still lets an endpoint be dragged into another car', async () => {
        // A drag is an edit made under live width-rectangle feedback, not an
        // accidental new label.
        const el = await withOneCar();
        await clickAt(el, { x: 250, y: 400 });
        await clickAt(el, { x: 600, y: 400 });
        await endChain(el);

        await drag(el, [{ x: 600, y: 400 }, { x: 300, y: 100 }, { x: 250, y: 100 }]);

        expect(cars()).to.have.length(2);
        expect(cars()[1].p1).to.deep.equal({ x: 250, y: 100 });
      });

      it('opens an archive whose cars already overlap, and edits it', async () => {
        // The rule gates authoring only; nothing validates a file.
        archive.getManifest().images[0].labels = [
          { id: 'aaaaaaaaaaa', class: 'stock', provenance: 'human',
            p0: { x: 100, y: 100 }, p1: { x: 400, y: 100 } },
          { id: 'bbbbbbbbbbb', class: 'stock', provenance: 'human',
            p0: { x: 150, y: 100 }, p1: { x: 450, y: 100 } },
        ];
        const el = await mountWithCarTool();

        expect(cars()).to.have.length(2);
        // And an end of either is still draggable.
        await drag(el, [{ x: 450, y: 100 }, { x: 470, y: 100 }]);
        expect(cars()[1].p1).to.deep.equal({ x: 470, y: 100 });
      });
    });

    describe('chaining a train', () => {
      /** A pointer move with no button down — what the band follows. */
      async function moveTo(el: RREditorView, point: Point) {
        gesture(el, 'rr-pointer-move', point, 1);
        await el.updateComplete;
      }

      it('makes every click after the first an end and the next start', async () => {
        const el = await mountWithCarTool();

        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await clickAt(el, { x: 700, y: 100 });
        await clickAt(el, { x: 1000, y: 100 });

        expect(cars()).to.have.length(3);
        // Exactly coincident, not merely close: the coincidence is what a train
        // is derived from, and chaining is what guarantees it.
        expect(cars()[0].p1).to.deep.equal(cars()[1].p0);
        expect(cars()[1].p1).to.deep.equal(cars()[2].p0);
        expect(cars()[0].p1).to.deep.equal({ x: 400, y: 100 });
      });

      it('couples a chain drawn along a diagonal, pixel for pixel', async () => {
        // The clicked pixel is rounded before it is written, so the end and the
        // next start must be rounded the same way or the train comes apart.
        const el = await mountWithCarTool();

        await clickAt(el, { x: 100.4, y: 100.6 });
        await clickAt(el, { x: 240.5, y: 180.5 });
        await clickAt(el, { x: 390.2, y: 260.7 });

        expect(cars()[0].p1).to.deep.equal(cars()[1].p0);
        expect(cars()[1].p0).to.deep.equal({ x: 241, y: 181 });
      });

      it('records one entry per car, so one undo costs one car', async () => {
        // Never one entry for the train: a mis-click on the last coupler of a
        // twelve-car consist must not cost the consist.
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await clickAt(el, { x: 700, y: 100 });

        expect(history.size).to.equal(2);
      });

      it('draws a band from the anchor to the cursor', async () => {
        const el = await mountWithCarTool();
        expect(band(el)).to.equal(null);

        await clickAt(el, { x: 100, y: 100 });
        // Before the pointer moves the band is the anchor twice: the handle is
        // the feedback that the first click landed.
        expect(band(el)).to.deep.equal({
          anchor: { x: 100, y: 100 },
          to: { x: 100, y: 100 },
        });

        await moveTo(el, { x: 380.4, y: 220.6 });
        expect(band(el)).to.deep.equal({
          anchor: { x: 100, y: 100 },
          to: { x: 380, y: 221 },
        });
      });

      it('re-anchors the band on the coupling each click makes', async () => {
        const el = await mountWithCarTool();

        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await moveTo(el, { x: 600, y: 100 });

        expect(band(el)).to.deep.equal({
          anchor: { x: 400, y: 100 },
          to: { x: 600, y: 100 },
        });
      });

      it('takes the band away when the chain ends', async () => {
        const el = await mountWithCarTool();
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });

        await endChain(el);

        expect(band(el)).to.equal(null);
      });

      it('ends the chain on right-click and starts a new train on the next click', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await endChain(el);

        // The chain's car stays — it was committed — and no menu opened.
        expect(menuOf(el).open).to.be.false;
        expect(cars()).to.have.length(1);
        expect(history.size).to.equal(1);

        await clickAt(el, { x: 100, y: 500 });
        await clickAt(el, { x: 400, y: 500 });

        expect(cars()).to.have.length(2);
        expect(cars()[1].p0).to.deep.equal({ x: 100, y: 500 });
      });

      it('writes no car for a second click on the anchor itself', async () => {
        // A span with no length is no car: it has no axis to draw along and no
        // two ends to couple. The chain simply stays where it was.
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        await clickAt(el, { x: 200, y: 200 });
        await clickAt(el, { x: 200, y: 200 });

        expect(cars()).to.have.length(0);
        expect(history.size).to.equal(0);

        await clickAt(el, { x: 500, y: 200 });
        expect(cars()).to.have.length(1);
        expect(cars()[0].p0).to.deep.equal({ x: 200, y: 200 });
      });

      it('leaves the manifest untouched for a chain that never got a second click', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);
        const before = structuredClone(archive.getManifest());

        await clickAt(el, { x: 200, y: 200 });
        await endChain(el);

        expect(archive.getManifest()).to.deep.equal(before);
        expect(history.size).to.equal(0);
        expect(history.canUndo).to.be.false;
      });

      describe('undo, intercepted by the chain', () => {
        it('takes one car and puts the anchor back where it began', async () => {
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithCarTool(history);

          await clickAt(el, { x: 100, y: 100 });
          await clickAt(el, { x: 400, y: 100 });
          await clickAt(el, { x: 700, y: 100 });

          expect(await el.interceptUndo()).to.be.true;
          await el.updateComplete;

          expect(cars()).to.have.length(1);
          // It went through the stack rather than around it: the car is back
          // one redo away.
          expect(history.canRedo).to.be.true;
          // The chain is still live, one step back: the next click draws from
          // where the car that went began.
          expect(band(el)!.anchor).to.deep.equal({ x: 400, y: 100 });

          await clickAt(el, { x: 700, y: 400 });
          expect(cars()).to.have.length(2);
          expect(cars()[1].p0).to.deep.equal({ x: 400, y: 100 });
        });

        it('walks a whole chain back, one car at a time', async () => {
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithCarTool(history);

          await clickAt(el, { x: 100, y: 100 });
          await clickAt(el, { x: 400, y: 100 });
          await clickAt(el, { x: 700, y: 100 });

          await el.interceptUndo();
          await el.interceptUndo();
          await el.updateComplete;

          expect(cars()).to.have.length(0);
          // Back at the chain's start: the anchor is the first click again.
          // The band's far end is still the last place the pointer was seen —
          // an undo moves the anchor, not the mouse.
          expect(band(el)).to.deep.equal({
            anchor: { x: 100, y: 100 },
            to: { x: 700, y: 100 },
          });
        });

        it('is a wall: at the chain\'s start it clears the anchor and stops there', async () => {
          // The reflexive "wrong place, undo" at the start of a train must
          // never reach back and delete the last car of the previous one.
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithCarTool(history);

          await clickAt(el, { x: 100, y: 100 });
          await clickAt(el, { x: 400, y: 100 });
          await endChain(el);
          await clickAt(el, { x: 100, y: 500 });

          expect(await el.interceptUndo()).to.be.true;
          await el.updateComplete;

          expect(band(el)).to.equal(null);
          // The previous train is untouched, and its entry is still on the stack.
          expect(cars()).to.have.length(1);
          expect(history.size).to.equal(1);
        });

        it('lets the stack have the undo once the chain is over', async () => {
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithCarTool(history);

          await clickAt(el, { x: 100, y: 100 });
          await clickAt(el, { x: 400, y: 100 });
          await endChain(el);

          expect(await el.interceptUndo()).to.be.false;
          expect(cars()).to.have.length(1);
        });

        it('leaves the anchor alone when the undo reversed something else', async () => {
          // A calibration point dragged between two clicks of a chain puts its
          // own entry on top of the stack. Undo reverses that; the chain has
          // not lost a car, so its anchor must not move.
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithCarTool(history);

          await clickAt(el, { x: 100, y: 100 });
          await clickAt(el, { x: 400, y: 100 });
          await drag(el, [
            { x: 100, y: 0 },
            { x: 120, y: 40 },
          ]);

          expect(await el.interceptUndo()).to.be.true;
          await el.updateComplete;

          expect(points()[1].px).to.deep.equal({ x: 100, y: 0 });
          expect(cars()).to.have.length(1);
          expect(band(el)!.anchor).to.deep.equal({ x: 400, y: 100 });
        });
      });

      describe('the shared coupler handle', () => {
        /** A three-car train, chained end to end along one line. */
        async function mountWithTrain(history?: EditHistory) {
          const el = await mountWithCarTool(history);
          for (const x of [100, 400, 700, 1000]) {
            await clickAt(el, { x, y: 100 });
          }
          await endChain(el);
          return el;
        }

        it('drags both cars of a coupling as one entry, keeping them coupled', async () => {
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithTrain(history);
          const entries = history.size;

          await drag(el, [
            { x: 400, y: 100 },
            { x: 450, y: 220 },
          ]);

          expect(cars()[0].p1).to.deep.equal({ x: 450, y: 220 });
          expect(cars()[1].p0).to.deep.equal({ x: 450, y: 220 });
          expect(history.size).to.equal(entries + 1);
        });

        it('names one car — its own body — where two of them meet', async () => {
          // The joint is a shared handle at one pixel, so a gesture there named
          // two cars and the rows had to say which. The subject is now the body
          // the pointer is inside, which names one (#45).
          const el = await mountWithTrain();

          await rightClickAt(el, { x: 400, y: 100 });

          expect(menuOf(el).open).to.be.true;
          expect(menuItems(el)).to.deep.equal(['delete', `reclassify-group:${rootClass()}`]);
          // A row's own text, without whatever its submenu contains.
          const labels = [...menuOf(el).shadowRoot!.querySelector('sl-menu')!.children].map(item =>
            [...item.childNodes]
              .filter(node => node.nodeType === Node.TEXT_NODE)
              .map(node => node.textContent)
              .join('')
              .trim()
          );
          expect(labels).to.deep.equal(['Delete car', 'Reclassify car']);
        });

        it('takes the first car in scene order at the seam of a coupling', async () => {
          // Coupled rectangles abut rather than overlap, so the one ambiguous
          // place is the zero-area line between them — which is where the
          // shared handle sits, and the only thing scene order has to settle.
          const el = await mountWithTrain();
          const [first] = structuredClone(cars());

          await rightClickAt(el, { x: 400, y: 100 });
          await choose(el, 'delete');

          expect(cars().some(car => car.id === first.id)).to.be.false;
          expect(cars()).to.have.length(2);
        });

        it('deletes the middle car of a three-car train, leaving two and no residue', async () => {
          const history = new EditHistory();
          history.attach(archive);
          const el = await mountWithTrain(history);
          const [first, middle, last] = structuredClone(cars());

          // The middle car has no free end at all. Its **body** is what reaches
          // it, which is what makes a joint unnecessary as a subject.
          await rightClickAt(el, { x: 550, y: 100 });
          await choose(el, 'delete');

          expect(cars()).to.deep.equal([first, last]);
          // Nothing else named the car that went: a train is derived, so the
          // two survivors are simply two cars now.
          expect(cars()[0].p1).to.deep.equal({ x: 400, y: 100 });
          expect(cars()[1].p0).to.deep.equal({ x: 700, y: 100 });

          const entry = await history.undo();
          expect(entry!.target).to.deep.equal({ kind: 'image', filename: 'img1.jpg' });
          expect(cars()).to.deep.equal([first, middle, last]);
        });

        it('names one car where three ends meet, and reaches the others by body', async () => {
          const el = await mountWithTrain();
          // A fourth car joining the coupling at (400, 100) from below. It is
          // chained *into* the joint: a click on an existing end starts no car,
          // but the second click of a chain lands wherever it is aimed.
          await clickAt(el, { x: 400, y: 400 });
          await clickAt(el, { x: 400, y: 100 });
          await endChain(el);

          await rightClickAt(el, { x: 400, y: 100 });

          // One subject, however many ends meet there — the menu names a car,
          // not a coincidence.
          expect(menuItems(el).filter(id => id === 'delete')).to.have.length(1);

          // The fourth car runs down the frame where no other car is, so its
          // own body reaches it.
          await rightClickAt(el, { x: 400, y: 300 });
          await choose(el, 'delete');
          expect(cars()).to.have.length(3);
          expect(cars().every(car => car.p0.y === 100 && car.p1.y === 100)).to.be.true;
        });
      });
    });

    describe('dragging an endpoint', () => {
      /** One car spanning the frame, authored by hand rather than by click. */
      function seedCar(over: Partial<HumanCar> = {}): HumanCar {
        const car: HumanCar = {
          id: 'C1abcdefghi',
          class: 'stock',
          provenance: 'human',
          p0: { x: 100, y: 100 },
          p1: { x: 400, y: 100 },
          ...over,
        };
        archive.getManifest().images[0].labels.push(car);
        return car;
      }

      it('moves the end that was grabbed, keeping the grab offset', async () => {
        seedCar();
        const el = await mountWithCarTool();

        // Pressed three pixels off the end: it translates by the delta rather
        // than teleporting under the cursor.
        await drag(el, [
          { x: 103, y: 102 },
          { x: 200, y: 150 },
          { x: 203, y: 202 },
        ]);

        expect(cars()[0].p0).to.deep.equal({ x: 200, y: 200 });
        expect(cars()[0].p1).to.deep.equal({ x: 400, y: 100 });
      });

      it('records one entry per gesture, targeting the image', async () => {
        seedCar();
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        const path: Point[] = [{ x: 400, y: 100 }];
        for (let i = 1; i <= 100; i++) path.push({ x: 400 + i, y: 100 });
        await drag(el, path);

        expect(cars()[0].p1).to.deep.equal({ x: 500, y: 100 });
        expect(history.size).to.equal(1);
        expect(history.undoLabel).to.contain('car');

        const entry = await history.undo();
        expect(entry!.target).to.deep.equal({ kind: 'image', filename: 'img1.jpg' });
        expect(cars()[0].p1).to.deep.equal({ x: 400, y: 100 });
      });

      it('keeps the label whole — id, class and provenance', async () => {
        seedCar();
        const el = await mountWithCarTool();

        await drag(el, [
          { x: 100, y: 100 },
          { x: 150, y: 160 },
        ]);

        expect(cars()[0]).to.deep.equal({
          id: 'C1abcdefghi',
          class: 'stock',
          provenance: 'human',
          p0: { x: 150, y: 160 },
          p1: { x: 400, y: 100 },
        });
      });

      it('records nothing for a drag returned to its origin', async () => {
        seedCar();
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        await drag(el, [
          { x: 100, y: 100 },
          { x: 300, y: 300 },
          { x: 100, y: 100 },
        ]);

        expect(history.size).to.equal(0);
        expect(cars()[0].p0).to.deep.equal({ x: 100, y: 100 });
      });

      it('leaves the layout alone, and the calibration points with it', async () => {
        seedCar();
        const el = await mountWithCarTool();
        const before = structuredClone(points());

        await drag(el, [
          { x: 100, y: 100 },
          { x: 250, y: 250 },
        ]);

        expect(points()).to.deep.equal(before);
      });

      it('moves both cars of a coupling, as one entry', async () => {
        // A coupling is exact coincidence and nothing about it is stored, so
        // the shared handle has to move both ends or the train comes apart.
        seedCar();
        seedCar({ id: 'C2abcdefghi', p0: { x: 400, y: 100 }, p1: { x: 700, y: 100 } });
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        await drag(el, [
          { x: 400, y: 100 },
          { x: 450, y: 200 },
        ]);

        expect(cars()[0].p1).to.deep.equal({ x: 450, y: 200 });
        expect(cars()[1].p0).to.deep.equal({ x: 450, y: 200 });
        expect(history.size).to.equal(1);
      });

      it('addresses the car by id across a history apply', async () => {
        // Applying a snapshot replaces the objects wholesale: anything holding
        // an object reference would be pointing at a stale car here.
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        const id = cars()[0].id;

        await history.undo();
        await history.redo();
        await el.updateComplete;

        await drag(el, [
          { x: 400, y: 100 },
          { x: 500, y: 100 },
        ]);

        expect(cars()).to.have.length(1);
        expect(cars()[0].id).to.equal(id);
        expect(cars()[0].p1).to.deep.equal({ x: 500, y: 100 });
      });
    });

    describe('what the menu is opened on (#45)', () => {
      /** One car across the frame, and whatever else the test puts on top of it. */
      async function mountWithOneCar() {
        const el = await mountWithCarTool();
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await endChain(el);
        return el;
      }

      it('gives a sensor drawn over a car the sensor\'s own menu', async () => {
        // Topmost drawn wins, matching the render order: cars draw first, so a
        // sensor on a car is not tinted over — and car-area-first would make
        // the normal case, a sensor on the track a car stands on, unreachable.
        const el = await mountWithOneCar();
        archive.getManifest().layout.sensors.push({ id: 'S1abcdefghi', x: 250, y: 100 });

        await rightClickAt(el, { x: 250, y: 100 });

        expect(menuItems(el)).to.deep.equal(['name', 'delete']);
      });

      it('gives a calibration point drawn over a car the point\'s own menu', async () => {
        // `calibrate()` puts a point at (100, 0), which the car's rectangle
        // reaches down from (100, 100).
        const el = await mountWithOneCar();

        await rightClickAt(el, { x: 100, y: 10 });

        expect(menuItems(el)).to.deep.equal(['delete']);
      });

      it('reaches a car whose DPT went away, which is drawn with no rectangle', async () => {
        // `renderCar` still draws the chord and its handles with no DPT, because
        // an authored car stays visible after a calibration point is deleted.
        // Without the fingertip floor that is a car you can see and cannot
        // delete.
        const el = await mountWithOneCar();
        archive.getManifest().layout.calibration.points = [];
        await el.updateComplete;

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, 'delete');

        expect(cars()).to.deep.equal([]);
      });
    });

    describe('deleting', () => {
      /** Two separate cars: the chain is ended between them, so neither is coupled. */
      async function mountWithTwoCars(history?: EditHistory) {
        const el = await mountWithCarTool(history);
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await endChain(el);
        await clickAt(el, { x: 100, y: 500 });
        await clickAt(el, { x: 400, y: 500 });
        await endChain(el);
        return el;
      }

      it('offers delete and reclassify on a car\'s body', async () => {
        const el = await mountWithTwoCars();

        await rightClickAt(el, { x: 250, y: 140 });

        expect(menuOf(el).open).to.be.true;
        // The rows name no car: the subject is one, so a verb is a verb.
        expect(menuItems(el)).to.deep.equal(['delete', `reclassify-group:${rootClass()}`]);
      });

      it('opens nothing past the end of a car, where no body is drawn', async () => {
        // The rectangle is capped at the two ends and floored only *across* its
        // axis, so the subject is exactly what the user can see.
        const el = await mountWithTwoCars();

        await rightClickAt(el, { x: 402, y: 101 });

        expect(menuOf(el).open).to.be.false;
      });

      it('deletes that car and leaves the others untouched', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithTwoCars(history);
        const before = structuredClone(cars());

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, 'delete');

        expect(cars()).to.deep.equal([before[1]]);
        expect(history.undoLabel).to.contain('car');
      });

      it('undo restores it with the same id, and the same everything else', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithTwoCars(history);
        const before = structuredClone(cars());

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, 'delete');

        const entry = await history.undo();
        expect(entry!.target).to.deep.equal({ kind: 'image', filename: 'img1.jpg' });
        expect(cars()).to.deep.equal(before);

        await history.redo();
        expect(cars()).to.deep.equal([before[1]]);
      });

      // `SPEC.md` § Labeling completeness: a delete removes coverage, and
      // nothing can tell a label deleted off background from one deleted off a
      // car still in the photograph. The claim goes back to the human.
      it('clears labeled_complete, in the same entry', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithTwoCars(history);
        archive.getManifest().images[0].labeled_complete = true;
        const before = structuredClone(cars());

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, 'delete');

        expect(archive.getManifest().images[0].labeled_complete).to.be.false;

        // One entry carries both, because the flag lives in the same per-image
        // snapshot the delete already targets.
        await history.undo();
        expect(archive.getManifest().images[0].labeled_complete).to.be.true;
        expect(cars()).to.deep.equal(before);
      });

      it('leaves an already-incomplete image alone, and records one entry', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithTwoCars(history);
        const placed = history.size;

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, 'delete');

        expect(archive.getManifest().images[0].labeled_complete).to.be.false;
        expect(history.size).to.equal(placed + 1);
      });

      it('drops a delete whose car went away underneath the open menu', async () => {
        const el = await mountWithTwoCars();
        const before = structuredClone(cars());

        await rightClickAt(el, { x: 250, y: 100 });
        // An undo landing while the menu is up. The subject holds an `id`, so
        // the car that went is the one that is dropped.
        archive.getManifest().images[0].labels = [before[1]];
        await choose(el, 'delete');

        expect(cars()).to.deep.equal([before[1]]);
      });
    });

    describe('reclassifying', () => {
      /** One car, ready to be refined. */
      async function mountWithOneCar(history?: EditHistory) {
        const el = await mountWithCarTool(history);
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await endChain(el);
        return el;
      }

      /** The taxonomy, as the editor reads it out of `config.yaml`. */
      const choices = classChoices();
      const [firstChoice] = choices;

      it('offers the authored vocabulary as a submenu, and never the root', async () => {
        // Generated from `detector.vocabulary`: adding a subtype there and
        // regenerating changes this menu with no code edit (#35).
        const el = await mountWithOneCar();

        await rightClickAt(el, { x: 250, y: 100 });

        expect(submenuItems(el, `reclassify-group:${rootClass()}`)).to.deep.equal(
          choices.map(choice =>
            choice.children.length > 0
              ? `reclassify-group:${choice.class}`
              : `reclassify:${choice.class}`
          )
        );
        // Every offered class is rooted, because an unrooted one matches no
        // entry of `detector.classes` and is dropped from the export.
        for (const choice of choices) {
          expect(choice.class.startsWith(`${rootClass()}.`)).to.be.true;
        }
      });

      it('writes the full dotted class as one image entry', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithOneCar(history);
        const before = structuredClone(cars());
        const target = firstChoice.children[0] ?? firstChoice;

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, `reclassify:${target.class}`);

        expect(cars()[0].class).to.equal(target.class);
        // Nothing else about the label moves: reclassify is one field.
        expect(cars()[0]).to.deep.equal({ ...before[0], class: target.class });

        const entry = await history.undo();
        expect(entry!.target).to.deep.equal({ kind: 'image', filename: 'img1.jpg' });
        expect(cars()).to.deep.equal(before);
      });

      it('costs exactly one undo', async () => {
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithOneCar(history);
        const target = firstChoice.children[0] ?? firstChoice;

        await rightClickAt(el, { x: 250, y: 100 });
        await choose(el, `reclassify:${target.class}`);

        await history.undo();
        expect(cars()[0].class).to.equal(rootClass());
        await history.redo();
        expect(cars()[0].class).to.equal(target.class);
      });

      it('reclassifies a coupled car through its body, which has no free end', async () => {
        // Chaining makes couplings the normal case, so a verb that could not
        // reach a coupled car could not reach most cars.
        const el = await mountWithCarTool();
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        await clickAt(el, { x: 700, y: 100 });
        await endChain(el);
        const [first] = structuredClone(cars());
        const target = firstChoice.children[0] ?? firstChoice;

        await rightClickAt(el, { x: 550, y: 100 });
        await choose(el, `reclassify:${target.class}`);

        expect(cars()[0].class).to.equal(first.class);
        expect(cars()[1].class).to.equal(target.class);
      });

      it('drops a reclassify whose car went away underneath the open menu', async () => {
        const el = await mountWithOneCar();
        const target = firstChoice.children[0] ?? firstChoice;

        await rightClickAt(el, { x: 250, y: 100 });
        // An undo landing while the menu is up.
        archive.getManifest().images[0].labels = [];
        await choose(el, `reclassify:${target.class}`);

        expect(cars()).to.deep.equal([]);
      });

      it('does nothing for a group row, which is opened and never chosen', async () => {
        // If something reported one anyway, it must not write an unrooted or
        // empty class — the prefix is what makes that unmistakable.
        const el = await mountWithOneCar();
        const before = structuredClone(cars());

        await rightClickAt(el, { x: 250, y: 100 });
        menuOf(el).dispatchEvent(
          new CustomEvent('rr-context-menu-select', {
            detail: { id: `reclassify-group:${rootClass()}` },
            bubbles: true,
            composed: true,
          })
        );
        await flush();

        expect(cars()).to.deep.equal(before);
      });
    });

    describe('per image', () => {
      it('shows the selected image\'s cars, and records nothing for the switch', async () => {
        addSecondImage();
        const history = new EditHistory();
        history.attach(archive);
        const el = await mountWithCarTool(history);

        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        const placed = history.size;

        await selectImage(el, 1);

        // Selection is view state: nothing in the manifest changed.
        expect(history.size).to.equal(placed);
        expect(el.shadowRoot!.querySelector('rr-viewer')!.cars).to.deep.equal([]);

        await clickAt(el, { x: 200, y: 200 });
        await clickAt(el, { x: 500, y: 200 });

        // Labels are not carried between images.
        expect(cars(0)).to.have.length(1);
        expect(cars(1)).to.have.length(1);
        expect(cars(1)[0].p0).to.deep.equal({ x: 200, y: 200 });

        await selectImage(el, 0);
        expect(el.shadowRoot!.querySelector('rr-viewer')!.cars).to.deep.equal(cars(0));
      });

      it('abandons a placement when the image changes', async () => {
        // The anchor is a pixel on the image it was clicked on.
        addSecondImage();
        const el = await mountWithCarTool();

        await clickAt(el, { x: 100, y: 100 });
        await selectImage(el, 1);
        await clickAt(el, { x: 400, y: 100 });

        expect(cars(0)).to.have.length(0);
        expect(cars(1)).to.have.length(0);
      });

      it('abandons a placement when an undo reveals another image', async () => {
        // `rr-app` calls syncFromArchive() after an undo whose entry targets a
        // different image. The anchor would otherwise survive the jump and the
        // next click would write a car with one end from each frame.
        addSecondImage();
        const el = await mountWithCarTool();

        await selectImage(el, 1);
        await clickAt(el, { x: 100, y: 100 });
        await el.syncFromArchive('img1.jpg');
        await el.updateComplete;

        await clickAt(el, { x: 400, y: 100 });

        expect(cars(0)).to.have.length(0);
        expect(cars(1)).to.have.length(0);
      });

      it('grabs only the cars of the image on screen', async () => {
        addSecondImage();
        const el = await mountWithCarTool();
        await clickAt(el, { x: 100, y: 100 });
        await clickAt(el, { x: 400, y: 100 });
        const before = structuredClone(cars(0));

        await selectImage(el, 1);
        await drag(el, [
          { x: 100, y: 100 },
          { x: 300, y: 300 },
        ]);

        expect(cars(0)).to.deep.equal(before);
      });
    });

    it('round-trips through a save and reopen', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await endChain(el);
      await clickAt(el, { x: 100, y: 500 });
      await clickAt(el, { x: 400, y: 500 });

      // Reopening validates against the v4 schema — a label the schema refused
      // would throw here rather than compare unequal.
      const reopened = await R49Archive.load(await archive.export());

      expect(reopened.getManifest().images[0].labels).to.deep.equal(cars());
      expect(reopened.getManifest().images[0].labels).to.have.length(2);
    });

    it('authors nothing while the gate is closed', async () => {
      // The car tool cannot be live without a DPT — the palette disables it and
      // `willUpdate` demotes it — so a click means calibration instead.
      const el = await mount();
      await selectTool(el, 'car');
      const show = stubDialog(el);

      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });

      expect(el.railState.tool).to.equal('calibration');
      expect(cars()).to.have.length(0);
      expect(show).toHaveBeenCalled();
    });
  });

  describe('labeling completeness', () => {
    /** The `labeled_complete` control for the image on screen. */
    function checkbox(el: RREditorView): SlCheckbox {
      return el.shadowRoot!.querySelector('sl-checkbox')!;
    }

    /** Sets the control the way Shoelace reports a user toggling it. */
    async function setComplete(el: RREditorView, value: boolean) {
      const box = checkbox(el);
      box.checked = value;
      box.dispatchEvent(new CustomEvent('sl-change', { bubbles: true, composed: true }));
      await flush();
      await el.updateComplete;
    }

    function images() {
      return archive.getManifest().images;
    }

    function addSecondImage() {
      images().push({ filename: 'img2.jpg', labeled_complete: false, labels: [] });
    }

    it('offers a control for the image on screen, unchecked by default', async () => {
      // "A human asserts no car is unlabeled" is a claim no default can make.
      const el = await mount();
      expect(checkbox(el)).to.exist;
      expect(checkbox(el).checked).to.be.false;
    });

    it('records the toggle as one entry targeting that image', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await setComplete(el, true);

      expect(images()[0].labeled_complete).to.be.true;
      expect(history.size).to.equal(1);

      const entry = await history.undo();
      expect(entry!.target).to.deep.equal({ kind: 'image', filename: 'img1.jpg' });
      expect(images()[0].labeled_complete).to.be.false;

      await history.redo();
      expect(images()[0].labeled_complete).to.be.true;
    });

    it('records un-marking as its own entry', async () => {
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await setComplete(el, true);
      await setComplete(el, false);

      expect(images()[0].labeled_complete).to.be.false;
      expect(history.size).to.equal(2);
      await history.undo();
      expect(images()[0].labeled_complete).to.be.true;
    });

    it('follows an undo back, having been toggled by hand', async () => {
      // The control is the one place the flag is set, so it is also the one
      // place a stale readout would let a user believe they had asserted
      // something they had just undone. A plain `?checked` binding dirty-checks
      // against what it last wrote rather than against the box, and is
      // sufficient here only because **every toggle writes through**: the
      // render that follows the user's click resyncs the binding, so the undo
      // after it is a change Lit sees. A handler that could bail without
      // writing would need `live()`, and this is the test that would say so.
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await setComplete(el, true);
      await history.undo();
      await el.syncFromArchive('img1.jpg');
      await el.updateComplete;

      expect(images()[0].labeled_complete).to.be.false;
      expect(checkbox(el).checked).to.be.false;
    });

    it('marks an image with zero cars complete, with no warning', async () => {
      // An all-background sample is legitimate, not a gap.
      const el = await mount();
      await setComplete(el, true);

      expect(images()[0].labels).to.have.length(0);
      expect(images()[0].labeled_complete).to.be.true;
      expect(el.shadowRoot!.querySelector('.complete-bar')!.textContent).to.not.match(/warn/i);
    });

    it('shows the flag of the image on screen, and follows a switch', async () => {
      addSecondImage();
      images()[1].labeled_complete = true;
      const el = await mount();

      expect(checkbox(el).checked).to.be.false;

      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index: 1 }, bubbles: true, composed: true })
      );
      await el.updateComplete;

      expect(checkbox(el).checked).to.be.true;
    });

    it('hands every image\'s flag to the thumbnail bar', async () => {
      // Visible per image without selecting it: the scan is the workflow.
      addSecondImage();
      images()[1].labeled_complete = true;
      const el = await mount();

      expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')!.complete).to.deep.equal([
        false,
        true,
      ]);
    });

    it('round-trips the flag, and adds a new image as incomplete', async () => {
      const el = await mount();
      await setComplete(el, true);

      const reopened = await R49Archive.load(await archive.export());
      expect(reopened.getManifest().images[0].labeled_complete).to.be.true;

      await archive.addImage('img2.jpg', new Uint8Array([1, 2, 3]));
      expect(images()[1].labeled_complete).to.be.false;
    });
  });

  describe('the reveal after an undo (#37)', () => {
    // `rr-app` hands the editor what an entry changed; the editor decides which
    // of those objects still exist on the image now on screen, and lights them.
    // Nothing here asserts that a glow is visible — jsdom neither lays out nor
    // paints — only which objects are marked as lit.

    const car = (id: string, x: number): CarLabel => ({
      id,
      class: 'stock',
      provenance: 'human',
      p0: { x, y: 100 },
      p1: { x: x + 200, y: 100 },
    });

    /** What the viewer was told to light. */
    const highlightOf = (el: RREditorView) =>
      el.shadowRoot!.querySelector('rr-viewer')!.highlight;

    function addSecondImage() {
      archive.getManifest().images.push({
        filename: 'img2.jpg',
        labeled_complete: false,
        labels: [],
      });
    }

    /** Selects an image the way the thumbnail bar reports a click on one. */
    async function selectImage(el: RREditorView, index: number) {
      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index }, bubbles: true, composed: true })
      );
      await el.updateComplete;
    }

    it('lights the car an entry changed, on the image it revealed', async () => {
      addSecondImage();
      archive.getManifest().images[1].labels = [car('car-a', 100), car('car-b', 600)];
      const el = await mount();

      await el.syncFromArchive('img2.jpg', [{ kind: 'car', id: 'car-b' }]);
      await el.updateComplete;

      expect(highlightOf(el)).to.deep.equal({
        cars: ['car-b'],
        sensors: [],
        calibration: [],
      });
    });

    it('drops an object the apply removed, rather than throwing', async () => {
      // The undone *add*: the entry names a car that is no longer there once
      // the snapshot has landed. Revealing it is a no-op, not an error.
      const el = await mount();

      await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'gone' }]);
      await el.updateComplete;

      expect(highlightOf(el)).to.be.null;
    });

    it('lights a layout object without changing the image on screen', async () => {
      addSecondImage();
      archive.getManifest().layout.sensors = [
        { id: 'sensor-a', x: 10, y: 10 },
        { id: 'sensor-b', x: 20, y: 20 },
      ];
      const el = await mount();
      await selectImage(el, 1);

      await el.syncFromArchive(undefined, [{ kind: 'sensor', id: 'sensor-b' }]);
      await el.updateComplete;

      expect(highlightOf(el)!.sensors).to.deep.equal(['sensor-b']);
      expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')!.selectedIndex).to.equal(1);
    });

    it('resolves a calibration point by pixel, since an undo renumbers them', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 10, y: 20 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 30, y: 40 }, world: { x: 250, y: 0, z: 0 } },
      ];
      const el = await mount();

      await el.syncFromArchive(undefined, [{ kind: 'calibration', px: { x: 30, y: 40 } }]);
      await el.updateComplete;

      expect(highlightOf(el)!.calibration).to.deep.equal([1]);
    });

    it('follows a calibration point through a renumbering while the glow is up', async () => {
      // The viewer can only address a point by index, and an edit landing
      // during the 1400 ms — another undo, a delete — renumbers the list. An
      // index resolved when the reveal landed would light a different
      // crosshair, which is the staleness `_pointIsStillAt` exists to refuse.
      const points = archive.getManifest().layout.calibration;
      points.points = [
        { px: { x: 10, y: 20 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 30, y: 40 }, world: { x: 250, y: 0, z: 0 } },
      ];
      const el = await mount();
      await el.syncFromArchive(undefined, [{ kind: 'calibration', px: { x: 30, y: 40 } }]);
      await el.updateComplete;
      expect(highlightOf(el)!.calibration).to.deep.equal([1]);

      points.points = [{ px: { x: 30, y: 40 }, world: { x: 250, y: 0, z: 0 } }];
      el.requestUpdate();
      await el.updateComplete;

      expect(highlightOf(el)!.calibration).to.deep.equal([0]);
    });

    it('takes the glow away again', async () => {
      // Transient by a timer, because the object stays where it is: a highlight
      // that outlived its edit would claim every later look at the image.
      vi.useFakeTimers();
      try {
        archive.getManifest().images[0].labels = [car('car-a', 100)];
        const el = await mount();

        await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'car-a' }]);
        await el.updateComplete;
        expect(highlightOf(el)!.cars).to.deep.equal(['car-a']);

        vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
        await el.updateComplete;

        expect(highlightOf(el)).to.be.null;
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops a stale glow when the user switches image', async () => {
      addSecondImage();
      archive.getManifest().images[0].labels = [car('car-a', 100)];
      const el = await mount();
      await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'car-a' }]);
      await el.updateComplete;

      await selectImage(el, 1);

      expect(highlightOf(el)).to.be.null;
    });
  });

  describe('zoom (#44)', () => {
    // The editor's half of the feature: which gesture means what, and what the
    // viewer is handed. Nothing here claims the photograph moved — jsdom
    // neither lays out nor paints, and the arithmetic itself is covered in
    // geometry.test.ts.

    /** A frame big enough to have corners worth zooming into. */
    function widen() {
      archive.getManifest().camera.resolution = { width: 1000, height: 1000 };
    }

    const viewerOf = (el: RREditorView) => el.shadowRoot!.querySelector('rr-viewer')!;
    const zoomOf = (el: RREditorView) => viewerOf(el).zoom;
    const fitControl = (el: RREditorView) => el.shadowRoot!.querySelector('.fit-control');

    /** What `rr-viewer` reports once it has a laid-out box to measure. */
    async function reportViewport(el: RREditorView, size: { width: number; height: number }) {
      viewerOf(el).dispatchEvent(
        new CustomEvent('rr-viewport', { detail: size, bubbles: true, composed: true })
      );
      await el.updateComplete;
    }

    /**
     * A drag whose pointer is reported on the glass as well as on the image.
     *
     * At one image pixel per screen pixel the two are the same number, which is
     * the simplest honest stand-in for an unzoomed viewport — and a pan is the
     * one gesture that reads the screen pair.
     */
    async function viewDrag(
      el: RREditorView,
      path: readonly Point[],
      { shiftKey = false }: { shiftKey?: boolean } = {}
    ) {
      const options = (point: Point) => ({ shiftKey, client: { x: point.x, y: point.y } });
      gesture(el, 'rr-pointer-down', path[0], 1, options(path[0]));
      for (const point of path.slice(1)) {
        gesture(el, 'rr-pointer-move', point, 1, options(point));
      }
      gesture(el, 'rr-pointer-up', path[path.length - 1], 1, options(path[path.length - 1]));
      await flush();
      await el.updateComplete;
    }

    /** Zooms to a rect by drawing it, which is the only way the editor zooms. */
    async function zoomTo(el: RREditorView, rect: Rect) {
      await viewDrag(el, [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
      ]);
    }

    /** Escape as the browser delivers it: on the focused element, bubbling. */
    async function pressEscape(el: RREditorView) {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })
      );
      await el.updateComplete;
    }

    it('is unzoomed until a gesture zooms it', async () => {
      widen();
      const el = await mount();
      expect(zoomOf(el)).to.be.null;
      expect(fitControl(el)).to.not.exist;
    });

    it('zooms to the rectangle a drag draws on empty image', async () => {
      widen();
      const el = await mount();

      await viewDrag(el, [
        { x: 100, y: 100 },
        { x: 400, y: 300 },
      ]);

      expect(zoomOf(el)).to.deep.equal({ x: 100, y: 100, width: 300, height: 200 });
    });

    it('draws the band while the drag is in flight, and takes it away after', async () => {
      widen();
      const el = await mount();

      gesture(el, 'rr-pointer-down', { x: 100, y: 100 }, 1);
      gesture(el, 'rr-pointer-move', { x: 400, y: 300 }, 1);
      await el.updateComplete;
      expect(viewerOf(el).zoomPreview).to.deep.equal({ x: 100, y: 100, width: 300, height: 200 });

      gesture(el, 'rr-pointer-up', { x: 400, y: 300 }, 1);
      await flush();
      await el.updateComplete;
      expect(viewerOf(el).zoomPreview).to.be.null;
    });

    it('caps a few-pixel drag at one frame pixel per grab radius', async () => {
      widen();
      const el = await mount();
      await reportViewport(el, { width: 700, height: 700 });

      await viewDrag(el, [
        { x: 500, y: 500 },
        { x: 506, y: 506 },
      ]);

      // 700 screen px over 14 per frame px: 50 frame px, not six.
      expect(zoomOf(el)!.width).to.be.closeTo(50, 1e-9);
      expect(zoomOf(el)!.height).to.be.closeTo(50, 1e-9);
    });

    it('zooms on a Shift-drag that begins on an object, and moves nothing', async () => {
      widen();
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await viewDrag(
        el,
        [
          { x: 100, y: 100 },
          { x: 400, y: 400 },
        ],
        { shiftKey: true }
      );

      expect(zoomOf(el)).to.deep.equal({ x: 100, y: 100, width: 300, height: 300 });
      expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
      expect(history.size).to.equal(0);
    });

    it('pans while zoomed, against the pointer and clamped to the frame', async () => {
      widen();
      const el = await mount();
      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });

      await viewDrag(el, [
        { x: 500, y: 500 },
        { x: 600, y: 520 },
      ]);
      // The photograph follows the finger, so the region shown moves the other
      // way — and stays the same size.
      expect(zoomOf(el)).to.deep.equal({ x: 300, y: 380, width: 200, height: 200 });

      await viewDrag(el, [
        { x: 500, y: 500 },
        { x: 1500, y: 500 },
      ]);
      expect(zoomOf(el)!.x).to.equal(0);
    });

    it('converts a pan through the ratio the viewer reports', async () => {
      // Every other test here runs at one frame pixel per screen pixel, where
      // the conversion is invisible. Zoomed **out** — two frame pixels per
      // screen pixel — the same travel on the glass has to move the view twice
      // as far across the photograph.
      widen();
      const el = await mount();
      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });

      const client = (x: number) => ({ shiftKey: false, client: { x, y: 500 } });
      gesture(el, 'rr-pointer-down', { x: 500, y: 500 }, 2, client(500));
      gesture(el, 'rr-pointer-move', { x: 560, y: 500 }, 2, client(550));
      gesture(el, 'rr-pointer-up', { x: 560, y: 500 }, 2, client(550));
      await flush();
      await el.updateComplete;

      // 50 screen px of travel, 100 frame px of view.
      expect(zoomOf(el)!.x).to.equal(300);
    });

    it('grabs a handle at the same screen distance at every zoom', async () => {
      // The tolerance the viewer reports is what makes this true, and nothing
      // in the hit-test changed for zoom: 20 frame pixels away is a hit at two
      // frame pixels per screen pixel (10 screen px, inside the 14 px radius)
      // and a miss at one half (40 screen px, outside it).
      widen();
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      const drag = async (ratio: number) => {
        gesture(el, 'rr-pointer-down', { x: 120, y: 100 }, ratio);
        gesture(el, 'rr-pointer-move', { x: 220, y: 100 }, ratio);
        gesture(el, 'rr-pointer-up', { x: 220, y: 100 }, ratio);
        await flush();
        await el.updateComplete;
      };

      await drag(0.5);
      expect(points()[0].px).to.deep.equal({ x: 100, y: 100 });
      expect(history.size).to.equal(0);

      await drag(2);
      expect(points()[0].px).to.deep.equal({ x: 200, y: 100 });
      expect(history.size).to.equal(1);
    });

    it('still moves an object a drag begins on, at any zoom, as one entry', async () => {
      widen();
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);
      await zoomTo(el, { x: 0, y: 0, width: 300, height: 300 });

      await viewDrag(el, [
        { x: 100, y: 100 },
        { x: 140, y: 130 },
      ]);

      expect(points()[0].px).to.deep.equal({ x: 140, y: 130 });
      expect(history.size).to.equal(1);
      // The drag moved the point, not the view.
      expect(zoomOf(el)).to.deep.equal({ x: 0, y: 0, width: 300, height: 300 });
    });

    it('records nothing for a zoom, a pan or a fit', async () => {
      widen();
      const history = new EditHistory();
      history.attach(archive);
      const el = await mount(history);

      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });
      await viewDrag(el, [
        { x: 500, y: 500 },
        { x: 550, y: 550 },
      ]);
      await pressEscape(el);

      expect(history.size).to.equal(0);
      expect(history.canUndo).to.be.false;
    });

    it('offers the fit control only while zoomed, and fits when it is used', async () => {
      widen();
      const el = await mount();
      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });
      expect(fitControl(el)).to.exist;

      (fitControl(el) as HTMLElement).click();
      await el.updateComplete;

      expect(zoomOf(el)).to.be.null;
      expect(fitControl(el)).to.not.exist;
    });

    it('fits on Escape', async () => {
      widen();
      const el = await mount();
      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });

      await pressEscape(el);

      expect(zoomOf(el)).to.be.null;
    });

    it('leaves the zoom alone when Escape closes a context menu', async () => {
      // The menu swallows its own dismissing keystroke, exactly as it swallows
      // the dismissing press: one Escape closes one thing.
      widen();
      archive.getManifest().layout.sensors = [{ id: 'sensor-a', x: 500, y: 500 }];
      const el = await mount();
      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });
      await rightClickAt(el, { x: 500, y: 500 });
      expect(menuOf(el).open).to.be.true;

      await pressEscape(el);

      expect(menuOf(el).open).to.be.false;
      expect(zoomOf(el)).to.deep.equal({ x: 400, y: 400, width: 200, height: 200 });
    });

    it('keeps the zoom across an image change and drops it for a new archive', async () => {
      widen();
      archive.getManifest().images.push({
        filename: 'img2.jpg',
        labeled_complete: false,
        labels: [],
      });
      const el = await mount();
      await zoomTo(el, { x: 400, y: 400, width: 200, height: 200 });

      el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
        new CustomEvent('rr-image-select', { detail: { index: 1 }, bubbles: true, composed: true })
      );
      await el.updateComplete;
      // The rect is in the per-layout authored frame, so it names the same
      // region on every image of the archive.
      expect(zoomOf(el)).to.deep.equal({ x: 400, y: 400, width: 200, height: 200 });

      const fresh = new R49Archive();
      fresh.setManifest({
        version: 4,
        layout: { name: 'Other', scale: 'N', calibration: { points: [] }, sensors: [] },
        camera: { resolution: { width: 1000, height: 1000 } },
        images: [],
      });
      vi.spyOn(fresh, 'getImage').mockResolvedValue(new Uint8Array());
      el.archive = fresh;
      await el.updateComplete;

      expect(zoomOf(el)).to.be.null;
    });

    it('lets a chain survive a zoom', async () => {
      // The case zoom earns its keep on: chaining a consist while aiming at
      // couplers. Zoom writes nothing and changes no geometry, so the anchor
      // is still there afterwards.
      widen();
      calibrate();
      const el = await mount();
      await selectTool(el, 'car');

      await clickAt(el, { x: 100, y: 100 });
      await zoomTo(el, { x: 50, y: 50, width: 300, height: 300 });
      await clickAt(el, { x: 300, y: 100 });

      const labels = archive.getManifest().images[0].labels;
      expect(labels).to.have.length(1);
      expect(labels[0].p0).to.deep.equal({ x: 100, y: 100 });
      expect(labels[0].p1).to.deep.equal({ x: 300, y: 100 });
      expect(zoomOf(el)).to.deep.equal({ x: 50, y: 50, width: 300, height: 300 });
    });

    describe('a reveal under zoom', () => {
      const car = (id: string, x: number, width: number): CarLabel => ({
        id,
        class: 'stock',
        provenance: 'human',
        p0: { x, y: 100 },
        p1: { x: x + width, y: 100 },
      });

      it('pans to what an undo changed, keeping the zoom level', async () => {
        widen();
        archive.getManifest().images[0].labels = [car('car-a', 100, 40)];
        const el = await mount();
        await zoomTo(el, { x: 700, y: 700, width: 200, height: 200 });

        await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'car-a' }]);
        await el.updateComplete;

        // Centred on the car, at the same 200x200, clamped to the frame.
        expect(zoomOf(el)).to.deep.equal({ x: 20, y: 0, width: 200, height: 200 });
      });

      it('leaves the zoom alone when what changed is already on screen', async () => {
        widen();
        archive.getManifest().images[0].labels = [car('car-a', 720, 40)];
        const el = await mount();
        await zoomTo(el, { x: 700, y: 50, width: 200, height: 200 });

        await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'car-a' }]);
        await el.updateComplete;

        expect(zoomOf(el)).to.deep.equal({ x: 700, y: 50, width: 200, height: 200 });
      });

      it('gives the zoom up when what changed does not fit at this level', async () => {
        widen();
        archive.getManifest().images[0].labels = [car('car-a', 50, 900)];
        const el = await mount();
        await zoomTo(el, { x: 700, y: 700, width: 200, height: 200 });

        await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'car-a' }]);
        await el.updateComplete;

        expect(zoomOf(el)).to.be.null;
      });

      it('moves the view no more than it lights anything, for an undone add', async () => {
        widen();
        const el = await mount();
        await zoomTo(el, { x: 700, y: 700, width: 200, height: 200 });

        await el.syncFromArchive('img1.jpg', [{ kind: 'car', id: 'gone' }]);
        await el.updateComplete;

        expect(zoomOf(el)).to.deep.equal({ x: 700, y: 700, width: 200, height: 200 });
      });
    });
  });

  it('still manages images', async () => {
    const el = await fixture<RREditorView>(html`
      <rr-editor-view .archive=${archive}></rr-editor-view>
    `);
    const bar = el.shadowRoot!.querySelector('rr-thumbnail-bar')!;

    bar.dispatchEvent(new CustomEvent('rr-image-delete', { detail: { index: 0 } }));
    await el.updateComplete;

    expect(archive.getManifest().images).to.have.length(0);
  });
});
