/**
 * The camera as a frame source (#330).
 *
 * It owns the `MediaStream` and nothing else: the pixels are read back out of
 * the `<video>` **`rr-viewer` mounted**, because the viewer is what the user is
 * looking at and a second video element would be a second decode of the same
 * stream. That is why this takes a getter rather than an element — `@query`
 * resolves after the first render, and the camera is acquired before it.
 *
 * The seam onto that element, the pacing and the readiness rule are
 * `viewerVideo.ts`'s, shared with the video-file source (#286).
 */

import { getCameraStream } from './capture.js';
import type { FrameSource, SourceFrame } from './liveSources.js';
import { decodedFrame, nextAnimationFrame } from './viewerVideo.js';
import type { VideoHost } from './viewerVideo.js';

/**
 * The camera, read through the viewer's `<video>`.
 *
 * @param host the viewer, once it exists. Called per frame rather than held: the
 *             element outlives no remount and the video inside it is replaced
 *             with the stream.
 */
export function cameraFrameSource(host: () => VideoHost | null | undefined): FrameSource {
  let stream: MediaStream | null = null;
  let running = false;

  /**
   * The frame on screen, or `null` while there is nothing to read.
   *
   * There is no image branch. The live view never sets `src`, so the one that
   * stood here could not run (#330).
   */
  function decoded(): SourceFrame | null {
    return decodedFrame(host()?.getVideoElement());
  }

  return {
    get stream() {
      return stream;
    },

    get settings() {
      return stream?.getVideoTracks()[0]?.getSettings() ?? {};
    },

    async start() {
      running = true;
      try {
        const granted = await getCameraStream();
        // Stopped while the permission prompt was still up. The grant lands on
        // a source nobody is reading, and an unstopped track holds the camera
        // until the page is reloaded.
        if (running) stream = granted;
        else granted.getTracks().forEach(track => track.stop());
      } catch (err) {
        // Not fatal: the notices, the drift readout and the sensor states are
        // still the view's job, and `next()` simply never reports a frame.
        console.error('Failed to access camera', err);
      }
    },

    stop() {
      running = false;
      stream?.getTracks().forEach(track => track.stop());
      stream = null;
    },

    async next() {
      // One frame per animation frame, waiting for the next rather than
      // polling: the loop runs as fast as the display and no faster, which is
      // what the rAF loop in the view did before the split.
      while (running) {
        await nextAnimationFrame();
        if (!running) return null;
        const frame = decoded();
        if (frame) return frame;
      }
      return null;
    },
  };
}
