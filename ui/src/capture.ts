import type { FrameSize } from './geometry.js';

/**
 * Shared camera constraints for the application.
 */
export const DEFAULT_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    facingMode: 'environment'
  },
  audio: false
};

/** How long a capture waits for the camera to hand over a playing stream. */
const CAPTURE_TIMEOUT_MS = 5000;

/** How long it then waits for a raised track to deliver the size it was raised to. */
const RAISED_FRAME_TIMEOUT_MS = 2000;

/** How often that wait looks. */
const RAISED_FRAME_POLL_MS = 50;

/**
 * Requests access to the camera and returns a MediaStream.
 */
export async function getCameraStream(constraints = DEFAULT_CAMERA_CONSTRAINTS): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * The largest size `track` reports it can produce, or null where the browser
 * reports no capabilities or names no size there.
 *
 * `width.max` and `height.max` are two independent ranges, so the pair is the
 * largest size the track *claims*, not one it promises to deliver together —
 * which is why {@link raiseToLargestSize} asks for it in a way that can be
 * refused.
 */
function largestCapableSize(track: MediaStreamTrack): FrameSize | null {
  const capabilities = track.getCapabilities?.();
  const width = capabilities?.width?.max;
  const height = capabilities?.height?.max;
  return width && height ? { width, height } : null;
}

/** The size `track` says it is delivering now, or null where it says nothing. */
function deliveredSize(track: MediaStreamTrack): FrameSize | null {
  const { width, height } = track.getSettings?.() ?? {};
  return width && height ? { width, height } : null;
}

/** Whether `size` would be refused on the way into the archive (`SPEC.md` § Images). */
function isPortrait(size: FrameSize): boolean {
  return size.height > size.width;
}

/**
 * Raises `track` to the largest size it reports it can produce, and returns the
 * size it then says it is delivering — or null where it was left as opened
 * (#273), in which case the frame is whatever the stream already carried.
 *
 * **Two attempts, exact then ideal.** `width.max` and `height.max` are
 * independent ranges, so on a camera with both a 16:9 video mode and a 4:3 one
 * their pair can be a mode the track has not got; exact asks for the claim
 * outright, and where that is refused ideal asks the browser for its nearest
 * supported mode, which is how a 4K-capable device still gets off 1080p. What
 * comes back is read from `getSettings()` rather than assumed, because under
 * ideal the browser chooses and only the track knows what it chose.
 *
 * Two raises are not attempted at all: one into a **portrait** frame, which
 * `SPEC.md` § Images refuses on the way into the archive, so it would cost a
 * refusal and no photograph; and one that is **no larger** than the stream as
 * opened, which is a reconfigure for nothing.
 *
 * Where every attempt is refused the capture keeps the stream as opened, and
 * that is 1080p rather than whatever the browser defaults to because the stream
 * is opened with the live view's ideal (`DEFAULT_CAMERA_CONSTRAINTS`); an ideal
 * does not cap these calls, which replace the track's constraints outright.
 */
async function raiseToLargestSize(track: MediaStreamTrack | undefined): Promise<FrameSize | null> {
  if (!track) return null;

  const largest = largestCapableSize(track);
  const opened = deliveredSize(track);
  if (!largest || isPortrait(largest)) return null;
  if (opened && largest.width <= opened.width && largest.height <= opened.height) return null;

  const attempts: MediaTrackConstraints[] = [
    { width: { exact: largest.width }, height: { exact: largest.height } },
    { width: { ideal: largest.width }, height: { ideal: largest.height } }
  ];
  for (const constraints of attempts) {
    try {
      await track.applyConstraints(constraints);
    } catch {
      continue;
    }
    return deliveredSize(track) ?? largest;
  }
  return null;
}

/** Resolves once the video element reports metadata and is playing. */
async function waitForPlayingVideo(video: HTMLVideoElement): Promise<void> {
  let safetyTimer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = (e) => reject(new Error('Video element error: ' + e));

      safetyTimer = setTimeout(() => reject(new Error('Camera capture timed out')), CAPTURE_TIMEOUT_MS);
    });
  } finally {
    clearTimeout(safetyTimer!);
  }
}

/**
 * Resolves once the element reports the raised `size`, so the frame drawn is
 * from after the switch rather than before it (#273).
 *
 * The raise is applied before the stream is attached, so metadata normally
 * arrives at the new size already; this is the guard for the case where it does
 * not, because the canvas is sized from `videoWidth` and a stale one would
 * store the pre-raise frame *and* declare the archive's `camera.resolution`
 * from it. Gives up after {@link RAISED_FRAME_TIMEOUT_MS} rather than failing
 * the capture: a frame at the size the element does report is worth more than
 * no photograph.
 */
async function waitForFrameSize(video: HTMLVideoElement, size: FrameSize): Promise<void> {
  const deadline = Date.now() + RAISED_FRAME_TIMEOUT_MS;
  while (video.videoWidth !== size.width || video.videoHeight !== size.height) {
    if (Date.now() >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, RAISED_FRAME_POLL_MS));
  }
}

/**
 * Utility to capture a single frame from the camera.
 * It opens the camera, raises the video track to the largest size the track
 * reports it can produce, grabs one frame at that size, and then stops the
 * stream.
 *
 * **The raise comes before the stream reaches the element** (#273), so the
 * element's first metadata is already the raised size. The frame is as large
 * as the camera offers because it is the archive's: a capture into a new
 * archive is what `camera.resolution` is taken from, and DPT — the detector's
 * one scale — is pixels per track width in that frame, so a 4K capture is
 * about DPT 16 where a 1080p one is about DPT 8. A capture into an archive
 * declared at another size is refused by the editor, unchanged
 * (`rr-editor-view`'s size refusal, #260).
 */
export async function captureFromCamera(): Promise<Uint8Array> {
  const stream = await getCameraStream();

  try {
    const raised = await raiseToLargestSize(stream.getVideoTracks()[0]);

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;

    await waitForPlayingVideo(video);
    if (raised) await waitForFrameSize(video, raised);

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    ctx.drawImage(video, 0, 0);

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('Could not create blob from canvas');

    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    // Ensure all tracks are stopped even if capture fails
    stream.getTracks().forEach(track => track.stop());
  }
}
