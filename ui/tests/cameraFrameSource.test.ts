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

  it('waits for the video to decode rather than reporting a frame with no pixels', async () => {
    // `detect` throws on a source with no dimensions, and a video before its
    // metadata arrives is the normal first few frames of a session.
    video = undecoded;
    const source = cameraFrameSource(() => host);
    await source.start();

    let arrived = false;
    const next = source.next().then(frame => ((arrived = true), frame));
    await frames();
    expect(arrived).toBe(false);

    video = decoded;
    expect(await next).toEqual({ source: decoded, width: 1280, height: 720 });
  });

  it('waits for the viewer to mount its video at all', async () => {
    // `@query('rr-viewer')` resolves after the first render, so the source is
    // given a getter rather than an element.
    video = null;
    const source = cameraFrameSource(() => host);
    await source.start();

    let arrived = false;
    void source.next().then(() => (arrived = true));
    await frames();

    expect(arrived).toBe(false);
  });

  it('gives null once stopped, which is what ends the loop', async () => {
    const source = cameraFrameSource(() => host);
    await source.start();
    source.stop();

    expect(await source.next()).toBeNull();
  });

  it('gives null to a frame already being waited for when it stops', async () => {
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
