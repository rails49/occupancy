import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { THUMBNAIL_WIDTH, makeThumbnail } from '../src/thumbnail.ts';

// jsdom has neither `createImageBitmap` nor `OffscreenCanvas`. The stubs stand
// for a decoder that may or may not honour `resizeWidth`, and record the draw.
const drawImage = vi.fn();
const convertToBlob = vi.fn(async () => new Blob(['thumb'], { type: 'image/jpeg' }));
let canvasSize: [number, number] | null = null;

function decoder(width: number, height: number) {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close: vi.fn() }))
  );
}

beforeEach(() => {
  drawImage.mockClear();
  convertToBlob.mockClear();
  canvasSize = null;
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(width: number, height: number) {
        canvasSize = [width, height];
      }
      getContext() {
        return { drawImage };
      }
      convertToBlob = convertToBlob;
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeThumbnail', () => {
  it('asks the decoder for a thumbnail-wide bitmap', async () => {
    decoder(THUMBNAIL_WIDTH, 192);
    const image = new Blob(['jpeg']);

    await makeThumbnail(image);

    expect(createImageBitmap).toHaveBeenCalledWith(image, {
      resizeWidth: THUMBNAIL_WIDTH,
      resizeQuality: 'medium',
    });
    expect(canvasSize).toEqual([THUMBNAIL_WIDTH, 192]);
  });

  it('shrinks a full-size bitmap from a decoder that ignored resizeWidth', async () => {
    decoder(8064, 6048);

    await makeThumbnail(new Blob(['jpeg']));

    expect(canvasSize).toEqual([THUMBNAIL_WIDTH, 192]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, THUMBNAIL_WIDTH, 192);
  });

  it('returns a JPEG', async () => {
    decoder(THUMBNAIL_WIDTH, 192);

    const thumb = await makeThumbnail(new Blob(['jpeg']));

    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.85 });
    expect(thumb.type).toBe('image/jpeg');
  });
});
