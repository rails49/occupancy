/**
 * How an image gets into an archive: prepared, judged, then recorded
 * (`SPEC.md` § Images).
 *
 * It was private to `rr-editor-view` while the editor was the only way in.
 * Live's Freeze adds the frame on screen through the same three steps (#334),
 * and a second copy of them would be a second set of refusals to keep in step
 * with this one — so the rules live here and the two views call them.
 *
 * Nothing here owns a place to put a refusal: each function **returns** the
 * notice, and the component that was pressed toasts it (`rr-editor-view` as
 * `rr-notify`, `rr-app` directly for Freeze).
 */

import { make_id } from '@rails49/r49';
import type { AddedImage, EditSession } from './editSession.js';
import { clearExifOrientation } from './exifOrientation.js';
import type { Size } from './geometry.js';
import { imageSize } from './imageSize.js';

/** The `make_id` node for a captured frame's name, as images have their own (#256). */
const CAPTURE_NODE_ID = 3;

/**
 * The name a frame is stored under: `capture_<id>.jpg`.
 *
 * Generated rather than taken from what the frame arrived as, for Capture from
 * Camera because there is nothing to take, and for Freeze because the `frame`
 * part's filename is the service's own counter and not a name in this archive
 * (#334).
 */
export function captureFilename(): string {
  return `capture_${make_id(CAPTURE_NODE_ID)}.jpg`;
}

/** Why a portrait image is refused, naming what the user picked (#255). */
export function portraitRefusal(name: string, size: Size): string {
  const shape = `${size.width}×${size.height}`;
  return `${name} is portrait (${shape}) — an image must be landscape, so it was not added.`;
}

/**
 * Why an image of another size is refused, naming both sizes (#260).
 *
 * It names the two numbers rather than saying "wrong size", because which
 * half is wrong is the user's call: a shot taken at another zoom and an
 * archive whose `camera.resolution` is wrong read identically otherwise.
 */
export function sizeRefusal(name: string, size: Size, required: Size): string {
  const shape = `${size.width}×${size.height}`;
  const declared = `${required.width}×${required.height}`;
  return (
    `${name} is ${shape}, the archive is ${declared} — ` +
    `an added image must be the archive's size, so it was not added.`
  );
}

/**
 * The bytes a picked, captured or frozen image is stored as, and the size the
 * two refusal rules are applied to (`SPEC.md` § Images).
 *
 * The orientation tag goes to 1 first, so the bytes the archive holds are the
 * bytes every reader agrees on (#255, `exifOrientation.ts`), and the stored
 * array is then what `imageSize` measures — the size a new archive takes as
 * `camera.resolution` (#254), and the size the rules are judged on.
 */
async function prepareImage(picked: Uint8Array): Promise<Omit<AddedImage, 'filename'>> {
  const bytes = clearExifOrientation(picked);
  return { bytes, size: await imageSize(bytes) };
}

/**
 * Why a prepared image may not be stored, or null when it may
 * (`SPEC.md` § Images).
 *
 * A portrait array is refused rather than rotated: rotating would re-encode
 * the photograph, and software that rotated it once can rotate it back. An
 * image that is not the size required is refused because the detector's export
 * normalizes every label against `camera.resolution`, so a shot of another
 * field of view puts its labels in the wrong places (#260) — drawn scaled to
 * fit, which is why nothing on screen would say so. An image that does not
 * decode has no size to judge and is added as before.
 *
 * `required` is the session's `requiredImageSize` for a single add. Inside a
 * pick it is the size the pick has settled on, which is the same answer: the
 * first file the pick accepts is the one `EditSession.addImages` takes
 * `camera.resolution` from (#254).
 */
function addRefusal(name: string, size: Size | undefined, required: Size | null): string | null {
  if (!size) return null;
  if (size.height > size.width) return portraitRefusal(name, size);
  if (required && (size.width !== required.width || size.height !== required.height)) {
    return sizeRefusal(name, size, required);
  }
  return null;
}

/**
 * Adds one captured or frozen image, or returns the notice that refuses it.
 *
 * The picker's path is {@link addPickedFiles}; every path prepares and judges
 * the same way, so a capture, a frozen frame and a pick of one file are
 * refused in the same words.
 */
export async function addPrepared(
  session: EditSession,
  filename: string,
  name: string,
  picked: Uint8Array
): Promise<string | null> {
  const { bytes, size } = await prepareImage(picked);
  const refusal = addRefusal(name, size, session.requiredImageSize);
  if (refusal) return refusal;
  await session.addImage(filename, bytes, size);
  return null;
}

/**
 * Adds a whole pick as one history entry, and returns the notice naming what
 * it refused, or null when it refused nothing (#262).
 *
 * **Filename order**, not the order the picker handed the files over, which is
 * the platform's and on Chromium is the order they were clicked: a camera
 * names its files in the order it took them, so filename order is capture
 * order and the archive's image list reads as the session did. The comparison
 * is numeric, so `shot9.jpg` precedes `shot10.jpg`, and against a fixed
 * locale, so the order does not move with the browser's.
 *
 * Each file keeps its own name — `EditSession.addImages` falls back to a
 * generated one only for a collision (#256) — because the names are what the
 * corpus is indexed by outside this program.
 *
 * A refused file is skipped and the rest of the pick is added: forty
 * photographs with one 0.5x shot among them cost one Cmd+Z, and one toast
 * naming the shot rather than forty-one toasts.
 */
export async function addPickedFiles(
  session: EditSession,
  files: readonly File[]
): Promise<string | null> {
  const ordered = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { numeric: true })
  );
  const adds: AddedImage[] = [];
  const refusals: string[] = [];
  let required = session.requiredImageSize;

  for (const file of ordered) {
    const { bytes, size } = await prepareImage(new Uint8Array(await file.arrayBuffer()));
    const refusal = addRefusal(file.name, size, required);
    if (refusal) {
      refusals.push(refusal);
      continue;
    }
    adds.push({ filename: file.name, bytes, size });
    // In an archive where nothing is positioned, this file is the one that
    // sets `camera.resolution`, so it is what the rest of the pick is held to.
    if (!required && size) required = size;
  }

  await session.addImages(adds);
  return refusals.length === 0 ? null : refusals.join(' ');
}
