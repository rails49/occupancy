import { describe, it, expect } from 'vitest';
import { clearExifOrientation, readExifOrientation } from '../src/exifOrientation.ts';
import {
  exifApp1,
  jpeg,
  jpegWithOrientation,
  shortEntry,
  xmpApp1,
  ORIENTATION_TAG,
} from './jpegFixture.ts';

/** The positions at which two byte strings of the same length differ. */
function differences(a: Uint8Array, b: Uint8Array): number[] {
  return [...a].flatMap((byte, i) => (byte === b[i] ? [] : [i]));
}

describe('readExifOrientation', () => {
  it('reads the tag from a big-endian IFD', () => {
    expect(readExifOrientation(jpegWithOrientation(6))).toBe(6);
  });

  it('reads the tag from a little-endian IFD', () => {
    expect(readExifOrientation(jpegWithOrientation(8, true))).toBe(8);
  });

  it('finds the tag past earlier entries, and past an APP1 that is not EXIF', () => {
    const entries = [
      shortEntry(0x0100, 8064), // ImageWidth
      shortEntry(0x0101, 6048), // ImageLength
      shortEntry(ORIENTATION_TAG, 3),
      shortEntry(0x0128, 2), // ResolutionUnit
    ];

    expect(readExifOrientation(jpeg(xmpApp1(), exifApp1(entries)))).toBe(3);
  });

  it('is undefined for a JPEG with no EXIF block', () => {
    expect(readExifOrientation(jpeg())).toBeUndefined();
  });

  it('is undefined for an EXIF block with no orientation entry', () => {
    expect(readExifOrientation(jpeg(exifApp1([shortEntry(0x0100, 8064)])))).toBeUndefined();
  });

  it('is undefined for bytes that are not a JPEG', () => {
    expect(readExifOrientation(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});

describe('clearExifOrientation', () => {
  it('sets a rotate tag to 1, at the same length and with every other byte as picked', () => {
    const picked = jpeg(exifApp1([shortEntry(0x0100, 8064), shortEntry(ORIENTATION_TAG, 6)]));

    const stored = clearExifOrientation(picked);

    expect(readExifOrientation(stored)).toBe(1);
    expect(stored).toHaveLength(picked.length);
    // One byte of the two-byte SHORT: 6 and 1 differ in the low byte alone.
    expect(differences(picked, stored)).toHaveLength(1);
  });

  it('sets a mirrored tag to 1 the same way', () => {
    const picked = jpegWithOrientation(2);

    const stored = clearExifOrientation(picked);

    expect(readExifOrientation(stored)).toBe(1);
    expect(stored).toHaveLength(picked.length);
    expect(differences(picked, stored)).toHaveLength(1);
  });

  it('sets a little-endian tag to 1, writing in that byte order', () => {
    const picked = jpegWithOrientation(8, true);

    const stored = clearExifOrientation(picked);

    expect(readExifOrientation(stored)).toBe(1);
    expect(stored).toHaveLength(picked.length);
    expect(differences(picked, stored)).toHaveLength(1);
  });

  it('returns the same bytes when the tag is already 1', () => {
    const picked = jpegWithOrientation(1);

    expect(clearExifOrientation(picked)).toBe(picked);
  });

  it('returns the same bytes for a JPEG with no EXIF block', () => {
    const picked = jpeg();

    expect(clearExifOrientation(picked)).toBe(picked);
  });

  it('returns the same bytes for anything that is not a JPEG', () => {
    const picked = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    expect(clearExifOrientation(picked)).toBe(picked);
  });

  it('leaves the picked bytes alone', () => {
    const picked = jpegWithOrientation(6);

    clearExifOrientation(picked);

    expect(readExifOrientation(picked)).toBe(6);
  });

  it('returns the same bytes for an EXIF block that is truncated mid-IFD', () => {
    const whole = jpegWithOrientation(6);
    const picked = whole.slice(0, whole.length - 12);

    expect(clearExifOrientation(picked)).toBe(picked);
  });
});
