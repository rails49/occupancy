/**
 * A JPEG's EXIF orientation tag: reading it, and setting it to 1 (#255).
 *
 * The browser applies the tag whenever it decodes an image — `<img>` and
 * `createImageBitmap` both — and the detector's readers do not: `sharp` and
 * Pillow hand back the stored array. An iPhone photo stores an 8064×6048
 * landscape array with the tag set to 6, so the editor would measure a
 * 6048×8064 portrait frame and author labels in it that nothing downstream
 * ever sees. Setting the tag to 1 on import makes the stored array the one
 * array, for every reader.
 *
 * Only the tag's two value bytes are touched: the pixels are not re-encoded,
 * so the import loses no quality and adds no generation, and an archive holds
 * the bytes the camera wrote.
 */

/** The TIFF tag number for orientation. */
const ORIENTATION_TAG = 0x0112;

/** The TIFF field type the tag is stored as: `SHORT`, two bytes. */
const SHORT = 3;

/** The one value that means "display the stored array as it is". */
export const ORIENTATION_NONE = 1;

/** "Exif\0\0", the identifier of the `APP1` segment that carries the IFDs. */
const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/** Where a JPEG keeps the orientation value, and in which byte order. */
interface TagSite {
  /** Offset of the two-byte value from the start of the JPEG. */
  readonly offset: number;
  /** The IFD's byte order — `II` rather than `MM`. */
  readonly intel: boolean;
}

/** A reader over the whole of `bytes`, however it is backed. */
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The orientation value inside one `APP1` segment's body, or `undefined` when
 * the segment is not EXIF, carries no IFD0 orientation entry, or is malformed.
 *
 * Every offset is bounds-checked against `end`: these bytes come from a file
 * the user picked, and a truncated or hand-edited header must leave the import
 * alone rather than read past the segment it claims to fill.
 */
function orientationInApp1(bytes: Uint8Array, start: number, end: number): TagSite | undefined {
  const tiff = start + EXIF_ID.length;
  if (tiff + 8 > end) return undefined;
  if (EXIF_ID.some((byte, i) => bytes[start + i] !== byte)) return undefined;

  const data = view(bytes);
  const order = data.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const intel = order === 0x4949;
  if (data.getUint16(tiff + 2, intel) !== 0x002a) return undefined;

  const ifd = tiff + data.getUint32(tiff + 4, intel);
  if (ifd + 2 > end) return undefined;
  const fields = data.getUint16(ifd, intel);
  if (ifd + 2 + fields * 12 > end) return undefined;

  for (let i = 0; i < fields; i++) {
    const field = ifd + 2 + i * 12;
    if (data.getUint16(field, intel) !== ORIENTATION_TAG) continue;
    // Anything but one SHORT is not an orientation this code understands, and
    // a value too wide for the field would sit at an offset rather than in it.
    if (data.getUint16(field + 2, intel) !== SHORT) return undefined;
    if (data.getUint32(field + 4, intel) !== 1) return undefined;
    return { offset: field + 8, intel };
  }
  return undefined;
}

/**
 * Where `bytes` keeps its EXIF orientation value, or `undefined` when it has
 * none.
 *
 * Walks the JPEG's segments to the start of the scan and reads IFD0 of the
 * first `APP1` that is EXIF — a real file also carries XMP in an `APP1`, and
 * either may come first. The thumbnail IFD is not searched: IFD0 is the
 * orientation a reader applies to the image.
 */
function orientationSite(bytes: Uint8Array): TagSite | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const data = view(bytes);

  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    // A fill byte before a marker, then the markers that carry no payload.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // `SOS` begins entropy-coded data and `EOI` ends the image: no segment follows.
    if (marker === 0xda || marker === 0xd9) return undefined;

    const length = data.getUint16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return undefined;
    if (marker === 0xe1) {
      const site = orientationInApp1(bytes, at + 4, at + 2 + length);
      if (site) return site;
    }
    at += 2 + length;
  }
  return undefined;
}

/** The EXIF orientation of `bytes`, or `undefined` when it carries no tag. */
export function readExifOrientation(bytes: Uint8Array): number | undefined {
  const site = orientationSite(bytes);
  return site && view(bytes).getUint16(site.offset, site.intel);
}

/**
 * A copy of `bytes` whose EXIF orientation is {@link ORIENTATION_NONE}, or
 * `bytes` itself when there is nothing to change — no tag, or a tag already 1.
 *
 * The copy differs from the picked bytes in the tag's value alone: same length,
 * every other byte as picked. A PNG is returned as it is; its `eXIf` chunk is
 * out of scope (#255).
 */
export function clearExifOrientation(bytes: Uint8Array): Uint8Array {
  const site = orientationSite(bytes);
  if (!site) return bytes;
  if (view(bytes).getUint16(site.offset, site.intel) === ORIENTATION_NONE) return bytes;

  const stored = bytes.slice();
  view(stored).setUint16(site.offset, ORIENTATION_NONE, site.intel);
  return stored;
}
