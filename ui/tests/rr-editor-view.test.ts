import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive, getDPT } from '@rails49/r49';
import { MIN_DPT } from '@occupancy/detector';
import type { ReferencePoint, CarLabel, Point, Sensor, WorldPoint } from '@rails49/r49';
import { EditSession } from '../src/editSession.js';
import { HIGHLIGHT_DURATION_MS } from '../src/highlight.js';
import { classChoices, rootClass } from '../src/vocabulary.js';
import '../src/rr-editor-view.js';
import { RREditorView } from '../src/rr-editor-view.js';
import type { RRCalibrationDialog } from '../src/rr-calibration-dialog.js';
import type { RRSensorDialog } from '../src/rr-sensor-dialog.js';
import type { RRContextMenu } from '../src/rr-context-menu.js';
import type { NotifyDetail } from '../src/rr-editor-view.js';
import type { SlCheckbox } from '@shoelace-style/shoelace';
import type { Rect } from '../src/geometry.js';


// The camera and the drift measurement are both mocked: one needs `getUserMedia`
// and the other decodes blobs through `createImageBitmap` and reads pixels back
// out of a canvas, and jsdom has none of the three. What the tests below prove is
// that a drift verdict reaches the screen and blocks nothing — which image is
// measured against which is `driftMeasurements.test.ts`'s, the measurement is
// `lib/drift`'s to prove, and `tools/drift-bench` scores it.
const captureFromCamera = vi.fn(async () => new Uint8Array([1, 2, 3]));
const check = vi.fn(async (_reference: string, _image: string) => ({ displacementPx: 0 }));

vi.mock('../src/capture.js', () => ({
  DEFAULT_CAMERA_CONSTRAINTS: { video: true, audio: false },
  getCameraStream: async () => ({ getTracks: () => [] }),
  captureFromCamera: () => captureFromCamera(),
}));

