import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import { R49Archive } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import '../src/rr-live-view.js';
import { RRLiveView } from '../src/rr-live-view.js';
import type { FrameSource, ResultContext, ResultSource, SourceFrame } from '../src/liveSources.js';

// The live view playing a **video file** (#286), through the real
// `videoFileFrameSource`: the camera is swapped out for a file somebody picked,
// and the loop, the drift check and the recorder go on as they were.
//
// A third file beside `rr-live-view.test.ts` (the camera and the shipped
// detector) and `rr-live-view.sources.test.ts` (fake sources), for the reason
// the second one exists: those two are the evidence that the paths they cover
// still behave as they did, and cases added to them stop saying that.
//
// jsdom plays nothing, so the `<video>` the viewer mounts is stood in for with
// the fields the source reads — the same stand-in those two files use — and
// that a frame of a real `.mp4` reaches the detector is measured by hand in
// Chromium.

const detections: Detection[] = [
  { centre: { x: 50, y: 50 }, length: 60, width: 42, angle: 0, class: 'stock', confidence: 0.9 },
];

const loadDetector = vi.fn(async (_source: string) => ({
  detect: vi.fn(async () => detections),
  dispose: vi.fn(async () => {}),
}));

vi.mock('@rails49/detector/browser', () => ({
  loadDetector: (source: string) => loadDetector(source),
}));

const check = vi.fn(async () => ({ displacementPx: 0, refIndex: 0 }));
const openDriftCheck = vi.fn(async () => ({ check: { check }, refName: 'test.jpg' }));

vi.mock('../src/driftSession.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/driftSession.js')>();
  return {
    MAX_DRIFT_TRACK_FRACTION: actual.MAX_DRIFT_TRACK_FRACTION,
    maxDriftPx: actual.maxDriftPx,
    driftVerdict: actual.driftVerdict,
    openDriftCheck: (...args: unknown[]) => openDriftCheck(...(args as [])),
    grabPlane: () => ({ width: 4, height: 4, data: new Float32Array(16) }),
  };
});

/** The fields of the viewer's `<video>` the video-file source reads and writes. */
interface StandInVideo {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  duration: number;
  paused: boolean;
  error: MediaError | null;
  play: () => Promise<void>;
  pause: () => void;
}

function standIn(fields: Partial<StandInVideo> = {}): StandInVideo {
  return {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 3,
    duration: 90,
    paused: false,
    error: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    ...fields,
  };
}

/**
 * Stand a ready-looking `<video>` into the viewer, as the camera tests do.
 *
 * jsdom decodes nothing, so the element the viewer mounts never leaves
 * `readyState` 0 and no frame would ever be handed over. Nothing downstream
 * reads a pixel here: `detect` and `grabPlane` are both mocked.
 */
function standInVideo(el: RRLiveView, video: StandInVideo | null) {
  const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
  viewer.getVideoElement = () => video as unknown as HTMLVideoElement | null;
}

/** Pick a file, the way the file input reports one. */
async function pickVideo(el: RRLiveView, file: File) {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await el.updateComplete;
}

async function waitFor(el: RRLiveView, done: () => boolean, budgetMs = 1000) {
  for (let waited = 0; waited < budgetMs && !done(); waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10));
    await el.updateComplete;
  }
  await el.updateComplete;
}

const VIDEO = new File([new Uint8Array([1])], 'IMG_4312.mov', { type: 'video/quicktime' });

/** What a browser sets on the element when it cannot decode the file at all. */
const UNSUPPORTED = { code: 4, message: '' } as MediaError;

