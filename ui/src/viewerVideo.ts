/**
 * The `<video>` `rr-viewer` mounted, as a local frame source reads it (#330).
 *
 * Both local sources — the camera and a video file (#286) — read their pixels
 * back out of the element the user is already looking at, rather than decoding
 * the same frames a second time into one of their own. What they share is in
 * here: the seam onto the viewer, the pacing, and the rule for when the element
 * has a frame worth handing over.
 *
 * Nothing here opens anything. A camera, a file and the object URL one needs
 * belong to the source that owns them.
 */

import type { SourceFrame } from './liveSources.js';

/** What a source needs of `rr-viewer`: the `<video>` it mounted, once it has one. */
export interface VideoHost {
  getVideoElement(): HTMLVideoElement | null;
}

/** One animation frame, which is what paces a local live loop. */
export const nextAnimationFrame = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/**
 * The frame on screen, or `null` while there is nothing to read.
 *
 * The readiness check is here rather than inside `detect`, which throws on a
 * source with no dimensions: a video before its metadata arrives is the normal
 * first few frames of a session, not an error to report. A video being seeked
 * drops back below it and comes back, which is the same case.
 *
 * The size is the element's **intrinsic** size — what the camera settled on, or
 * what the file was recorded at — because that is the grid the pixels are in:
 * `drawImage` blits the element at exactly that size, and the drift grab and
 * `detect` are both given the real pixels rather than a declared frame they
 * would have to be resampled to first.
 */
export function decodedFrame(video: HTMLVideoElement | null | undefined): SourceFrame | null {
  if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
  return { source: video, width: video.videoWidth, height: video.videoHeight };
}
