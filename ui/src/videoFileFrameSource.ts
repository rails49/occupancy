/**
 * A video file as a frame source (#286; the demo it serves is in `SPEC.md`
 * § Testing and Demo). The same L0→L1 loop, drift check and drift recording run
 * on its frames, because nothing downstream of `FrameSource` can tell which
 * source it is reading.
 *
 * It owns the object URL and nothing else. The pixels are read back out of the
 * `<video>` **`rr-viewer` mounted** — the viewer is what the user is looking at,
 * and a second element would decode the file twice — through `viewerVideo.ts`,
 * the same seam, pacing and readiness rule the camera reads it through.
 *
 * **One picture is one frame.** A frame is handed over only where the element
 * has moved to a new `currentTime`, so a paused file holds the loop instead of
 * re-detecting one still thirty times a second, and a seek runs the frame it
 * landed on whether the file is playing or paused.
 */

import type { FrameSource, Playback, SourceFrame } from './liveSources.js';
import { decodedFrame, nextAnimationFrame } from './viewerVideo.js';
import type { VideoHost } from './viewerVideo.js';

/**
 * Why a file will never give a frame, in words that name the usual cause.
 *
 * The browser's own `MediaError` message is empty in Chrome and unhelpful in
 * the others, so the refusal names the usual cause and what to do: an iPhone
 * records HEVC in a `.mov` by default, which not every browser decodes.
 */
function refusal(file: File, error: MediaError): string {
  const detail = error.message ? ` (${error.message})` : '';
  return (
    `this browser cannot play ${file.name}${detail}. An iPhone records HEVC in a ` +
    '.mov by default, which not every browser decodes — share or export the ' +
    'clip as H.264 .mp4, or try another browser'
  );
}

/**
 * A video file, played and read through the viewer's `<video>`.
 *
 * @param host the viewer, once it exists. Called per frame rather than held, as
 *             the camera source holds it: `@query` resolves after the first
 *             render, and the file is opened before it.
 * @param file what the person picked. Read once, as an object URL.
 */
export function videoFileFrameSource(
  host: () => VideoHost | null | undefined,
  file: File,
): FrameSource {
  let url: string | null = null;
  let running = false;
  let error: string | null = null;
  /**
   * The `currentTime` of the last frame handed over, or `null` before the
   * first.
   *
   * Compared rather than counted: it is the one reading that says whether the
   * element has a picture the loop has not run on — a new decoded frame while
   * playing, and the landing point of a seek while paused.
   */
  let lastTime: number | null = null;

  const video = () => host()?.getVideoElement() ?? null;

  const playback: Playback = {
    // Getters throughout: the element is playing, and a reading taken when the
    // view last rendered is already out of date.
    get paused() {
      // Paused is the honest answer for an element that is not there yet:
      // nothing is running, and the transport offers Play.
      return video()?.paused ?? true;
    },
    get currentTime() {
      return video()?.currentTime ?? 0;
    },
    get duration() {
      const duration = video()?.duration;
      // `NaN` until the metadata arrives, and `Infinity` for a stream with no
      // end. Neither is a length to put on a slider, and both read as 0.
      return duration !== undefined && Number.isFinite(duration) ? duration : 0;
    },
    play() {
      // A rejection is not this source's to report: the press came from the
      // person, so the autoplay policy is satisfied, and what is left is a file
      // that will not decode — which `next()` reports off the element's own
      // `error` for every other cause too.
      void video()
        ?.play()
        ?.catch(err => console.error(`Failed to play ${file.name}`, err));
    },
    pause() {
      video()?.pause();
    },
    seek(seconds: number) {
      const el = video();
      if (el) el.currentTime = seconds;
    },
  };

  return {
    // Not a stream: the viewer plays the file through `videoSrc`, and there is
    // no camera track, so the drift rows record an empty pair.
    stream: null,
    settings: {},
    playback,
    // Known at the pick, not at the load: the bar renders beside a file that
    // is still decoding, and the name is what says which one.
    name: file.name,

    get videoSrc() {
      return url;
    },

    get error() {
      return error;
    },

    async start() {
      running = true;
      // The handover, and the whole of the start: the element is the viewer's
      // and does not exist until the view has rendered what this returns, so
      // waiting for the file to load here would wait on a render this call is
      // holding up. `next()` picks the load up, either as a frame or as the
      // element's `error`.
      url = URL.createObjectURL(file);
    },

    stop() {
      running = false;
      video()?.pause();
      if (url) URL.revokeObjectURL(url);
      url = null;
    },

    async next(): Promise<SourceFrame | null> {
      // One frame per animation frame, as the camera is paced: the loop runs as
      // fast as the display and no faster.
      while (running) {
        await nextAnimationFrame();
        if (!running) return null;
        const el = video();

        if (el?.error) {
          // No frame of this file is ever coming, so the loop ends rather than
          // spinning on an element that has given up. The view reads the
          // message off `error` and shows it.
          error = refusal(file, el.error);
          return null;
        }

        const frame = decodedFrame(el);
        if (frame && el!.currentTime !== lastTime) {
          lastTime = el!.currentTime;
          return frame;
        }
      }
      return null;
    },
  };
}
