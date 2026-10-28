/** A small copy of an archive image for the thumbnail strip (#252). */

/** Width of a thumbnail in pixels: the strip's 64 px box at up to 4x. */
export const THUMBNAIL_WIDTH = 256;

/**
 * Decodes `image` and re-encodes it as a JPEG at most {@link THUMBNAIL_WIDTH}
 * wide, keeping its aspect.
 *
 * `resizeWidth` lets the decoder shrink as it decodes; an engine that ignores
 * the option still gets a small result from the draw.
 *
 * @throws if `image` does not decode
 */
export async function makeThumbnail(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image, {
    resizeWidth: THUMBNAIL_WIDTH,
    resizeQuality: 'medium',
  });
  const scale = Math.min(1, THUMBNAIL_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}
