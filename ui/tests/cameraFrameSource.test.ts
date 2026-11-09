import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cameraFrameSource } from '../src/cameraFrameSource.js';

// The camera's half of the live loop, away from the view (#330). What this can
// prove in jsdom is the readiness rule and the lifetime: jsdom decodes no video,
// so a `<video>` here is a stand-in with the three fields the rule reads, which
// is exactly what `rr-live-view.test.ts` stands in for the same reason.

const getCameraStream = vi.fn();
vi.mock('../src/capture.js', () => ({ getCameraStream: () => getCameraStream() }));

/** A ready-looking `<video>`: what the source reads, and nothing it does not. */
const decoded = { readyState: 2, videoWidth: 1280, videoHeight: 720 };
/** The first frames of every session: a stream attached, no metadata yet. */
const undecoded = { readyState: 0, videoWidth: 0, videoHeight: 0 };

function fakeStream(settings: MediaTrackSettings = { width: 1280, height: 720 }) {
  const track = { stop: vi.fn(), getSettings: () => settings };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
  };
}

/** Let a few animation frames pass, which is what the source waits on. */
const frames = (n = 3) => new Promise(resolve => setTimeout(resolve, n * 20));

describe('cameraFrameSource', () => {
  let video: typeof decoded | null;
  let host: { getVideoElement: () => HTMLVideoElement | null };

  beforeEach(() => {
    video = decoded;
    host = { getVideoElement: () => video as unknown as HTMLVideoElement | null };
    getCameraStream.mockReset();
    getCameraStream.mockResolvedValue(fakeStream().stream);
  });

  it('hands over the viewer\'s video at the size it decoded', async () => {
    // The intrinsic size, not `camera.resolution`: a phone that ignored the
    // requested 1920x1080 hands back whatever it felt like, and the drift grab
    // wants the real pixels.
    const source = cameraFrameSource(() => host);
    await source.start();

    expect(await source.next()).toEqual({ source: video, width: 1280, height: 720 });
  });

  it('takes a turn with no frame while the video has no pixels to read', async () => {
    // `detect` throws on a source with no dimensions, and a video before its
    // metadata arrives — or after the camera stopped giving pictures (#343) —
    // is not a frame. It is still a *turn*: holding the loop here left the
    // rate, the boxes and every sensor state at whatever the last frame set
    // them to (#345).
    video = undecoded;
    const source = cameraFrameSource(() => host);
    await source.start();

    const quiet = await source.next();

    expect(quiet?.fresh).toBe(false);
    // Nothing may read pixels from it, so the size it reports is the
    // element's own — zero until something decodes.
    expect(quiet?.width).toBe(0);

    video = decoded;
    expect(await source.next()).toEqual({ source: decoded, width: 1280, height: 720 });
  });

  it('takes a turn with no frame before the viewer has mounted a video at all', async () => {
    // `@query('rr-viewer')` resolves after the first render, so the source is
    // given a getter rather than an element. With nothing to show, the turn
    // carries an empty image, which nothing reads.
    video = null;
    const source = cameraFrameSource(() => host);
    await source.start();

    const quiet = await source.next();

    expect(quiet).not.toBeNull();
    expect(quiet!.fresh).toBe(false);
    expect(quiet!.width).toBe(0);
    expect(quiet!.height).toBe(0);
  });

  it('takes one turn per animation frame while there is nothing to read', async () => {
    // The pacing is the same whether or not a picture arrives: the loop runs as
    // fast as the display and no faster, so a camera that has stopped does not
    // spin it.
    video = undecoded;
    const source = cameraFrameSource(() => host);
    await source.start();

    let turns = 0;
    void (async () => {
      while ((await source.next()) !== null) turns++;
    })();
    await frames(3);
    source.stop();

    expect(turns).toBeGreaterThan(0);
    expect(turns).toBeLessThan(20);
  });

  it('gives a fresh turn again once the video comes back', async () => {
    // A video being seeked, or a camera that started giving pictures again.
    video = undecoded;
    const source = cameraFrameSource(() => host);
    await source.start();

    expect((await source.next())?.fresh).toBe(false);
    video = decoded;
    const back = await source.next();

    expect(back).toEqual({ source: decoded, width: 1280, height: 720 });
    expect(back?.fresh).toBeUndefined();
  });

  it('gives null once stopped, which is what ends the loop', async () => {
    const source = cameraFrameSource(() => host);
    await source.start();
    source.stop();

    expect(await source.next()).toBeNull();
  });

  it('gives null to a turn already being waited for when it stops', async () => {
    // `null` after `stop()` stays the one way out of the loop — a turn with no
    // frame is not it.
    video = undecoded;
    const source = cameraFrameSource(() => host);
    await source.start();

    const next = source.next();
    source.stop();

    expect(await next).toBeNull();
  });

  it('stops every camera track and drops the stream', async () => {
    const { track, stream } = fakeStream();
    getCameraStream.mockResolvedValue(stream);

    const source = cameraFrameSource(() => host);
    await source.start();
    expect(source.stream).toBe(stream);

    source.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(source.stream).toBeNull();
  });

  it('releases a camera granted after it was stopped', async () => {
    // Leaving the view while the permission prompt is still up: the grant
    // lands on a source nobody is reading, and an unstopped track holds the
    // camera until the page is reloaded.
    const { track, stream } = fakeStream();
    let grant!: (stream: MediaStream) => void;
    getCameraStream.mockImplementation(() => new Promise(resolve => (grant = resolve)));

    const source = cameraFrameSource(() => host);
    const starting = source.start();
    source.stop();
    grant(stream);
    await starting;

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(source.stream).toBeNull();
  });

  it('reports the track settings the drift rows record', async () => {
    getCameraStream.mockResolvedValue(fakeStream({ width: 640, height: 480 }).stream);

    const source = cameraFrameSource(() => host);
    await source.start();

    expect(source.settings).toEqual({ width: 640, height: 480 });
  });

  it('starts anyway when the camera is refused, with no stream and no settings', async () => {
    // A refused camera is not an error to stop the view for: the notices, the
    // drift readout and the sensor states are still the view's job.
    getCameraStream.mockRejectedValue(new Error('NotAllowedError'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const source = cameraFrameSource(() => host);
    await source.start();

    expect(source.stream).toBeNull();
    expect(source.settings).toEqual({});
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