describe('rr-live-view playing a video file', () => {
  let archive: R49Archive;
  let track: { stop: ReturnType<typeof vi.fn>; getSettings: () => MediaTrackSettings };
  let createObjectURL: MockInstance<typeof URL.createObjectURL>;
  let revokeObjectURL: MockInstance<typeof URL.revokeObjectURL>;

  beforeEach(() => {
    loadDetector.mockClear();
    check.mockClear();
    check.mockImplementation(async () => ({ displacementPx: 0, refIndex: 0 }));
    openDriftCheck.mockClear();
    openDriftCheck.mockImplementation(async () => ({ check: { check }, refName: 'test.jpg' }));

    archive = new R49Archive();
    archive.setManifest({
      version: 4,
      layout: {
        name: 'Video Test',
        scale: 'N',
        calibration: {
          points: [
            { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
            { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
          ],
        },
        sensors: [{ id: 'S1abcdefghi', x: 50, y: 50 }],
      },
      camera: { resolution: { width: 100, height: 100 } },
      images: [{ filename: 'test.jpg', labeled_complete: false, labels: [] }],
    });

    track = { stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720 }) };
    (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] }),
    };

    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:the-video');
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restored one spy at a time: `vi.restoreAllMocks()` also resets the
    // `vi.fn()`s `setup.ts` installs for the globals jsdom lacks, which leaves
    // `new ResizeObserver()` answering `undefined` for every test after this
    // one.
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('offers the control on the camera path', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );

    expect(el.shadowRoot!.querySelector('.video-open')).to.not.be.null;
    expect(el.shadowRoot!.querySelector('input[type="file"]')).to.not.be.null;
  });

  it('opens the picker from the bar, not from a bare file input', async () => {
    // The input is hidden so the control reads like Record drift beside it.
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const input = el.shadowRoot!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const opened = vi.spyOn(input, 'click');

    el.shadowRoot!.querySelector<HTMLButtonElement>('.video-open')!.click();

    expect(input.hidden).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('offers it with nothing open, where the camera shows and nothing reads it', async () => {
    const el = await fixture<RRLiveView>(html`<rr-live-view></rr-live-view>`);

    expect(el.shadowRoot!.querySelector('.video-open')).to.not.be.null;
  });

  it('does not offer it in service mode', async () => {
    // The frames there are the service's, and the picture is its judgement
    // being relayed (#331) — not something this page chooses a source for.
    const frames: FrameSource = {
      stream: null,
      settings: {},
      async start() {},
      stop() {},
      async next(): Promise<SourceFrame | null> {
        await new Promise(resolve => setTimeout(resolve, 0));
        return { source: {} as CanvasImageSource, width: 10, height: 10 };
      },
    };
    const results: ResultSource = {
      async open() {
        return null;
      },
      close() {},
      async resultFor(_frame: SourceFrame, _context: ResultContext) {
        return { sensorStates: new Map() };
      },
    };

    const el = await fixture<RRLiveView>(
      html`<rr-live-view .sources=${{ frames, results, service: true }}></rr-live-view>`,
    );

    expect(el.shadowRoot!.querySelector('.video-open')).to.be.null;
  });

  it('plays the file, releases the camera, and runs the loop on its frames', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    await waitFor(el, () => loadDetector.mock.calls.length > 0);

    standInVideo(el, standIn());
    await pickVideo(el, VIDEO);
    await waitFor(el, () => viewer.videoSrc !== null);

    // The viewer plays the file and shows no stream: one `<video>`, which is
    // also the element the source reads its pixels back out of.
    expect(viewer.videoSrc).toBe('blob:the-video');
    expect(viewer.stream).toBeNull();
    // The camera is let go. An unstopped track holds it until the page reloads,
    // and nothing is reading it any more.
    expect(track.stop).toHaveBeenCalledTimes(1);
    // The same loop: the detector answers the file's frames, and the drift
    // check samples them.
    await waitFor(el, () => check.mock.calls.length > 0);
    expect(viewer.sensorStates!.get('S1abcdefghi')).to.not.be.undefined;
    expect(check).toHaveBeenCalled();
    // One model for the session: the swap is a different source, not a
    // different session.
    expect(loadDetector).toHaveBeenCalledTimes(1);
  });

  it('names the file it is playing', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    standInVideo(el, standIn());
    await pickVideo(el, VIDEO);
    await waitFor(el, () => el.shadowRoot!.querySelector('.video-name') !== null);

    expect(el.shadowRoot!.querySelector('.video-name')!.textContent).toContain('IMG_4312.mov');
  });

  it('refuses a file the browser cannot play, and says why', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    standInVideo(el, standIn({ error: UNSUPPORTED, readyState: 0, videoWidth: 0 }));
    await pickVideo(el, VIDEO);
    await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

    const notice = el.shadowRoot!.querySelector('.notice.refusing')!;
    expect(notice.textContent).toContain('IMG_4312.mov');
    expect(notice.textContent).toContain('HEVC');
    // No transport over a file that will never play.
    expect(el.shadowRoot!.querySelector('.video-play')).to.be.null;
  });

  it('refuses it with no archive open, where no loop is running', async () => {
    // Nothing is being asked about the frames, so the loop never starts — and
    // the person who just chose the file is still owed the refusal rather than
    // a black rectangle.
    const el = await fixture<RRLiveView>(html`<rr-live-view></rr-live-view>`);
    standInVideo(el, standIn({ error: UNSUPPORTED, readyState: 0, videoWidth: 0 }));
    await pickVideo(el, VIDEO);
    await waitFor(el, () => el.shadowRoot!.querySelector('.notice.refusing') !== null);

    expect(el.shadowRoot!.querySelector('.notice.refusing')!.textContent).toContain(
      'IMG_4312.mov',
    );
  });

  it('plays and pauses the file', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const video = standIn();
    standInVideo(el, video);
    await pickVideo(el, VIDEO);
    await waitFor(el, () => el.shadowRoot!.querySelector('.video-play') !== null);

    const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.video-play')!;
    expect(button.textContent!.trim()).toBe('Pause');

    button.click();
    video.paused = true;
    await el.updateComplete;
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(el.shadowRoot!.querySelector('.video-play')!.textContent!.trim()).toBe('Play');

    el.shadowRoot!.querySelector<HTMLButtonElement>('.video-play')!.click();
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('seeks to where the slider is dragged, and reads the position out', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const video = standIn({ currentTime: 12 });
    standInVideo(el, video);
    await pickVideo(el, VIDEO);
    await waitFor(el, () => el.shadowRoot!.querySelector('.video-seek') !== null);

    const seek = el.shadowRoot!.querySelector<HTMLInputElement>('.video-seek')!;
    expect(seek.max).toBe('90');
    expect(Number(seek.value)).toBe(12);
    expect(el.shadowRoot!.querySelector('.video-time')!.textContent).toContain('0:12 / 1:30');

    seek.value = '45';
    seek.dispatchEvent(new Event('input'));
    await el.updateComplete;

    expect(video.currentTime).toBe(45);
    expect(el.shadowRoot!.querySelector('.video-time')!.textContent).toContain('0:45 / 1:30');
  });

  it('goes back to the camera, releasing the file', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    standInVideo(el, standIn());
    await pickVideo(el, VIDEO);
    await waitFor(el, () => viewer.videoSrc !== null);

    el.shadowRoot!.querySelector<HTMLButtonElement>('.video-camera')!.click();
    await waitFor(el, () => viewer.stream !== null);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:the-video');
    expect(viewer.videoSrc).toBeNull();
    expect(viewer.stream).to.not.be.null;
    expect(el.shadowRoot!.querySelector('.video-play')).to.be.null;
  });

  it('releases the file when the view is left', async () => {
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const viewer = el.shadowRoot!.querySelector('rr-viewer')!;
    standInVideo(el, standIn());
    await pickVideo(el, VIDEO);
    await waitFor(el, () => viewer.videoSrc !== null);

    el.remove();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:the-video');
  });

  it('measures the file against the archive rather than keeping the camera reading', async () => {
    // A drift sample taken off the camera is about other pixels entirely. The
    // readout goes back to unmeasured and the next sample is the file's.
    check.mockImplementation(async () => ({ displacementPx: 60, refIndex: 0 }));
    const el = await fixture<RRLiveView>(
      html`<rr-live-view .archive=${archive}></rr-live-view>`,
    );
    const stats = el.shadowRoot!.querySelector('rr-stats-bar')!;
    standInVideo(el, standIn());
    await waitFor(el, () => stats.alignment !== null);
    expect(stats.alignment).toBe(60);

    check.mockImplementation(async () => ({ displacementPx: 1, refIndex: 0 }));
    await pickVideo(el, VIDEO);
    await el.updateComplete;
    expect(stats.alignment).toBeNull();

    await waitFor(el, () => stats.alignment !== null);
    expect(stats.alignment).toBe(1);
  });
});
