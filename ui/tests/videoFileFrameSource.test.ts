import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { videoFileFrameSource } from '../src/videoFileFrameSource.js';

// A video file's half of the live loop, away from the view (#286). What this
// can prove in jsdom is the same as `cameraFrameSource.test.ts` proves for the
// camera — the readiness rule, the lifetime, and what reaches the viewer — with
// a stand-in `<video>` carrying the fields the source reads. jsdom decodes no
// video and plays nothing, so that a frame of a real `.mp4` arrives is measured
// by hand in Chromium.

/** The fields of the viewer's `<video>` this source reads and writes. */
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
    currentTime: 0,
    duration: 90,
    paused: false,
    error: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    ...fields,
  };
}

/** What a browser sets when it cannot decode the file at all. */
const UNSUPPORTED = { code: 4, message: '' } as MediaError;

/** Let a few animation frames pass, which is what the source waits on. */
const frames = (n = 3) => new Promise(resolve => setTimeout(resolve, n * 20));

const FILE = new File([new Uint8Array([1, 2, 3])], 'IMG_4312.mov', { type: 'video/quicktime' });

describe('videoFileFrameSource', () => {
  let video: StandInVideo | null;
  let host: { getVideoElement: () => HTMLVideoElement | null };
  let created: unknown[];
  let createObjectURL: MockInstance<typeof URL.createObjectURL>;
  let revokeObjectURL: MockInstance<typeof URL.revokeObjectURL>;

  beforeEach(() => {
    video = standIn();
    host = { getVideoElement: () => video as unknown as HTMLVideoElement | null };
    created = [];
    // `setup.ts`'s global returns `undefined` for every call, which cannot tell
    // one handle from another — so both are stubbed per test file.
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(file => {
      created.push(file);
      return 'blob:the-video';
    });
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

  it('hands the viewer the file to play, and reads no stream', async () => {
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    expect(created).toEqual([FILE]);
    expect(source.videoSrc).toBe('blob:the-video');
    // Not a `MediaStream`, and no camera track behind it: the drift rows record
    // an empty pair rather than the last camera's settings.
    expect(source.stream).toBeNull();
    expect(source.settings).toEqual({});
  });

  it('names the file it is playing, before it is even started', async () => {
    // The transport shows it, and the source is what holds the `File` — so it
    // is read from here rather than kept beside every `_openFrames` call
    // (#359). Available at once: the name is known at the pick, and the bar
    // renders before the first frame.
    const source = videoFileFrameSource(() => host, FILE);

    expect(source.name).toBe('IMG_4312.mov');
  });

  it('hands over the element at the size the file decoded at', async () => {
    // The element's intrinsic size, as the camera path reads it: that is the
    // grid the pixels are in, whatever `camera.resolution` declares.
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    expect(await source.next()).toEqual({ source: video, width: 1920, height: 1080 });
  });

  it('waits for the file to decode rather than reporting a frame with no pixels', async () => {
    video = standIn({ readyState: 0, videoWidth: 0, videoHeight: 0 });
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    let arrived = false;
    const next = source.next().then(frame => ((arrived = true), frame));
    await frames();
    expect(arrived).toBe(false);

    video.readyState = 2;
    video.videoWidth = 1920;
    video.videoHeight = 1080;
    expect(await next).toEqual({ source: video, width: 1920, height: 1080 });
  });

  it('holds the loop while the file is paused on one frame', async () => {
    // One picture is one frame to run on. Handing the same one over every
    // animation frame would spend the whole frame budget re-detecting a still
    // and resample the drift check against it every 3 s for no new reading.
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();
    await source.next();

    video!.paused = true;
    let arrived = false;
    void source.next().then(() => (arrived = true));
    await frames();

    expect(arrived).toBe(false);
  });

  it('runs again on the frame a seek landed on', async () => {
    // A seek is new pixels, playing or paused — which is the one thing that
    // has to reach the loop while it is holding above.
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();
    await source.next();
    video!.paused = true;

    const next = source.next();
    video!.currentTime = 42;

    expect(await next).toEqual({ source: video, width: 1920, height: 1080 });
  });

  it('refuses a file the browser cannot play, naming it and the usual cause', async () => {
    // An iPhone records HEVC `.mov` by default, which is the file somebody
    // trying this for the first time will pick.
    video = standIn({ error: UNSUPPORTED, readyState: 0, videoWidth: 0 });
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    // `null` ends the loop: no frame of this file is ever coming.
    expect(await source.next()).toBeNull();
    expect(source.error).toContain('IMG_4312.mov');
    expect(source.error).toContain('HEVC');
  });

  it('says nothing is wrong while the file is still loading', async () => {
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    expect(source.error).toBeNull();
  });

  it('plays, pauses and seeks the element the viewer mounted', async () => {
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();
    const playback = source.playback!;

    expect(playback.paused).toBe(false);
    expect(playback.duration).toBe(90);

    playback.pause();
    expect(video!.pause).toHaveBeenCalledTimes(1);
    playback.play();
    expect(video!.play).toHaveBeenCalledTimes(1);
    playback.seek(12.5);
    expect(video!.currentTime).toBe(12.5);
    expect(playback.currentTime).toBe(12.5);
  });

  it('reports a transport over nothing before the viewer has mounted its video', async () => {
    // `@query('rr-viewer')` resolves after the first render, so every reading
    // has to answer for an element that is not there yet.
    video = null;
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();
    const playback = source.playback!;

    expect(playback.paused).toBe(true);
    expect(playback.currentTime).toBe(0);
    expect(playback.duration).toBe(0);
    expect(() => {
      playback.play();
      playback.pause();
      playback.seek(3);
    }).not.toThrow();
  });

  it('reports no duration for a file whose metadata has not arrived', async () => {
    video = standIn({ duration: NaN });
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    expect(source.playback!.duration).toBe(0);
  });

  it('pauses the file and releases the URL when it stops', async () => {
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    source.stop();

    expect(video!.pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:the-video');
    expect(source.videoSrc).toBeNull();
    expect(await source.next()).toBeNull();
  });

  it('gives null to a frame already being waited for when it stops', async () => {
    video = standIn({ readyState: 0, videoWidth: 0 });
    const source = videoFileFrameSource(() => host, FILE);
    await source.start();

    const next = source.next();
    source.stop();

    expect(await next).toBeNull();
  });
});
