import { describe, it, expect, vi, afterEach } from 'vitest';
import { imageSize } from '../src/imageSize.ts';

// jsdom has no `createImageBitmap`; the stub stands for the browser's decoder.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('imageSize', () => {
  it('reports the decoded width and height, and releases the bitmap', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8064, height: 6048, close })));

    expect(await imageSize(Uint8Array.from([1, 2, 3]))).toEqual({ width: 8064, height: 6048 });
    expect(close).toHaveBeenCalledOnce();
  });

  it('is undefined for bytes that do not decode', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('not an image'))));

    expect(await imageSize(Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });
});
