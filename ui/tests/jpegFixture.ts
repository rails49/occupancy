/**
 * Small generated JPEGs for the tests that read or rewrite an EXIF header
 * (#255).
 *
 * Built byte by byte from the format rather than checked in as binaries: the
 * cases that matter are a byte order, a tag's position in an IFD and an `APP1`
 * that is not EXIF, and each of those is one argument here and invisible in a
 * fixture file. Nothing generated here has to **decode** — the code under test
 * walks segment headers and never the scan.
 */

/** The TIFF tag number for orientation. */
export const ORIENTATION_TAG = 0x0112;

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

/**
 * One 12-byte IFD entry holding a single `SHORT`, whose value sits in the first
 * two bytes of the four-byte value field.
 */
export function shortEntry(tag: number, value: number, intel = false): number[] {
  return [...u16(tag, intel), ...u16(3, intel), ...u32(1, intel), ...u16(value, intel), 0, 0];
}

/** A JPEG segment: its marker, a big-endian length covering itself, and `body`. */
function segment(marker: number, body: number[]): number[] {
  return [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
}

/**
 * An `APP1` EXIF segment whose IFD0 holds `entries`. The IFD sits directly
 * after the TIFF header and there is no IFD1.
 */
export function exifApp1(entries: number[][], intel = false): number[] {
  return segment(0xe1, [
    ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
    ...(intel ? INTEL : MOTOROLA),
    ...u32(8, intel), // IFD0 starts right after the 8-byte TIFF header
    ...u16(entries.length, intel),
    ...entries.flat(),
    ...u32(0, intel), // no IFD1
  ]);
}

/** An `APP1` segment that is XMP rather than EXIF — a real file carries both. */
export function xmpApp1(): number[] {
  return segment(0xe1, [...[...'http://ns.adobe.com/xap/1.0/'].map(c => c.charCodeAt(0)), 0x00]);
}

/** A whole JPEG: `SOI`, the segments given, a stub scan, and `EOI`. */
export function jpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...segments.flat(),
    ...segment(0xda, [0x00]), // SOS: nothing past here is a segment
    0x00,
    0xff,
    0xd9,
  ]);
}

/** A JPEG whose only EXIF entry is the orientation tag. */
export function jpegWithOrientation(orientation: number, intel = false): Uint8Array {
  return jpeg(exifApp1([shortEntry(ORIENTATION_TAG, orientation, intel)], intel));
}
