import { describe, it, expect } from 'vitest';
import { clearExifOrientation, readExifOrientation } from '../src/exifOrientation.ts';

/** Big-endian and little-endian TIFF headers, the two byte orders EXIF allows. */
const MOTOROLA = [0x4d, 0x4d, 0x00, 0x2a];
const INTEL = [0x49, 0x49, 0x2a, 0x00];

/** A 16-bit value in the byte order its IFD declares. */
function u16(value: number, intel: boolean): number[] {
  return intel ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
}

/** A 32-bit value in the byte order its IFD declares. */
function u32(value: number, intel: boolean): number[] {
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return intel ? bytes.reverse() : bytes;
}

/** One 12-byte IFD entry: tag, type, count, then the value or an offset. */
function entry(tag: number, type: number, count: number, value: number[], intel: boolean): number[] {
  return [...u16(tag, intel), ...u16(type, intel), ...u32(count, intel), ...value, ...new Array(4 - value.length).fill(0)];
}

/** A SHORT entry, whose one value sits in the first two bytes of the value field. */
function shortEntry(tag: number, value: number, intel: boolean): number[] {
  return entry(tag, 3, 1, u16(value, intel), intel);
}

/** A JPEG segment: its marker, a big-endian length covering itself, and `body`. */
function segment(marker: number, body: number[]): number[] {
  return [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
}

/**
 * An `APP1` EXIF segment whose IFD0 holds `entries`, sorted as a writer would
 * leave them. The IFD sits directly after the TIFF header and has no IFD1.
 */
function exifApp1(entries: number[][], intel = false): number[] {
  const ifd = [...u16(entries.length, intel), ...entries.flat(), ...u32(0, intel)];
  return segment(0xe1, [
    ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
    ...(intel ? INTEL : MOTOROLA),
    ...u32(8, intel), // IFD0 starts right after the 8-byte TIFF header
    ...ifd,
  ]);
}

/** An `APP1` segment that is XMP rather than EXIF — a real file carries both. */
function xmpApp1(): number[] {
  return segment(0xe1, [...[...'http://ns.adobe.com/xap/1.0/'].map(c => c.charCodeAt(0)), 0x00]);
}

/** A whole JPEG: `SOI`, the segments given, a one-byte stub scan, and `EOI`. */
function jpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    ...segments.flat(),
    ...segment(0xda, [0x00]), // SOS: nothing past here is a segment
    0x00,
    0xff, 0xd9,
  ]);
}

/** The positions at which two equal-length byte strings differ. */
function differences(a: Uint8Array, b: Uint8Array): number[] {
  expect(b.length).toBe(a.length);
  return [...a].flatMap((byte, i) => (byte === b[i] ? [] : [i]));
}

describe('readExifOrientation', () => {
  it('reads the tag from a big-endian IFD', () => {
    expect(readExifOrientation(jpeg(exifApp1([shortEntry(0x0112, 6, false)])))).toBe(6);
  });

  it('reads the tag from a little-endian IFD', () => {
    expect(readExifOrientation(jpeg(exifApp1([shortEntry(0x0112, 8, true)], true)))).toBe(8);
  });

  it('finds the tag past earlier entries, and past an APP1 that is not EXIF', () => {
    const entries = [
      shortEntry(0x0100, 8064, false), // ImageWidth
      shortEntry(0x0101, 6048, false), // ImageLength
      shortEntry(0x0112, 3, false),
      shortEntry(0x0128, 2, false), // ResolutionUnit
    ];
    expect(readExifOrientation(jpeg(xmpApp1(), exifApp1(entries)))).toBe(3);
  });

  it('is undefined for a JPEG with no EXIF block', () => {
    expect(readExifOrientation(jpeg())).toBeUndefined();
  });

  it('is undefined for an EXIF block with no orientation entry', () => {
    expect(readExifOrientation(jpeg(exifApp1([shortEntry(0x0100, 8064, false)])))).toBeUndefined();
  });

  it('is undefined for bytes that are not a JPEG', () => {
    expect(readExifOrientation(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});

describe('clearExifOrientation', () => {
  it('sets a rotate tag to 1 and changes nothing else', () => {
    const picked = jpeg(exifApp1([shortEntry(0x0100, 8064, false), shortEntry(0x0112, 6, false)]));

    const stored = clearExifOrientation(picked);

    expect(readExifOrientation(stored)).toBe(1);
    // One byte of the two-byte SHORT: 6 and 1 differ in the low byte alone.
    expect(differences(picked, stored)).toHaveLength(1);
  });

  it('sets a mirrored tag to 1 the same way', () => {
    const picked = jpeg(exifApp1([shortEntry(0x0112, 2, false)]));

    const stored = clearExifOrientation(picked);

    expect(readExifOrientation(stored)).toBe(1);
    expect(differences(picked, stored)).toHaveLength(1);
  });

  it('sets a little-endian tag to 1, writing in that byte order', () => {
    const picked = jpeg(exifApp1([shortEntry(0x0112, 8, true)], true));

    const stored = clearExifOrientation(picked);

    expect(readExifOrientation(stored)).toBe(1);
    expect(differences(picked, stored)).toHaveLength(1);
  });

  it('returns the same bytes when the tag is already 1', () => {
    const picked = jpeg(exifApp1([shortEntry(0x0112, 1, false)]));

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
    const picked = jpeg(exifApp1([shortEntry(0x0112, 6, false)]));

    clearExifOrientation(picked);

    expect(readExifOrientation(picked)).toBe(6);
  });

  it('returns the same bytes for an EXIF block that is truncated mid-IFD', () => {
    const whole = jpeg(exifApp1([shortEntry(0x0112, 6, false)]));
    const picked = whole.slice(0, whole.length - 12);

    expect(clearExifOrientation(picked)).toBe(picked);
  });
});
