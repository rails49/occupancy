import type { Size } from './geometry.js';

/**
 * The pixel size of an encoded image, or `undefined` if it does not decode.
 *
 * Decodes the whole image; the bitmap is released at once.
 */
export async function imageSize(bytes: Uint8Array): Promise<Size | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return undefined;
  }
}
