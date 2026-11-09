import { describe, it, expect } from 'vitest';
import { decodedFrame } from '../src/viewerVideo.js';

// The readiness rule both local frame sources read it through (#330, #286).
// jsdom decodes no video, so a `<video>` here is a stand-in with the three
// fields the rule reads — the same stand-in `cameraFrameSource.test.ts` and
// `rr-live-view.test.ts` use, and for the same reason.

const video = (fields: { readyState: number; videoWidth: number; videoHeight: number }) =>
  fields as unknown as HTMLVideoElement;

describe('decodedFrame', () => {
  it('hands over the element at the size it decoded', () => {
    // The intrinsic size, not `camera.resolution`: it is the grid the pixels
    // are in, and the drift grab and `detect` are both given the real pixels.
    const el = video({ readyState: 2, videoWidth: 1280, videoHeight: 720 });

    expect(decodedFrame(el)).toEqual({ source: el, width: 1280, height: 720 });
  });

  it('gives null before the metadata arrives', () => {
    // `detect` throws on a source with no dimensions, and this is the normal
    // first few frames of a session — and a video mid-seek.
    expect(decodedFrame(video({ readyState: 0, videoWidth: 0, videoHeight: 0 }))).toBeNull();
    expect(decodedFrame(video({ readyState: 1, videoWidth: 1280, videoHeight: 720 }))).toBeNull();
  });

  it('gives null for a size of zero on a video that claims to be ready', () => {
    expect(decodedFrame(video({ readyState: 2, videoWidth: 0, videoHeight: 0 }))).toBeNull();
  });

  it('gives null where the viewer has mounted no video at all', () => {
    // `@query('rr-viewer')` resolves after the first render, so a source is
    // given a getter rather than an element, and the getter can answer nothing.
    expect(decodedFrame(null)).toBeNull();
    expect(decodedFrame(undefined)).toBeNull();
  });
});
