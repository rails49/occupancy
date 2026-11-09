import { describe, it, expect, vi, afterEach } from 'vitest';
import { captureFromCamera, getCameraStream, DEFAULT_CAMERA_CONSTRAINTS } from '../src/capture.js';
import type { Size } from '../src/geometry.js';

// jsdom has no camera, decodes no video and paints no canvas, so `getUserMedia`,
// the `<video>` the frame is read from and the `<canvas>` it is drawn into are
// all fakes here — the arrangement `cameraFrameSource.test.ts` uses for the same
// reason. What this proves is the raise (#273): which size the track is asked
// for, that it is asked before the stream reaches the element, and the size the
// frame is grabbed at. That a 4K frame then actually arrives is the browser's,
// and is checked by hand.

/** The bytes the fake canvas hands back; the capture only passes them on. */
const FRAME_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

interface FakeCamera {
  /** Every constraint set the capture asked the track for, in order. */
  requested: MediaTrackConstraints[];
  /** The fake canvas — its `width`/`height` are the size the frame was grabbed at. */
  canvas: { width: number; height: number };
  /** What the capture did, in order. */
  steps: string[];
  /** What `getUserMedia` was called with. */
  openedWith: () => MediaStreamConstraints | undefined;
  /** Whether the video track was stopped. */
  stopped: () => boolean;
}

/** The `exact` number a raise asks for in one dimension. */
function exactOf(constraint: MediaTrackConstraints['width']): number {
  return (constraint as { exact: number }).exact;
}

function installFakeCamera(opts: {
  /** The size the stream opens at. */
  opened: Size;
  /** The maxima `getCapabilities()` reports; omitted for a track without the method. */
  capable?: Size;
  /** The size the track settles on after a raise, where that is not what was asked for. */
  delivers?: Size;
  /** An `applyConstraints` that refuses whatever it is asked for. */
  refuses?: boolean;
}): FakeCamera {
  const delivered = { ...opts.opened };
  const steps: string[] = [];
  const requested: MediaTrackConstraints[] = [];
  let openedWith: MediaStreamConstraints | undefined;
  let stopped = false;

  const track = {
    stop: () => {
      stopped = true;
    },
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      steps.push('applyConstraints');
      requested.push(constraints);
      if (opts.refuses) throw new Error('OverconstrainedError');
      const settled = opts.delivers ?? {
        width: exactOf(constraints.width),
        height: exactOf(constraints.height),
      };
      delivered.width = settled.width;
      delivered.height = settled.height;
    },
    ...(opts.capable
      ? {
          getCapabilities: (): MediaTrackCapabilities => ({
            width: { max: opts.capable!.width },
            height: { max: opts.capable!.height },
          }),
        }
      : {}),
  };

  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        steps.push('getUserMedia');
        openedWith = constraints;
        return stream;
      },
    },
  });

  const video = {
    muted: false,
    videoWidth: 0,
    videoHeight: 0,
    onerror: null as ((e: unknown) => void) | null,
    set srcObject(_value: MediaProvider | null) {
      steps.push('attach');
    },
    set onloadedmetadata(handler: () => void) {
      // jsdom decodes nothing, so metadata is announced on the next turn, at
      // whatever size the track is delivering by then.
      queueMicrotask(() => {
        video.videoWidth = delivered.width;
        video.videoHeight = delivered.height;
        handler();
      });
    },
    play: async () => {
      steps.push('play');
    },
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {
        steps.push('drawImage');
      },
    }),
    toBlob: (callback: (blob: Blob | null) => void) => {
      callback({ arrayBuffer: async () => FRAME_BYTES.buffer } as unknown as Blob);
    },
  };

  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') return video;
    if (tag === 'canvas') return canvas;
    return create(tag);
  }) as typeof document.createElement);

  return { requested, canvas, steps, openedWith: () => openedWith, stopped: () => stopped };
}

describe('capture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('raises the track to the largest size it reports, and grabs the frame at that size', async () => {
    const camera = installFakeCamera({
      opened: { width: 1920, height: 1080 },
      capable: { width: 3840, height: 2160 },
    });

    const bytes = await captureFromCamera();

    expect(camera.requested).toEqual([{ width: { exact: 3840 }, height: { exact: 2160 } }]);
    expect({ width: camera.canvas.width, height: camera.canvas.height }).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(bytes).toEqual(FRAME_BYTES);
    expect(camera.stopped()).toBe(true);
  });

  it('captures at the stream\'s size where the track has no getCapabilities', async () => {
    const camera = installFakeCamera({ opened: { width: 1920, height: 1080 } });

    const bytes = await captureFromCamera();

    expect(camera.requested).toEqual([]);
    expect({ width: camera.canvas.width, height: camera.canvas.height }).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(bytes).toEqual(FRAME_BYTES);
  });

  it('captures at the stream\'s size where the raise is refused, and asks only once', async () => {
    // The capability maxima need not be jointly achievable — 3840 wide and 2448
    // tall are two different modes of one camera — so the one `exact` request
    // can fail. The stream as opened is a usable capture; a second, looser
    // request would land the track on a size nobody asked for.
    const camera = installFakeCamera({
      opened: { width: 1920, height: 1080 },
      capable: { width: 3840, height: 2448 },
      refuses: true,
    });

    const bytes = await captureFromCamera();

    expect(camera.requested).toHaveLength(1);
    expect({ width: camera.canvas.width, height: camera.canvas.height }).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(bytes).toEqual(FRAME_BYTES);
  });

  it('raises the track before the stream reaches the video element', async () => {
    // Why the stored frame cannot be one from before the switch: the element is
    // attached only once the track reports the raised size, so the first frame
    // it ever decodes is a frame the track took after the raise.
    const camera = installFakeCamera({
      opened: { width: 1920, height: 1080 },
      capable: { width: 3840, height: 2160 },
    });

    await captureFromCamera();

    expect(camera.steps).toEqual(['getUserMedia', 'applyConstraints', 'attach', 'play', 'drawImage']);
  });

  it('grabs the frame at the size the camera settled on, not the size it was asked for', async () => {
    // A camera that accepts the request and settles elsewhere: the archive's
    // `camera.resolution` has to be the pixels that actually arrived.
    const camera = installFakeCamera({
      opened: { width: 1920, height: 1080 },
      capable: { width: 4032, height: 3024 },
      delivers: { width: 3840, height: 2160 },
    });

    await captureFromCamera();

    expect({ width: camera.canvas.width, height: camera.canvas.height }).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('still opens the live view\'s stream at 1920×1080, rear-facing', async () => {
    // The live view's resolution is deliberately not the capture's (#273).
    expect(DEFAULT_CAMERA_CONSTRAINTS).toEqual({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'environment' },
      audio: false,
    });

    const camera = installFakeCamera({ opened: { width: 1920, height: 1080 } });
    await getCameraStream();

    expect(camera.openedWith()).toEqual(DEFAULT_CAMERA_CONSTRAINTS);
    expect(camera.requested).toEqual([]);
  });
});
