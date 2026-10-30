import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureFromCamera, getCameraStream, DEFAULT_CAMERA_CONSTRAINTS } from '../src/capture.js';

/**
 * The camera a test opens.
 *
 * jsdom has no camera, no video decoder and no 2D context, so the whole device
 * is a fake: `delivers` is the size the track reports from `getSettings()`,
 * `largest` is what `getCapabilities()` claims, and a raise moves `delivers` to
 * the mode the fake camera has for what was asked. Nothing here decodes or
 * paints a pixel, so these tests say what the capture asked the track for and
 * what size it encoded, and never what the image contains.
 */
interface FakeCamera {
  /** The size the track delivers now. A raise it accepts moves it. */
  delivers: FakeSize;
  /** What `getCapabilities()` reports, or undefined for a track without it. */
  largest?: FakeSize;
  /** Rejects an `exact` raise: the pair of maxima is not a mode the track has. */
  refusesExact?: boolean;
  /** Rejects an `ideal` raise too, leaving the stream as opened. */
  refusesIdeal?: boolean;
  /** What an accepted `ideal` raise actually delivers, when not the size asked for. */
  idealDelivers?: FakeSize;
  /**
   * How many size reads the element answers from before the raise, standing in
   * for an element whose metadata has not caught up with the track yet.
   */
  staleReads?: number;
  /** Whether the element never reports metadata, so nothing ever plays. */
  neverLoads?: boolean;
}

interface FakeSize {
  width: number;
  height: number;
}

/** What one capture did, in the order it did it. */
interface Recording {
  /** `applyConstraints`, `attach` (the stream reaching the element), `encode`. */
  order: string[];
  applied: MediaTrackConstraints[];
  /** The canvas size and type each `toBlob` was called at. */
  encoded: { width: number; height: number; type?: string }[];
  stopped: number;
}

const JPEG_BYTES = new Uint8Array([1, 2, 3]);

const realCreateElement = document.createElement.bind(document);

/** The number an `exact` or `ideal` constraint carries, whichever it is. */
function asked(range: ConstrainULong | undefined): { value: number; exact: boolean } {
  const bounds = range as { exact?: number; ideal?: number };
  return bounds.exact !== undefined
    ? { value: bounds.exact, exact: true }
    : { value: bounds.ideal!, exact: false };
}

/**
 * Installs the fake camera and the fake `<video>`/`<canvas>` the capture
 * builds, and returns what the capture did to them.
 */
function installCamera(camera: FakeCamera): Recording {
  const rec: Recording = { order: [], applied: [], encoded: [], stopped: 0 };
  const opened = { ...camera.delivers };
  let staleReads = camera.staleReads ?? 0;

  const track = {
    stop: () => {
      rec.stopped += 1;
    },
    getSettings: () => ({ ...camera.delivers }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      rec.order.push('applyConstraints');
      rec.applied.push(constraints);
      const width = asked(constraints.width);
      const height = asked(constraints.height);
      if (width.exact && camera.refusesExact) throw new Error('OverconstrainedError');
      if (!width.exact && camera.refusesIdeal) throw new Error('OverconstrainedError');
      camera.delivers = width.exact
        ? { width: width.value, height: height.value }
        : (camera.idealDelivers ?? { width: width.value, height: height.value });
    },
    // Absent when the camera reports no capabilities: a browser that does not
    // implement `getCapabilities` has no such property, which is the condition
    // the capture tests for.
    ...(camera.largest
      ? {
          getCapabilities: () => ({
            width: { max: camera.largest!.width },
            height: { max: camera.largest!.height },
          }),
        }
      : {}),
  };

  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = { getUserMedia };

  /**
   * The element's intrinsic size: the track's, once its metadata has caught up,
   * and `opened` for the first `staleReads` reads before that.
   *
   * `videoHeight` answers from whatever the last `videoWidth` read reported, so
   * one read of the pair is one consistent size. Every caller reads width
   * first.
   */
  let lastReported = opened;
  const reportWidth = () => {
    lastReported = staleReads > 0 ? opened : camera.delivers;
    if (staleReads > 0) staleReads -= 1;
    return lastReported.width;
  };

  const video = {
    muted: false,
    onerror: null as (() => void) | null,
    onloadedmetadata: null as (() => void) | null,
    play: async () => {},
    get videoWidth() {
      return reportWidth();
    },
    get videoHeight() {
      return lastReported.height;
    },
    set srcObject(value: unknown) {
      if (value !== stream) throw new Error('attached something other than the stream');
      rec.order.push('attach');
      // The browser reports metadata once the stream is attached; the capture
      // installs its handler right after the assignment, so this cannot fire
      // synchronously.
      if (!camera.neverLoads) setTimeout(() => this.onloadedmetadata?.(), 0);
    },
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === '2d' ? { drawImage: () => {} } : null),
    toBlob: (callback: (blob: Blob) => void, type?: string) => {
      rec.order.push('encode');
      rec.encoded.push({ width: canvas.width, height: canvas.height, type });
      // Not a jsdom `Blob`: this jsdom's Blob has no `arrayBuffer()`, which is
      // the one thing the capture does with what it gets back.
      callback({ type, arrayBuffer: async () => new Uint8Array(JPEG_BYTES).buffer } as Blob);
    },
  };

  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') return video;
    if (tag === 'canvas') return canvas;
    return realCreateElement(tag);
  }) as typeof document.createElement);

  return rec;
}

