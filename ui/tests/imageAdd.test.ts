import { describe, it, expect, vi, beforeEach } from 'vitest';
import { R49Archive, MANIFEST_VERSION } from '@rails49/r49';
import type { ManifestData } from '@rails49/r49';
import { EditSession } from '../src/editSession.js';
import { addPrepared, captureFilename, portraitRefusal, sizeRefusal } from '../src/imageAdd.js';
import { jpeg, jpegWithOrientation } from './jpegFixture.js';
import { readExifOrientation } from '../src/exifOrientation.js';

// The three steps of an image add, driven the way Live's Freeze drives them
// (#334): no element, a real `EditSession`, and the frame's bytes handed
// straight in. The editor's two ways in are exercised through the element in
// `rr-editor-view.test.ts`; what this file pins is the seam both share, which
// is the one the live view now also depends on.
//
// `imageSize` is mocked because jsdom has no `createImageBitmap`: the size is
// what both refusal rules are judged on, so a test that could not state it
// could not reach either of them.
const imageSize = vi.fn(async (_bytes: Uint8Array) => ({ width: 640, height: 480 }));
vi.mock('../src/imageSize.js', () => ({
  imageSize: (bytes: Uint8Array) => imageSize(bytes),
}));

/** The size the archives here declare, which is the size the service's frames are. */
const DECLARED = { width: 640, height: 480 };

function manifest(positioned: boolean): ManifestData {
  return {
    version: MANIFEST_VERSION,
    layout: {
      name: 'Served',
      scale: 'N',
      calibration: {
        points: positioned
          ? [
              { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
              { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
            ]
          : [],
      },
      sensors: [],
    },
    camera: { resolution: DECLARED },
    images: [],
  };
}

/**
 * A session on an empty archive.
 *
 * `positioned` is whether anything is in `camera.resolution`'s pixels: with
 * nothing positioned the next image sets the resolution instead of being held
 * to it (#254).
 */
function session(positioned = true): EditSession {
  const archive = new R49Archive();
  archive.setManifest(manifest(positioned));
  return new EditSession(archive);
}

const images = (s: EditSession) => s.archive.getManifest().images;

/** One add, as `rr-app` makes it for a frozen frame. */
const freeze = (s: EditSession, bytes: Uint8Array) => {
  const filename = captureFilename();
  return addPrepared(s, filename, filename, bytes).then(refusal => ({ filename, refusal }));
};

describe('adding one prepared image (#334)', () => {
  beforeEach(() => {
    imageSize.mockClear();
    imageSize.mockResolvedValue(DECLARED);
  });

  it('stores the bytes as they came, under a capture_ name', async () => {
    const s = session();
    const frame = jpeg();

    const { filename, refusal } = await freeze(s, frame);

    expect(refusal).to.be.null;
    expect(filename).to.match(/^capture_[^.]+\.jpg$/);
    expect(images(s).map(image => image.filename)).toEqual([filename]);
    // A JPEG with no orientation tag is stored byte for byte: preparing it
    // rewrites that one value and re-encodes nothing.
    expect(await s.archive.getImage(filename)).toEqual(frame);
  });

  it('sets the orientation tag to 1 in what it stores', async () => {
    const s = session();

    const { filename } = await freeze(s, jpegWithOrientation(6));

    const stored = (await s.archive.getImage(filename))!;
    expect(readExifOrientation(stored)).toBe(1);
    // And the size both rules are judged on is measured on those bytes.
    expect(imageSize).toHaveBeenCalledWith(stored);
  });

  it('is one history entry, which undo takes back, and leaves the archive dirty', async () => {
    const s = session();

    const { filename } = await freeze(s, jpeg());

    expect(s.history.isDirty).toBe(true);
    expect(s.history.undoLabel).toBe('add image');
    expect(s.history.canUndo).toBe(true);

    await s.undo();

    expect(images(s)).toEqual([]);
    expect(s.history.canUndo).toBe(false);
    // Removed from the zip too, not just from the manifest.
    expect(await s.archive.getImage(filename)).to.be.null;
  });

  it('shows the image it added', async () => {
    const s = session();
    await s.archive.addImage('img_1.jpg', jpeg());
    s.archive.getManifest().images.push({
      filename: 'img_1.jpg',
      labeled_complete: false,
      labels: [],
    });

    const { filename } = await freeze(s, jpeg());

    // The person goes to the editor and the frame they just added is what is
    // on screen there.
    expect(s.image?.filename).toBe(filename);
  });

  it('sets camera.resolution where nothing is positioned', async () => {
    const s = session(false);
    imageSize.mockResolvedValue({ width: 1920, height: 1080 });

    const { refusal } = await freeze(s, jpeg());

    expect(refusal).to.be.null;
    expect(s.archive.getManifest().camera.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it('refuses a portrait frame in the existing words, recording nothing', async () => {
    const s = session();
    const portrait = { width: 480, height: 640 };
    imageSize.mockResolvedValue(portrait);

    const { filename, refusal } = await freeze(s, jpeg());

    expect(refusal).toBe(portraitRefusal(filename, portrait));
    expect(images(s)).toEqual([]);
    expect(s.history.canUndo).toBe(false);
    expect(s.history.isDirty).toBe(false);
  });

  it('refuses a frame of another size in the existing words, recording nothing', async () => {
    const s = session();
    const other = { width: 1920, height: 1080 };
    imageSize.mockResolvedValue(other);

    const { filename, refusal } = await freeze(s, jpeg());

    expect(refusal).toBe(sizeRefusal(filename, other, DECLARED));
    expect(images(s)).toEqual([]);
    expect(s.history.canUndo).toBe(false);
    expect(s.history.isDirty).toBe(false);
  });

  it('names a different file each time', async () => {
    // Two presses on two frames are two images, not one overwritten: the name
    // carries a fresh id rather than the service's frame id.
    const s = session();

    const first = await freeze(s, jpeg());
    const second = await freeze(s, jpeg());

    expect(second.filename).to.not.equal(first.filename);
    expect(images(s)).toHaveLength(2);
  });
});
