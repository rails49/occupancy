import type { Size } from './geometry.js';

/**
 * Shared camera constraints for the application.
 *
 * What the live view's stream is, and what a capture *opens* before it raises
 * the track it got (#273).
 */
export const DEFAULT_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    facingMode: 'environment'
  },
  audio: false
};

/**
 * Requests access to the camera and returns a MediaStream.
 */
export async function getCameraStream(constraints = DEFAULT_CAMERA_CONSTRAINTS): Promise<MediaStream> {
  return await navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * What a raise needs of a video track, with the two methods it may not have.
 *
 * `MediaStreamTrack` declares both, but a browser need not implement them and
 * a capture has to work where it does not — so the shape the raise is written
 * against makes them optional, rather than asserting a method is there.
 */
interface RaisableTrack {
  getCapabilities?: () => MediaTrackCapabilities;
  applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
}

/** The largest frame a track says it can deliver, or null where it does not say. */
function largestCapableSize(track: RaisableTrack): Size | null {
  const capabilities = track.getCapabilities?.();
  const width = capabilities?.width?.max;
  const height = capabilities?.height?.max;
  if (width === undefined || height === undefined) return null;
  return { width, height };
}

/**
 * Raises a track to the largest frame it says it can deliver (#273).
 *
 * The stream opens at {@link DEFAULT_CAMERA_CONSTRAINTS}' 1080p, which is about
 * DPT 8.
 *
 * One `exact` request, and a refusal leaves the stream as opened. The capability
 * maxima need not be jointly achievable — 3840 wide and 2448 tall can be two
 * different modes of one camera — so the request can fail. Where the browser
 * offers no `getCapabilities`, reports no maxima, or has no `applyConstraints`,
 * there is nothing to ask for and the capture is the stream as it opened.
 */
async function raiseToLargestCapableSize(track: RaisableTrack): Promise<void> {
  const largest = largestCapableSize(track);
  if (!largest) return;
  try {
    await track.applyConstraints?.({
      width: { exact: largest.width },
      height: { exact: largest.height },
    });
  } catch {
    // The stream as opened is a usable capture.
  }
}

/**
 * Utility to capture a single frame from the camera.
 * It opens the camera, grabs one frame, and then stops the stream.
 *
 * The frame is the largest the camera offers, not the 1080p the stream opens at
 * ({@link raiseToLargestCapableSize}, #273). The raise happens before the
 * stream reaches the `<video>`, so the element's own size is already the
 * raised one, and the first frame it ever decodes is one the track took after
 * the switch: there is no earlier frame to grab by mistake.
 *
 * The size the frame is grabbed at is therefore the element's, which is what
 * the camera settled on rather than what was asked for — and `drawImage` blits
 * the element at exactly that size, so a canvas sized from anything else would
 * crop or pad the stored photograph wherever the two disagreed.
 *
 * Judging the frame — landscape, and the size the archive declares — is
 * `imageAdd.ts`'s, the same way for a pick and for Freeze: a 4K capture into an
 * archive declared at 1080p is refused in those words (#260), and a capture into
 * an archive where nothing is positioned sets `camera.resolution` to the size it
 * came at (#254).
 */
export async function captureFromCamera(): Promise<Uint8Array> {
  const stream = await getCameraStream();

  try {
    const track: RaisableTrack | undefined = stream.getVideoTracks()[0];
    if (track) await raiseToLargestCapableSize(track);

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;

    // Wait for video to be ready and playing
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => {
        video.play().then(resolve).catch(reject);
      };
      video.onerror = (e) => reject(new Error('Video element error: ' + e));

      // Safety timeout
      setTimeout(() => reject(new Error('Camera capture timed out')), 5000);
    });

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