describe('capture.ts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('getCameraStream', () => {
    it('asks the live view for 1920×1080 off the rear camera', async () => {
      installCamera({ delivers: { width: 1920, height: 1080 } });

      await getCameraStream();

      // The live view's resolution is #277's, decided after the classifier
      // measures 4K in Safari; the capture's raise must not move it (#273).
      expect(DEFAULT_CAMERA_CONSTRAINTS).toEqual({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'environment',
        },
        audio: false,
      });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(DEFAULT_CAMERA_CONSTRAINTS);
    });
  });

  describe('captureFromCamera', () => {
    it('raises the track to the largest size it reports and grabs the frame there', async () => {
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 3840, height: 2160 },
      });

      const bytes = await captureFromCamera();

      expect(rec.applied).toEqual([{ width: { exact: 3840 }, height: { exact: 2160 } }]);
      expect(rec.encoded).toEqual([{ width: 3840, height: 2160, type: 'image/jpeg' }]);
      expect(bytes).toEqual(JPEG_BYTES);
      expect(rec.stopped).toBe(1);
    });

    it('raises the track before the stream reaches the element, so the frame is from after the switch', async () => {
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 3840, height: 2160 },
      });

      await captureFromCamera();

      expect(rec.order).toEqual(['applyConstraints', 'attach', 'encode']);
    });

    it('waits for the element to report the raised size before it draws', async () => {
      // Two reads answered from before the raise: drawing on either would have
      // stored a 1080p frame and declared the archive 1080p with it.
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 3840, height: 2160 },
        staleReads: 2,
      });

      await captureFromCamera();

      expect(rec.encoded).toEqual([{ width: 3840, height: 2160, type: 'image/jpeg' }]);
    });

    it('asks for the nearest mode where the exact pair of maxima is refused', async () => {
      // A camera with a 16:9 video mode and a 4:3 one: the maxima come from
      // different modes, so nothing can deliver the pair, and the ideal lands
      // on the largest mode there is.
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 3840, height: 2448 },
        refusesExact: true,
        idealDelivers: { width: 3840, height: 2160 },
      });

      const bytes = await captureFromCamera();

      expect(rec.applied).toEqual([
        { width: { exact: 3840 }, height: { exact: 2448 } },
        { width: { ideal: 3840 }, height: { ideal: 2448 } },
      ]);
      // The size the track says it settled on, not the size asked for.
      expect(rec.encoded).toEqual([{ width: 3840, height: 2160, type: 'image/jpeg' }]);
      expect(bytes).toEqual(JPEG_BYTES);
    });

    it('captures at the stream’s size where the track reports no capabilities', async () => {
      const rec = installCamera({ delivers: { width: 1280, height: 720 } });

      const bytes = await captureFromCamera();

      expect(rec.applied).toEqual([]);
      expect(rec.encoded).toEqual([{ width: 1280, height: 720, type: 'image/jpeg' }]);
      expect(bytes).toEqual(JPEG_BYTES);
      expect(rec.stopped).toBe(1);
    });

    it('captures at the stream’s size where every raise is refused', async () => {
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 4032, height: 3024 },
        refusesExact: true,
        refusesIdeal: true,
      });

      const bytes = await captureFromCamera();

      expect(rec.encoded).toEqual([{ width: 1920, height: 1080, type: 'image/jpeg' }]);
      expect(bytes).toEqual(JPEG_BYTES);
      expect(rec.stopped).toBe(1);
    });

    it('does not raise into a portrait frame, which the archive would refuse', async () => {
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 3024, height: 4032 },
      });

      await captureFromCamera();

      expect(rec.applied).toEqual([]);
      expect(rec.encoded).toEqual([{ width: 1920, height: 1080, type: 'image/jpeg' }]);
    });

    it('does not reconfigure a track already at the largest size it reports', async () => {
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 1920, height: 1080 },
      });

      await captureFromCamera();

      expect(rec.applied).toEqual([]);
      expect(rec.encoded).toEqual([{ width: 1920, height: 1080, type: 'image/jpeg' }]);
    });

    it('gives up waiting after 2 s and grabs the frame the element does report', async () => {
      // An element that never catches up: a photograph at the size it reports
      // beats no photograph, so the wait is bounded and the capture goes on.
      const rec = installCamera({
        delivers: { width: 1920, height: 1080 },
        largest: { width: 3840, height: 2160 },
        staleReads: Number.MAX_SAFE_INTEGER,
      });
      vi.useFakeTimers();

      const capturing = captureFromCamera();
      await vi.advanceTimersByTimeAsync(2500);

      expect(await capturing).toEqual(JPEG_BYTES);
      expect(rec.encoded).toEqual([{ width: 1920, height: 1080, type: 'image/jpeg' }]);
    });

    it('fails after 5 s where the camera never reports metadata, and stops the tracks', async () => {
      const rec = installCamera({ delivers: { width: 1920, height: 1080 }, neverLoads: true });
      vi.useFakeTimers();

      const capturing = captureFromCamera();
      const settled = capturing.catch((err: Error) => err.message);
      await vi.advanceTimersByTimeAsync(5500);

      expect(await settled).toBe('Camera capture timed out');
      expect(rec.encoded).toEqual([]);
      expect(rec.stopped).toBe(1);
    });

    it('opens with the live view’s ideal, so a refused raise still falls back to 1080p', async () => {
      installCamera({ delivers: { width: 1920, height: 1080 } });

      await captureFromCamera();

      // Not an unhinted open: without a hint a refused raise would fall back to
      // whatever the browser defaults to, which is below today's capture.
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(DEFAULT_CAMERA_CONSTRAINTS);
    });
  });
});