// `driftVerdict` is the real implementation: it is pure arithmetic over
// MAX_DRIFT_TRACK_FRACTION and a DPT, and it is what makes the tolerance
// geometric rather than an absolute pixel count. Only the IO is stubbed.
vi.mock('../src/driftSession.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/driftSession.js')>();
  return {
    driftVerdict: actual.driftVerdict,
    measureAgainst: () => async (reference: string, image: string) =>
      (await check(reference, image)).displacementPx,
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

  /** The editor on `archive`, without stubbing its dialogs. */
  async function render(on: R49Archive = archive) {
    return fixture<RREditorView>(html`
      <rr-editor-view .session=${new EditSession(on)}></rr-editor-view>
    `);
  }

  it('is defined', () => {
    const el = document.createElement('rr-editor-view');
    expect(el).to.be.instanceOf(RREditorView);
  });

  it('renders placeholder when no session is provided', async () => {
    const el = await fixture<RREditorView>(html`<rr-editor-view></rr-editor-view>`);
    expect(el.shadowRoot!.textContent).to.contain('No archive loaded');
  });

  it('renders components when a session is provided', async () => {
    const el = await render();

    expect(el.shadowRoot!.querySelector('rr-viewer')).to.exist;
    expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')).to.exist;
  });

  describe('DPT readout', () => {
    it('reports "not calibrated" when no DPT resolves', async () => {
      const el = await render();
      const bar = el.shadowRoot!.querySelector('.dpt-bar')!;
      expect(bar).to.exist;
      expect(bar.classList.contains('uncalibrated')).to.be.true;
      expect(bar.textContent).to.contain('Not calibrated');
      // The fit pairs points of equal height only; "two points" alone misleads.
      expect(bar.textContent).to.contain('the same height');
    });

    it('reports the DPT when calibration resolves', async () => {
      // 100 px over 10 mm in N scale (gauge 1435/160 mm) => 10 px/mm * 8.97 mm
      archive.getManifest().layout.calibration = {
        points: [
          { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
          { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
        ],
      };

      const el = await render();
      const bar = el.shadowRoot!.querySelector('.dpt-bar')!;
      expect(bar.classList.contains('uncalibrated')).to.be.false;
      expect(bar.textContent).to.contain('DPT 89.7');
    });

    it('shows the fit residual only once the fit is over-determined', async () => {
      calibrate();
      const el = await mount();
      expect(el.shadowRoot!.querySelector('.dpt-bar')!.textContent).to.not.contain('residual');

      // A third point that disagrees: 210 px where the fitted scale says 200.
      await el.session!.placeReferencePoint({ x: 210, y: 0 }, { x: 20, y: 0, z: 0 });
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.dpt-bar')!.textContent).to.match(/residual \d/);
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
      expect(bar.textContent).to.contain(`minimum of ${MIN_DPT}`);
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
      const el = await render();
      reportMedia(el, { width: 400, height: 400 }, false);
      await el.updateComplete;

      expect(el.shadowRoot!.querySelector('.frame-warning')).to.not.exist;
    });

    it('names both sizes when the shapes disagree', async () => {
      // The two numbers are what says which half is wrong: a re-cropped photo
      // and a mis-typed `camera.resolution` read identically without them.
      const el = await render();
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
      const el = await render();
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
      const el = await render();
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
      check.mockImplementation(async () => ({ displacementPx: 0 }));
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

    const bar = (el: RREditorView) => el.shadowRoot!.querySelector('.drift-warning');
    /** Amber only: a finding, not the reference row and not a measured-fine row. */
    const warning = (el: RREditorView) =>
      el.shadowRoot!.querySelector('.drift-warning:not(.reference):not(.steady):not(.checking)');

    /** Measuring is deliberately not awaited, so wait for its effect. */
    async function waitFor(el: RREditorView, done: () => boolean) {
      for (let i = 0; i < 200 && !done(); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        await el.updateComplete;
      }
      await el.updateComplete;
    }

    async function mountMeasured() {
      const el = await render();
      await waitFor(el, () => check.mock.calls.length >= 2);
      return el;
    }

    it('calls the first image the reference, rather than measuring it', async () => {
      // "Zero because it is the reference" and "measured and found steady" are
      // different claims, and only the first is true at position 0. It also opens
      // on this image, so it is the first thing a labeler reads.
      const el = await mountMeasured();

      const row = bar(el)!;
      expect(row.classList.contains('reference')).to.be.true;
      expect(row.textContent).to.match(/reference image/i);
      expect(row.textContent).to.match(/zero drift by definition/i);
      // And it says how to change it, because the reference is user-movable.
      expect(row.textContent).to.match(/drag another thumbnail/i);
    });

    it('reports a measurement inside tolerance rather than staying silent', async () => {
      // The property that keeps a user-movable reference honest (#118): if the
      // row appeared only past the tolerance, a reorder could re-point the pose
      // with nothing on screen moving.
      check.mockImplementation(async () => ({ displacementPx: 6 }));
      const el = await mountMeasured();

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
      check.mockImplementation(async () => ({ displacementPx: 40.4 }));
      const el = await mountMeasured();

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

    it('says an image is being measured while it is', async () => {
      check.mockImplementation(() => new Promise(() => {}));
      const el = await render();
      select(el, 1);
      await waitFor(el, () => bar(el)?.classList.contains('checking') ?? false);
      expect(bar(el)!.textContent).to.match(/measuring this image/i);
    });

    it('blocks nothing — the image stays selectable and labelable', async () => {
      check.mockImplementation(async () => ({ displacementPx: 60 }));
      const el = await mountMeasured();
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
      check.mockImplementation(async () => ({ displacementPx: 40 }));
      const el = await mountMeasured();

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

    it('checks an image picked off the filesystem too', async () => {
      // #95 names the capture path, and a fresh capture is what it was written
      // about — but a file picked from disk is as likely to come from a session
      // where the tripod had moved, and two paths would mean one of them
      // silently trusting what the other checked.
      const el = await mountMeasured();
      check.mockClear();
      check.mockImplementation(async () => ({ displacementPx: 30.5 }));

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

    it('says nothing at all on an uncalibrated layout, which has no track width', async () => {
      archive.getManifest().layout.calibration = { points: [] };

      const el = await render();
      await new Promise(resolve => setTimeout(resolve, 50));
      await el.updateComplete;

      // Not even the reference row: a fraction of a track width needs a track
      // width, and the calibration gate already has the labeler's attention.
      expect(bar(el)).to.not.exist;
    });

    it('measures again when an undo moves the reference image back (#167)', async () => {
      // Drifted against img3, steady against img1.
      check.mockImplementation(async reference => ({
        displacementPx: reference === 'img3.jpg' ? 30 : 5,
      }));
      const el = await render();

      reorder(el, 2, 0);
      select(el, 1);
      await waitFor(el, () => bar(el)?.textContent?.includes('30.0 px') ?? false);
      expect(bar(el)!.textContent).to.contain('30.0 px');

      await el.session!.undo();

      select(el, 1);
      await waitFor(el, () => bar(el)?.textContent?.includes('5.0 px') ?? false);
      expect(archive.getManifest().images[0].filename).to.equal('img1.jpg');
      expect(bar(el)!.textContent).to.contain('5.0 px');
    });

    it('measures every image once the second calibration point is placed (#167)', async () => {
      archive.getManifest().layout.calibration = { points: [] };
      check.mockImplementation(async () => ({ displacementPx: 6 }));
      const el = await mount();

      await clickAt(el, { x: 0, y: 0 });
      await commit(el, { x: 0, y: 0, z: 0 });
      await clickAt(el, { x: 100, y: 0 });
      await commit(el, { x: 10, y: 0, z: 0 });

      select(el, 2);
      await waitFor(el, () => bar(el)?.classList.contains('steady') ?? false);
      expect(bar(el)!.textContent).to.contain('6.0 px');
    });
  });

  it('passes no interactive or marker state to the viewer', async () => {
    const el = await render();
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

  it('re-renders on a change made to the session from outside', async () => {
    // `rr-app` writes through the same session: the rail's tools, undo and redo.
    const el = await mount();

    await el.session!.setComplete(true);
    await el.updateComplete;

    expect(el.shadowRoot!.querySelector('sl-checkbox')!.checked).to.be.true;
    expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')!.complete).to.deep.equal([true]);
  });

  it('stops listening to a session it no longer shows', async () => {
    const el = await mount();
    const old = el.session!;
    const next = new R49Archive();
    next.setManifest(structuredClone(archive.getManifest()));
    vi.spyOn(next, 'getImage').mockResolvedValue(new Uint8Array());
    el.session = new EditSession(next);
    await el.updateComplete;
    await flush();
    await el.updateComplete;
    const update = vi.spyOn(el, 'requestUpdate');

    await old.setComplete(true);

    expect(update).not.toHaveBeenCalled();
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

  function points(): ReferencePoint[] {
    return archive.getManifest().layout.calibration.points;
  }

  function sensors(): Sensor[] {
    return archive.getManifest().layout.sensors;
  }

  function cars(): CarLabel[] {
    return archive.getManifest().images[0].labels;
  }

  /** The editor on a new session over `archive`, with both dialogs stubbed. */
  async function mount() {
    const el = await render();
    stubDialog(el);
    stubSensorDialog(el);
    return el;
  }

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

  /** A calibrated editor with `tool` live, as the rail would choose it. */
  async function mountWithTool(tool: 'sensor' | 'car') {
    calibrate();
    const el = await mount();
    el.session!.selectTool(tool);
    await el.updateComplete;
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

  /** Selects an image the way `rr-thumbnail-bar` reports one. */
  async function selectImage(el: RREditorView, index: number) {
    el.shadowRoot!.querySelector('rr-thumbnail-bar')!.dispatchEvent(
      new CustomEvent('rr-image-select', { detail: { index }, bubbles: true, composed: true })
    );
    await el.updateComplete;
  }

  function addSecondImage() {
    archive.getManifest().images.push({ filename: 'img2.jpg', labeled_complete: false, labels: [] });
  }

  // The rules behind each gesture are `editSession.test.ts`'s. These check that
  // the gestures reach the session, and that what it asks for reaches a dialog,
  // a menu or a toast.

  describe('reference points', () => {
    it('shows the layout\'s points on the viewer', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 10, y: 20 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();
      expect(el.shadowRoot!.querySelector('rr-viewer')!.calibrationPoints).to.deep.equal(points());
    });

    it('asks for a coordinate on a click, and places the pixel once it is given', async () => {
      const el = await mount();
      const show = stubDialog(el);

      await clickAt(el, { x: 120.4, y: 200.6 });
      expect(show).toHaveBeenCalledOnce();
      expect(points()).to.have.length(0);

      await commit(el, { x: 0, y: 250, z: 0 });
      expect(points()).to.deep.equal([{ px: { x: 120, y: 201 }, world: { x: 0, y: 250, z: 0 } }]);
    });

    it('places nothing when the dialog is dismissed', async () => {
      const el = await mount();
      await clickAt(el, { x: 10, y: 10 });
      // No commit: the user cancelled.
      expect(points()).to.have.length(0);
      expect(el.session!.history.size).to.equal(0);
    });

    it('opens the dialog on the point under the click, and edits it', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();
      const show = stubDialog(el);

      await clickAt(el, { x: 105, y: 103 });
      expect(show).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { mode: 'edit' });

      await commit(el, { x: 0, y: 250, z: 0 });
      expect(points()).to.deep.equal([{ px: { x: 100, y: 100 }, world: { x: 0, y: 250, z: 0 } }]);
    });

    it('passes the zoom the viewer reports to the hit-test', async () => {
      archive.getManifest().layout.calibration.points = [
        { px: { x: 100, y: 100 }, world: { x: 0, y: 0, z: 0 } },
      ];
      const el = await mount();
      const show = stubDialog(el);

      // 40 image px away: inside the grab radius only at four image px per screen px.
      await clickAt(el, { x: 140, y: 100 }, 4);

      expect(show).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { mode: 'edit' });
    });

    it('ignores a swipe, so it places nothing', async () => {
      const el = await mount();
      const show = stubDialog(el);

      await drag(el, [{ x: 10, y: 10 }, { x: 60, y: 40 }]);

      expect(show).not.toHaveBeenCalled();
      expect(points()).to.have.length(0);
    });

    it('tolerates the hand tremor inside a click, and uses the press position', async () => {
      const el = await mount();
      // Two image pixels apart at 1:1 — inside the slop.
      gesture(el, 'rr-pointer-down', { x: 30, y: 20 }, 1);
      gesture(el, 'rr-pointer-up', { x: 32, y: 21 }, 1);
      await flush();
      await el.updateComplete;
      await commit(el, { x: 0, y: 0, z: 0 });

      expect(points()[0].px).to.deep.equal({ x: 30, y: 20 });
    });

    it('updates the DPT readout as points are placed', async () => {
      const el = await mount();
      const bar = () => el.shadowRoot!.querySelector('.dpt-bar')!;

      await clickAt(el, { x: 0, y: 0 });
      await commit(el, { x: 0, y: 0, z: 0 });
      expect(bar().textContent).to.contain('Not calibrated');

      await clickAt(el, { x: 100, y: 0 });
      await commit(el, { x: 10, y: 0, z: 0 });
      expect(bar().textContent).to.contain('DPT 89.7');
    });

    describe('dragging', () => {
      function seed(...pixels: readonly Point[]) {
        archive.getManifest().layout.calibration.points = pixels.map((px, i) => ({
          px,
          world: { x: i * 10, y: 0, z: 0 },
        }));
      }

      it('moves the point that was grabbed, as one entry, and opens no dialog', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();
        const show = stubDialog(el);

        await drag(el, [
          { x: 13, y: 12 },
          { x: 30, y: 30 },
          { x: 53, y: 52 },
        ]);

        expect(points()[0].px).to.deep.equal({ x: 50, y: 50 });
        expect(el.session!.history.size).to.equal(1);
        expect(show).not.toHaveBeenCalled();
      });

      it('takes the DPT readout with it, before the pointer is released', async () => {
        seed({ x: 0, y: 0 }, { x: 100, y: 0 });
        const el = await mount();
        const bar = () => el.shadowRoot!.querySelector('.dpt-bar')!.textContent!;
        expect(bar()).to.contain('DPT 89.7');

        gesture(el, 'rr-pointer-down', { x: 100, y: 0 }, 1);
        gesture(el, 'rr-pointer-move', { x: 200, y: 0 }, 1);
        await flush();
        await el.updateComplete;

        expect(bar()).to.contain('DPT 179.4');
      });

      it('records nothing for a drag returned to its origin, and opens no dialog', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();
        const show = stubDialog(el);

        await drag(el, [
          { x: 10, y: 10 },
          { x: 60, y: 40 },
          { x: 10, y: 10 },
        ]);

        expect(el.session!.history.size).to.equal(0);
        expect(show).not.toHaveBeenCalled();
      });

      it('puts the point back and records nothing when the browser cancels', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1);
        gesture(el, 'rr-pointer-move', { x: 60, y: 40 }, 1);
        gesture(el, 'rr-pointer-cancel', { x: 60, y: 40 }, 1);
        await flush();
        await el.updateComplete;

        expect(points()[0].px).to.deep.equal({ x: 10, y: 10 });
        expect(el.session!.history.size).to.equal(0);
      });

      it('ignores a second finger arriving mid-drag', async () => {
        seed({ x: 10, y: 10 }, { x: 80, y: 80 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1, { pointerId: 1 });
        gesture(el, 'rr-pointer-down', { x: 80, y: 80 }, 1, { pointerId: 2 });
        gesture(el, 'rr-pointer-move', { x: 90, y: 90 }, 1, { pointerId: 2 });
        gesture(el, 'rr-pointer-up', { x: 90, y: 90 }, 1, { pointerId: 2 });
        gesture(el, 'rr-pointer-move', { x: 40, y: 30 }, 1, { pointerId: 1 });
        gesture(el, 'rr-pointer-up', { x: 40, y: 30 }, 1, { pointerId: 1 });
        await flush();
        await el.updateComplete;

        expect(points()[1].px).to.deep.equal({ x: 80, y: 80 });
        expect(points()[0].px).to.deep.equal({ x: 40, y: 30 });
        expect(el.session!.history.size).to.equal(1);
      });

      it('closes a drag whose end never arrived, rather than wedging on it', async () => {
        // A press on the same pointerId cannot be a second finger, so it ends
        // the stale gesture, which keeps both the editor and undo responsive.
        seed({ x: 10, y: 10 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1);
        gesture(el, 'rr-pointer-move', { x: 30, y: 30 }, 1);
        await flush();

        await drag(el, [{ x: 30, y: 30 }, { x: 35, y: 35 }]);

        expect(points()[0].px).to.deep.equal({ x: 35, y: 35 });
        expect(el.session!.history.size).to.equal(2);
      });

      it('closes an open drag when the element goes away', async () => {
        // `rr-app` replaces this element on the view toggle. A drag left open
        // there would refuse every undo for the rest of the session.
        seed({ x: 10, y: 10 });
        const el = await mount();
        const session = el.session!;

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1);
        gesture(el, 'rr-pointer-move', { x: 30, y: 30 }, 1);
        await flush();
        el.remove();
        await flush();

        expect(session.history.size).to.equal(1);
        await session.undo();
        expect(points()[0].px).to.deep.equal({ x: 10, y: 10 });
      });
    });

    describe('right-click context menu', () => {
      function seed(...pixels: readonly Point[]) {
        archive.getManifest().layout.calibration.points = pixels.map((px, i) => ({
          px,
          world: { x: i * 10, y: 0, z: 0 },
        }));
      }

      it('opens on the object under the cursor, carrying delete', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();

        await rightClickAt(el, { x: 13, y: 11 }, { x: 640, y: 400 });

        expect(menuOf(el).open).to.be.true;
        expect(menuItems(el)).to.deep.equal(['delete']);
        // At the cursor, in the client frame the right-click was reported in.
        expect(menuOf(el).style.getPropertyValue('--menu-x')).to.equal('640px');
        expect(menuOf(el).style.getPropertyValue('--menu-y')).to.equal('400px');
      });

      it('opens nothing on empty image', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();

        await rightClickAt(el, { x: 80, y: 80 });

        expect(menuOf(el).open).to.be.false;
      });

      it('suppresses the browser menu inside the viewer, hit or miss', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();

        expect((await rightClickAt(el, { x: 10, y: 10 })).defaultPrevented).to.be.true;
        expect((await rightClickAt(el, { x: 80, y: 80 })).defaultPrevented).to.be.true;
      });

      it('deletes the point, closes, and takes the DPT readout with it', async () => {
        seed({ x: 0, y: 0 }, { x: 100, y: 0 });
        const el = await mount();

        await rightClickAt(el, { x: 100, y: 0 });
        await choose(el, 'delete');

        expect(points()).to.have.length(1);
        expect(menuOf(el).open).to.be.false;
        expect(el.shadowRoot!.querySelector('.dpt-bar')!.textContent).to.contain('Not calibrated');
      });

      it('does not run the click path for the right button', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();
        const show = stubDialog(el);

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1, { button: 2 });
        gesture(el, 'rr-pointer-up', { x: 10, y: 10 }, 1, { button: 2 });
        await flush();
        await el.updateComplete;

        expect(show).not.toHaveBeenCalled();
        expect(el.session!.history.size).to.equal(0);
      });

      it('leaves a live drag alone when a secondary button is released', async () => {
        // One `pointerId` covers every mouse button, so the right button's
        // release carries the left drag's id.
        seed({ x: 10, y: 10 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1);
        gesture(el, 'rr-pointer-move', { x: 30, y: 30 }, 1);
        gesture(el, 'rr-pointer-up', { x: 30, y: 30 }, 1, { button: 2 });
        await flush();
        expect(el.session!.history.size).to.equal(0);

        gesture(el, 'rr-pointer-move', { x: 35, y: 35 }, 1);
        gesture(el, 'rr-pointer-up', { x: 35, y: 35 }, 1);
        await flush();
        await el.updateComplete;

        expect(points()[0].px).to.deep.equal({ x: 35, y: 35 });
        expect(el.session!.history.size).to.equal(1);
      });

      it('ignores a right-click during a drag', async () => {
        seed({ x: 10, y: 10 });
        const el = await mount();

        gesture(el, 'rr-pointer-down', { x: 10, y: 10 }, 1);
        gesture(el, 'rr-pointer-move', { x: 30, y: 30 }, 1);
        await flush();
        await rightClickAt(el, { x: 30, y: 30 });

        expect(menuOf(el).open).to.be.false;
      });
    });
  });

  describe('sensors', () => {
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

    it('places a sensor on a click with the sensor tool, asking nothing', async () => {
      const el = await mountWithTool('sensor');
      const show = stubSensorDialog(el);

      await clickAt(el, { x: 32, y: 24 });

      expect(sensors()).to.have.length(1);
      expect(show).not.toHaveBeenCalled();
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.sensors).to.deep.equal(sensors());
      expect(viewer.dpt).to.equal(getDPT(archive.getManifest()));
    });

    it('names a sensor from the context menu', async () => {
      const el = await mountWithTool('sensor');
      await clickAt(el, { x: 32, y: 74 });
      const show = stubSensorDialog(el);

      await rightClickAt(el, { x: 32, y: 74 });
      expect(menuItems(el)).to.deep.equal(['name', 'delete']);

      await choose(el, 'name');
      expect(show).toHaveBeenCalledWith(null, { id: sensors()[0].id });

      await commitName(el, 'Yard throat');
      expect(sensors()[0].name).to.equal('Yard throat');
    });

    it('names a sensor from a click on it, whatever the tool is', async () => {
      const el = await mountWithTool('sensor');
      await clickAt(el, { x: 32, y: 74 });
      el.session!.selectTool('calibration');
      const show = stubSensorDialog(el);
      const calibrationShow = stubDialog(el);

      await clickAt(el, { x: 34, y: 75 });
      await commitName(el, null);

      expect(show).toHaveBeenCalledOnce();
      expect(calibrationShow).not.toHaveBeenCalled();
      expect('name' in sensors()[0]).to.be.false;
    });

    it('deletes a sensor from the context menu', async () => {
      const el = await mountWithTool('sensor');
      await clickAt(el, { x: 32, y: 74 });

      await rightClickAt(el, { x: 32, y: 74 });
      await choose(el, 'delete');

      expect(sensors()).to.deep.equal([]);
    });
  });

  describe('cars', () => {
    /** The rubber band the viewer is drawing — the anchor made visible. */
    function band(el: RREditorView) {
      return el.shadowRoot!.querySelector('rr-viewer')!.pendingCar;
    }

    /** A pointer move with no button down — what the band follows. */
    async function moveTo(el: RREditorView, point: Point) {
      gesture(el, 'rr-pointer-move', point, 1);
      await el.updateComplete;
    }

    /** A wide frame and a calibrated archive with the car tool live. */
    async function mountWithCarTool() {
      archive.getManifest().camera.resolution = { width: 2000, height: 2000 };
      return mountWithTool('car');
    }

    /** Every notice the editor sends up, in order. */
    function noticesOf(el: RREditorView): string[] {
      const notices: string[] = [];
      el.addEventListener('rr-notify', e =>
        notices.push((e as CustomEvent<NotifyDetail>).detail.message)
      );
      return notices;
    }

    it('writes a car from two clicks, and hands it and the DPT to the viewer', async () => {
      const el = await mountWithCarTool();

      await clickAt(el, { x: 200, y: 300 });
      await clickAt(el, { x: 500, y: 300 });

      expect(cars()).to.have.length(1);
      const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
      expect(viewer.cars).to.deep.equal(cars());
      expect(viewer.dpt).to.equal(getDPT(archive.getManifest()));
    });

    it('draws a band from the anchor to the cursor, and re-anchors it on each click', async () => {
      const el = await mountWithCarTool();
      expect(band(el)).to.equal(null);

      await clickAt(el, { x: 100, y: 100 });
      // Before the pointer moves the band is the anchor twice: the handle is
      // the feedback that the first click landed.
      expect(band(el)).to.deep.equal({ anchor: { x: 100, y: 100 }, to: { x: 100, y: 100 } });

      await moveTo(el, { x: 380.4, y: 220.6 });
      expect(band(el)).to.deep.equal({ anchor: { x: 100, y: 100 }, to: { x: 380, y: 221 } });

      await clickAt(el, { x: 400, y: 100 });
      await moveTo(el, { x: 600, y: 100 });
      expect(band(el)).to.deep.equal({ anchor: { x: 400, y: 100 }, to: { x: 600, y: 100 } });
    });

    it('ends the chain on right-click, opening no menu, and takes the band away', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });

      await rightClickAt(el, { x: 900, y: 900 });

      expect(band(el)).to.equal(null);
      expect(menuOf(el).open).to.be.false;
      expect(cars()).to.have.length(1);
    });

    it('moves the band back as an undo walks the chain back', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await clickAt(el, { x: 700, y: 100 });

      await el.session!.undo();
      await el.session!.undo();
      await el.updateComplete;

      // An undo moves the anchor, not the mouse.
      expect(band(el)).to.deep.equal({ anchor: { x: 100, y: 100 }, to: { x: 700, y: 100 } });
    });

    it('says why it refused a click on a car already labeled', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await rightClickAt(el, { x: 900, y: 900 });
      const notices = noticesOf(el);

      await clickAt(el, { x: 250, y: 100 });
      await clickAt(el, { x: 400, y: 100 });

      expect(notices).to.deep.equal([
        'That pixel is already inside a labeled car — a car is labeled once.',
        'That pixel is already inside a labeled car — a car is labeled once.',
      ]);
      expect(band(el)).to.equal(null);
    });

    it('offers delete and the authored vocabulary on a car, never the root', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await rightClickAt(el, { x: 900, y: 900 });

      await rightClickAt(el, { x: 250, y: 140 });

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
      // Generated from the vocabulary in `@rails49/r49`'s data file: a subtype added there changes this
      // menu with no code edit (#35).
      expect(submenuItems(el, `reclassify-group:${rootClass()}`)).to.deep.equal(
        classChoices().map(choice =>
          choice.children.length > 0 ? `reclassify-group:${choice.class}` : `reclassify:${choice.class}`
        )
      );
    });

    it('reclassifies a car from the menu, and does nothing for a group row', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await rightClickAt(el, { x: 900, y: 900 });
      const [first] = classChoices();
      const target = first.children[0] ?? first;

      await rightClickAt(el, { x: 250, y: 100 });
      menuOf(el).dispatchEvent(
        new CustomEvent('rr-context-menu-select', {
          detail: { id: `reclassify-group:${rootClass()}` },
          bubbles: true,
          composed: true,
        })
      );
      await flush();
      expect(cars()[0].class).to.equal(rootClass());

      await rightClickAt(el, { x: 250, y: 100 });
      await choose(el, `reclassify:${target.class}`);
      expect(cars()[0].class).to.equal(target.class);
    });

    it('deletes a car from the menu', async () => {
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });
      await rightClickAt(el, { x: 900, y: 900 });

      await rightClickAt(el, { x: 250, y: 100 });
      await choose(el, 'delete');

      expect(cars()).to.deep.equal([]);
    });

    it('shows the selected image\'s cars, and ends the chain for the switch', async () => {
      addSecondImage();
      const el = await mountWithCarTool();
      await clickAt(el, { x: 100, y: 100 });
      await clickAt(el, { x: 400, y: 100 });

      await selectImage(el, 1);

      expect(el.session!.image!.filename).to.equal('img2.jpg');
      expect(el.shadowRoot!.querySelector('rr-viewer')!.cars).to.deep.equal([]);
      expect(band(el)).to.equal(null);
      expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')!.selectedIndex).to.equal(1);
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

    it('offers a control for the image on screen, unchecked by default', async () => {
      // "A human asserts no car is unlabeled" is a claim no default can make.
      const el = await mount();
      expect(checkbox(el)).to.exist;
      expect(checkbox(el).checked).to.be.false;
    });

    it('writes the toggle through the session', async () => {
      const el = await mount();

      await setComplete(el, true);

      expect(images()[0].labeled_complete).to.be.true;
      expect(el.session!.history.size).to.equal(1);
      expect(el.shadowRoot!.querySelector('.complete-bar')!.textContent).to.not.match(/warn/i);
    });

    it('follows an undo back, having been toggled by hand', async () => {
      // A plain `?checked` binding dirty-checks against what it last wrote, and
      // is sufficient only because every toggle writes through: the render after
      // the click resyncs the binding, so the undo after it is a change Lit sees.
      const el = await mount();

      await setComplete(el, true);
      await el.session!.undo();
      await el.updateComplete;

      expect(images()[0].labeled_complete).to.be.false;
      expect(checkbox(el).checked).to.be.false;
    });

    it('shows the flag of the image on screen, and follows a switch', async () => {
      addSecondImage();
      images()[1].labeled_complete = true;
      const el = await mount();

      expect(checkbox(el).checked).to.be.false;
      await selectImage(el, 1);
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
  });

  describe('images', () => {
    const bar = (el: RREditorView) => el.shadowRoot!.querySelector('rr-thumbnail-bar')!;

    it('deletes an image from the thumbnail bar', async () => {
      const el = await mount();

      bar(el).dispatchEvent(new CustomEvent('rr-image-delete', { detail: { index: 0 } }));
      await flush();
      await el.updateComplete;

      expect(archive.getManifest().images).to.have.length(0);
    });

    it('adds a captured image and shows it', async () => {
      const el = await mount();

      bar(el).dispatchEvent(new CustomEvent('rr-image-add', { detail: { source: 'camera' } }));
      await flush();
      await el.updateComplete;

      expect(archive.getManifest().images).to.have.length(2);
      expect(bar(el).selectedIndex).to.equal(1);
    });

    it('keeps the image on screen through a reorder', async () => {
      addSecondImage();
      const el = await mount();
      await selectImage(el, 1);

      bar(el).dispatchEvent(new CustomEvent('rr-image-reorder', { detail: { from: 1, to: 0 } }));
      await flush();
      await el.updateComplete;

      expect(archive.getManifest().images[0].filename).to.equal('img2.jpg');
      expect(bar(el).selectedIndex).to.equal(0);
    });

    it('makes a blob URL per image once, and revokes it when the image goes', async () => {
      addSecondImage();
      const el = await mount();
      await flush();
      await el.updateComplete;
      const create = vi.mocked(URL.createObjectURL);
      expect(create).toHaveBeenCalledTimes(2);

      el.session!.selectTool('car');
      await el.session!.setComplete(true);
      await el.session!.undo();
      await flush();
      await el.updateComplete;
      expect(create).toHaveBeenCalledTimes(2);

      bar(el).dispatchEvent(new CustomEvent('rr-image-delete', { detail: { index: 0 } }));
      await flush();
      await el.updateComplete;
      expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    });
  });

  describe('the reveal after an undo (#37)', () => {
    // The session reports what an undo or redo changed; the editor decides which
    // of those objects still exist on the image now on screen, and lights them.
    // Nothing here asserts that a glow is visible — jsdom neither lays out nor
    // paints — only which objects are marked as lit.

    const car = (id: string, x: number, width = 200): CarLabel => ({
      id,
      class: 'stock',
      provenance: 'human',
      p0: { x, y: 100 },
      p1: { x: x + width, y: 100 },
    });

    /** What the viewer was told to light. */
    const highlightOf = (el: RREditorView) =>
      el.shadowRoot!.querySelector('rr-viewer')!.highlight;

    /** Places `labels` on an image as one entry, the way an edit would. */
    async function place(el: RREditorView, filename: string, labels: CarLabel[]) {
      await el.session!.history.record('place car', { kind: 'image', filename }, () => {
        archive.getManifest().images.find(image => image.filename === filename)!.labels = labels;
      });
    }

    it('lights the car an entry changed, on the image it revealed', async () => {
      addSecondImage();
      const el = await mount();
      await place(el, 'img2.jpg', [car('car-a', 100), car('car-b', 600)]);
      await el.session!.undo();
      await selectImage(el, 0);

      await el.session!.redo();
      await el.updateComplete;

      expect(el.session!.image!.filename).to.equal('img2.jpg');
      expect(highlightOf(el)).to.deep.equal({
        cars: ['car-a', 'car-b'],
        sensors: [],
        calibration: [],
      });
    });

    it('drops an object the apply removed, rather than throwing', async () => {
      // The undone *add*: the entry names a car that is no longer there once
      // the snapshot has landed. Revealing it is a no-op, not an error.
      const el = await mount();
      await place(el, 'img1.jpg', [car('car-a', 100)]);

      await el.session!.undo();
      await el.updateComplete;

      expect(highlightOf(el)).to.be.null;
    });

    it('lights a layout object without changing the image on screen', async () => {
      addSecondImage();
      calibrate();
      const el = await mountWithTool('sensor');
      await clickAt(el, { x: 50, y: 50 });
      const { id } = sensors()[0];
      await el.session!.undo();
      await selectImage(el, 1);

      await el.session!.redo();
      await el.updateComplete;

      expect(highlightOf(el)!.sensors).to.deep.equal([id]);
      expect(el.shadowRoot!.querySelector('rr-thumbnail-bar')!.selectedIndex).to.equal(1);
    });

    it('resolves a reference point by pixel, and follows it through a renumbering', async () => {
      // The viewer addresses a point by index, and an edit landing while the
      // glow is up renumbers the list.
      archive.getManifest().layout.calibration.points = [
        { px: { x: 10, y: 20 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 30, y: 40 }, world: { x: 250, y: 0, z: 0 } },
      ];
      const el = await mount();
      await el.session!.editReferencePoint(1, { x: 30, y: 40 }, { x: 0, y: 250, z: 0 });

      await el.session!.undo();
      await el.updateComplete;
      expect(highlightOf(el)!.calibration).to.deep.equal([1]);

      const layout = archive.getManifest().layout;
      layout.calibration = { points: [layout.calibration.points[1]] };
      el.requestUpdate();
      await el.updateComplete;
      expect(highlightOf(el)!.calibration).to.deep.equal([0]);
    });

    it('takes the glow away again', async () => {
      const el = await mount();
      await place(el, 'img1.jpg', [car('car-a', 100)]);
      await el.session!.undo();
      vi.useFakeTimers();
      try {
        await el.session!.redo();
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
      const el = await mount();
      await place(el, 'img1.jpg', [car('car-a', 100)]);
      await el.session!.undo();
      await el.session!.redo();
      await el.updateComplete;

      await selectImage(el, 1);

      expect(highlightOf(el)).to.be.null;
    });

    describe('under zoom', () => {
      /** A frame big enough to have corners worth zooming into. */
      function widen() {
        archive.getManifest().camera.resolution = { width: 1000, height: 1000 };
      }

      const zoomOf = (el: RREditorView) => el.shadowRoot!.querySelector('rr-viewer')!.zoom;

      /** Zooms to a rect by drawing it, which is the only way the editor zooms. */
      async function zoomTo(el: RREditorView, rect: Rect) {
        await drag(el, [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
        ]);
      }

      /** One car placed, undone and redone, with the view zoomed to `rect` before the redo. */
      async function redoUnder(labels: CarLabel[], rect: Rect) {
        widen();
        const el = await mount();
        await place(el, 'img1.jpg', labels);
        await el.session!.undo();
        await zoomTo(el, rect);
        await el.session!.redo();
        await el.updateComplete;
        return el;
      }

      it('pans to what a redo changed, keeping the zoom level', async () => {
        const el = await redoUnder([car('car-a', 100, 40)], { x: 700, y: 700, width: 200, height: 200 });
        // Centred on the car, at the same 200x200, clamped to the frame.
        expect(zoomOf(el)).to.deep.equal({ x: 20, y: 0, width: 200, height: 200 });
      });

      it('leaves the zoom alone when what changed is already on screen', async () => {
        const el = await redoUnder([car('car-a', 720, 40)], { x: 700, y: 50, width: 200, height: 200 });
        expect(zoomOf(el)).to.deep.equal({ x: 700, y: 50, width: 200, height: 200 });
      });

      it('gives the zoom up when what changed does not fit at this level', async () => {
        const el = await redoUnder([car('car-a', 50, 900)], { x: 700, y: 700, width: 200, height: 200 });
        expect(zoomOf(el)).to.be.null;
      });

      it('moves the view no more than it lights anything, for an undone add', async () => {
        widen();
        const el = await mount();
        await place(el, 'img1.jpg', [car('car-a', 100, 40)]);
        await zoomTo(el, { x: 700, y: 700, width: 200, height: 200 });

        await el.session!.undo();
        await el.updateComplete;

        expect(zoomOf(el)).to.deep.equal({ x: 700, y: 700, width: 200, height: 200 });
      });
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
      const el = await mount();
      const history = el.session!.history;

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
      const el = await mount();
      const history = el.session!.history;

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
      const el = await mount();
      const history = el.session!.history;
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
      const el = await mount();
      const history = el.session!.history;

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
      el.session = new EditSession(fresh);
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
      el.session!.selectTool('car');

      await clickAt(el, { x: 100, y: 100 });
      await zoomTo(el, { x: 50, y: 50, width: 300, height: 300 });
      await clickAt(el, { x: 300, y: 100 });

      const labels = archive.getManifest().images[0].labels;
      expect(labels).to.have.length(1);
      expect(labels[0].p0).to.deep.equal({ x: 100, y: 100 });
      expect(labels[0].p1).to.deep.equal({ x: 300, y: 100 });
      expect(zoomOf(el)).to.deep.equal({ x: 50, y: 50, width: 300, height: 300 });
    });
  });
});
