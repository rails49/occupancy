import { describe, it, expect, vi } from 'vitest';
import { R49Archive, MANIFEST_VERSION, type CarLabel, type ManifestData, type Point } from '@rails49/r49';
import { EditHistory } from '../src/history.js';

// No DOM here at all: history.ts is a plain module, which is the point of
// keeping it out of an element. jsdom's inability to lay out or paint costs
// this suite nothing.

function bytes(seed: number, length = 64): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed * 31 + i) % 256);
}

function emptyManifest(): ManifestData {
  return {
    version: MANIFEST_VERSION,
    layout: {
      name: 'Test Layout',
      scale: 'HO',
      calibration: { points: [] },
      sensors: [],
    },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
  } as ManifestData;
}

async function makeArchive(imageCount = 3): Promise<R49Archive> {
  const archive = new R49Archive();
  archive.setManifest(emptyManifest());
  for (let i = 0; i < imageCount; i++) {
    await archive.addImage(`img_${i}.jpg`, bytes(i + 1));
  }
  return archive;
}

function attached(archive: R49Archive, budget?: number): EditHistory {
  const history = new EditHistory(budget);
  history.attach(archive);
  return history;
}

const snapshot = (archive: R49Archive) => JSON.stringify(archive.getManifest());

describe('EditHistory', () => {
  it('starts empty and clean', async () => {
    const history = attached(await makeArchive());
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.isDirty).toBe(false);
    expect(history.undoLabel).toBeNull();
  });

  it('suppresses a mutation that changes nothing', async () => {
    const archive = await makeArchive();
    const history = attached(archive);

    await history.record('edit name', { kind: 'layout' }, () => {
      const manifest = archive.getManifest();
      manifest.layout = { ...manifest.layout, name: 'Test Layout' };
    });

    expect(history.size).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.isDirty).toBe(false);
  });

  it('undoes and redoes a layout edit', async () => {
    const archive = await makeArchive();
    const history = attached(archive);

    await history.record('edit name', { kind: 'layout' }, () => {
      const manifest = archive.getManifest();
      manifest.layout = { ...manifest.layout, name: 'Renamed' };
    });
    expect(archive.getManifest().layout.name).toBe('Renamed');
    expect(history.undoLabel).toBe('edit name');

    await history.undo();
    expect(archive.getManifest().layout.name).toBe('Test Layout');
    expect(history.redoLabel).toBe('edit name');

    await history.redo();
    expect(archive.getManifest().layout.name).toBe('Renamed');
  });

  it('restores a deleted image, bytes included', async () => {
    const archive = await makeArchive();
    const history = attached(archive);
    const original = await archive.getImage('img_1.jpg');

    await history.record('delete image', { kind: 'images' }, () => archive.removeImage('img_1.jpg'), {
      retain: ['img_1.jpg'],
    });
    expect(await archive.getImage('img_1.jpg')).toBeNull();
    expect(archive.getManifest().images.map(i => i.filename)).toEqual(['img_0.jpg', 'img_2.jpg']);

    await history.undo();
    expect(archive.getManifest().images.map(i => i.filename)).toEqual([
      'img_0.jpg',
      'img_1.jpg',
      'img_2.jpg',
    ]);
    // The manifest row is worthless without the payload it names.
    expect(await archive.getImage('img_1.jpg')).toEqual(original);

    await history.redo();
    expect(await archive.getImage('img_1.jpg')).toBeNull();
  });

  it('restores the bytes of an added image on redo, without being asked', async () => {
    // The mirror of a deletion, and the one the fuzz caught: undoing an add
    // deletes the bytes from the zip, so redo has to put them back. They are
    // still present once the mutation has run, so the entry captures them
    // itself rather than relying on the caller to predict the need.
    const archive = await makeArchive(1);
    const history = attached(archive);
    const payload = bytes(99);

    await history.record('add image', { kind: 'images' }, () => archive.addImage('new.jpg', payload));
    await history.undo();
    expect(await archive.getImage('new.jpg')).toBeNull();

    await history.redo();
    expect(await archive.getImage('new.jpg')).toEqual(payload);
  });

  it('restores camera.resolution with an images entry (#254)', async () => {
    const archive = await makeArchive(0);
    const history = attached(archive);
    const before = structuredClone(archive.getManifest().camera.resolution);

    await history.record('add image', { kind: 'images' }, () => {
      archive.getManifest().camera.resolution = { width: 8064, height: 6048 };
      return archive.addImage('new.jpg', bytes(1));
    });
    await history.undo();
    expect(archive.getManifest().camera.resolution).toEqual(before);

    await history.redo();
    expect(archive.getManifest().camera.resolution).toEqual({ width: 8064, height: 6048 });
  });

  it('warns when a removal is recorded without retaining its bytes', async () => {
    const archive = await makeArchive();
    const history = attached(archive);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await history.record('delete image', { kind: 'images' }, () => archive.removeImage('img_1.jpg'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('img_1.jpg'));
    warn.mockRestore();
  });

  it('restores an image ordering', async () => {
    const archive = await makeArchive();
    const history = attached(archive);

    await history.record('reorder images', { kind: 'images' }, () => archive.reorderImages(0, 2));
    expect(archive.getManifest().images.map(i => i.filename)).toEqual([
      'img_1.jpg',
      'img_2.jpg',
      'img_0.jpg',
    ]);

    await history.undo();
    expect(archive.getManifest().images.map(i => i.filename)).toEqual([
      'img_0.jpg',
      'img_1.jpg',
      'img_2.jpg',
    ]);
  });

  it('reports which image an entry changed, for the reveal', async () => {
    const archive = await makeArchive();
    const history = attached(archive);

    await history.record('mark complete', { kind: 'image', filename: 'img_1.jpg' }, () => {
      archive.getManifest().images[1].labeled_complete = true;
    });

    const entry = await history.undo();
    expect(entry?.target).toEqual({ kind: 'image', filename: 'img_1.jpg' });
    expect(archive.getManifest().images[1].labeled_complete).toBe(false);
  });

  it('tracks dirtiness against the save marker, and survives a save', async () => {
    const archive = await makeArchive();
    const history = attached(archive);

    await history.record('edit name', { kind: 'layout' }, () => {
      archive.getManifest().layout = { ...archive.getManifest().layout, name: 'A' };
    });
    expect(history.isDirty).toBe(true);

    history.markSaved();
    expect(history.isDirty).toBe(false);

    // Saving is not a barrier: undoing past it is legitimate, and it makes the
    // archive differ from the file on disk again.
    await history.undo();
    expect(history.isDirty).toBe(true);
    await history.redo();
    expect(history.isDirty).toBe(false);
  });

  it('discards the redo branch when a new edit is recorded', async () => {
    const archive = await makeArchive();
    const history = attached(archive);
    const rename = (name: string) =>
      history.record(`edit ${name}`, { kind: 'layout' }, () => {
        archive.getManifest().layout = { ...archive.getManifest().layout, name };
      });

    await rename('A');
    await rename('B');
    await history.undo();
    expect(history.canRedo).toBe(true);

    await rename('C');
    expect(history.canRedo).toBe(false);
    expect(history.size).toBe(2);
  });

  it('clears the stack when a different archive is attached', async () => {
    const archive = await makeArchive();
    const history = attached(archive);
    await history.record('edit name', { kind: 'layout' }, () => {
      archive.getManifest().layout = { ...archive.getManifest().layout, name: 'A' };
    });

    history.attach(await makeArchive());
    expect(history.canUndo).toBe(false);
    expect(history.size).toBe(0);
    expect(history.bytes).toBe(0);
    expect(history.isDirty).toBe(false);
  });

  it('evicts from the oldest end, truncating rather than hole-punching', async () => {
    const archive = await makeArchive();
    // A budget small enough that only the newest couple of entries survive.
    const history = attached(archive, 900);
    for (let i = 0; i < 12; i++) {
      await history.record(`edit ${i}`, { kind: 'layout' }, () => {
        archive.getManifest().layout = { ...archive.getManifest().layout, name: `name-${i}` };
      });
    }

    expect(history.size).toBeLessThan(12);
    expect(history.bytes).toBeLessThanOrEqual(900);
    expect(history.undoLabel).toBe('edit 11');

    // Whatever survives is a contiguous run ending at the newest edit: undoing
    // to the bottom must never step over a dropped entry.
    const names: string[] = [];
    while (history.canUndo) {
      await history.undo();
      names.push(archive.getManifest().layout.name!);
    }
    const expected = names.map((_, i) => `name-${10 - i}`);
    expect(names).toEqual(expected);
  });

  it('keeps the newest entry even when it alone exceeds the budget', async () => {
    const archive = await makeArchive();
    const history = attached(archive, 1);
    await history.record('edit name', { kind: 'layout' }, () => {
      archive.getManifest().layout = { ...archive.getManifest().layout, name: 'A' };
    });
    expect(history.size).toBe(1);
    expect(history.canUndo).toBe(true);
  });
});

describe('EditHistory highlights', () => {
  // What an entry changed, so the reveal after an undo can point at it. Derived
  // from the entry's own before/after snapshots, which is what makes it
  // symmetric: undo and redo touch the same objects.

  const car = (id: string, x: number): CarLabel => ({
    id,
    class: 'stock',
    provenance: 'human',
    p0: { x, y: 0 },
    p1: { x: x + 10, y: 0 },
  });

  it('names the car an image entry changed', async () => {
    const archive = await makeArchive();
    const history = attached(archive);
    const image = archive.getManifest().images[1];
    image.labels = [car('car-a', 0)];

    await history.record('place car', { kind: 'image', filename: image.filename }, () => {
      image.labels = [...image.labels, car('car-b', 100)];
    });

    expect(history.undoEntry?.highlights).toEqual([{ kind: 'car', id: 'car-b' }]);
  });

  it('names the sensor a layout entry moved', async () => {
    const archive = await makeArchive();
    const history = attached(archive);
    const manifest = archive.getManifest();
    manifest.layout = {
      ...manifest.layout,
      sensors: [
        { id: 'sensor-a', x: 10, y: 10 },
        { id: 'sensor-b', x: 20, y: 20 },
      ],
    };

    await history.record('move sensor', { kind: 'layout' }, () => {
      manifest.layout = {
        ...manifest.layout,
        sensors: [manifest.layout.sensors[0], { id: 'sensor-b', x: 90, y: 20 }],
      };
    });

    expect(history.undoEntry?.highlights).toEqual([{ kind: 'sensor', id: 'sensor-b' }]);
  });

  it('names both ends of a calibration point that moved', async () => {
    // Points carry no id, so a move is a disappearance and an appearance. Both
    // are offered and the consumer resolves them against the manifest as it
    // stands after the apply — whichever end exists then is the one on screen.
    const archive = await makeArchive();
    const history = attached(archive);
    const manifest = archive.getManifest();
    const world = { x: 0, y: 0, z: 0 };
    const points = (px: Point) => ({ points: [{ px, world }, { px: { x: 5, y: 5 }, world }] });
    manifest.layout = { ...manifest.layout, calibration: points({ x: 1, y: 1 }) };

    await history.record('move calibration point', { kind: 'layout' }, () => {
      manifest.layout = { ...manifest.layout, calibration: points({ x: 80, y: 40 }) };
    });

    expect(history.undoEntry?.highlights).toEqual([
      { kind: 'calibration', px: { x: 1, y: 1 } },
      { kind: 'calibration', px: { x: 80, y: 40 } },
    ]);
  });

  it('names one point when only its world coordinate changed', async () => {
    // The pixel is the handle, and it did not move: two refs on the same pixel
    // would be one highlight twice over.
    const archive = await makeArchive();
    const history = attached(archive);
    const manifest = archive.getManifest();
    const px = { x: 3, y: 4 };
    manifest.layout = {
      ...manifest.layout,
      calibration: { points: [{ px, world: { x: 0, y: 0, z: 0 } }] },
    };

    await history.record('edit calibration point', { kind: 'layout' }, () => {
      manifest.layout = {
        ...manifest.layout,
        calibration: { points: [{ px, world: { x: 250, y: 0, z: 0 } }] },
      };
    });

    expect(history.undoEntry?.highlights).toEqual([{ kind: 'calibration', px }]);
  });

  it('offers nothing to point at for an edit with no geometry', async () => {
    // A completeness toggle, a rename, a scale change, an image reorder: each is
    // a real entry that reveals its image, and none of them has a sub-image
    // object to light up.
    const archive = await makeArchive();
    const history = attached(archive);
    const manifest = archive.getManifest();

    await history.record('mark labeled complete', { kind: 'image', filename: 'img_0.jpg' }, () => {
      manifest.images[0].labeled_complete = true;
    });
    expect(history.undoEntry?.highlights).toEqual([]);

    await history.record('edit scale', { kind: 'layout' }, () => {
      manifest.layout = { ...manifest.layout, scale: 'N' };
    });
    expect(history.undoEntry?.highlights).toEqual([]);

    await history.record('reorder images', { kind: 'images' }, () => archive.reorderImages(0, 2));
    expect(history.undoEntry?.highlights).toEqual([]);
  });
});

describe('EditHistory gestures', () => {
  // A drag mutates continuously and must cost exactly one entry. `record` cannot
  // express that — it brackets a single mutation — so a gesture opens at
  // pointer-down, lets the caller mutate freely, and closes at pointer-up.

  /** Puts one calibration point at `x`, the way a drag moves one. */
  function moveTo(archive: R49Archive, x: number) {
    const manifest = archive.getManifest();
    manifest.layout = {
      ...manifest.layout,
      calibration: { points: [{ px: { x, y: 0 }, world: { x: 0, y: 0, z: 0 } }] },
    };
  }

  const xOf = (archive: R49Archive) => archive.getManifest().layout.calibration.points[0].px.x;

  async function withPoint(): Promise<R49Archive> {
    const archive = await makeArchive();
    moveTo(archive, 0);
    return archive;
  }

  it('records one entry for a gesture, however many times it mutated', async () => {
    const archive = await withPoint();
    const history = attached(archive);

    const gesture = history.beginGesture('move calibration point', { kind: 'layout' });
    for (const x of [10, 20, 30, 40]) moveTo(archive, x);
    expect(await gesture.commit()).toBe(true);

    expect(history.size).toBe(1);
    expect(history.undoLabel).toBe('move calibration point');

    await history.undo();
    expect(xOf(archive)).toBe(0);
    await history.redo();
    expect(xOf(archive)).toBe(40);
  });

  it('records nothing when the gesture ends where it started', async () => {
    const archive = await withPoint();
    const history = attached(archive);

    const gesture = history.beginGesture('move calibration point', { kind: 'layout' });
    moveTo(archive, 250);
    moveTo(archive, 0);
    expect(await gesture.commit()).toBe(false);

    expect(history.size).toBe(0);
    expect(history.isDirty).toBe(false);
  });

  it('refuses undo and redo while a gesture is open', async () => {
    // The gesture has already mutated the manifest outside the stack. An undo
    // landing mid-drag would apply an older snapshot over it, and the commit
    // that follows would then compare against a `before` that never existed.
    const archive = await withPoint();
    const history = attached(archive);
    await history.record('edit name', { kind: 'layout' }, () => {
      archive.getManifest().layout = { ...archive.getManifest().layout, name: 'Renamed' };
    });

    const gesture = history.beginGesture('move calibration point', { kind: 'layout' });
    expect(await history.undo()).toBeNull();
    expect(archive.getManifest().layout.name).toBe('Renamed');

    await gesture.commit();
    expect(await history.undo()).not.toBeNull();
    expect(archive.getManifest().layout.name).toBe('Test Layout');
    expect(await history.redo()).not.toBeNull();
  });

  it('ignores a second commit of the same gesture', async () => {
    // Pointer-up and pointer-cancel can both arrive for one gesture; the second
    // must not record the first one's effect a second time.
    const archive = await withPoint();
    const history = attached(archive);

    const gesture = history.beginGesture('move calibration point', { kind: 'layout' });
    moveTo(archive, 40);
    expect(await gesture.commit()).toBe(true);
    expect(await gesture.commit()).toBe(false);

    expect(history.size).toBe(1);
  });

  it('drops an open gesture when another archive is attached', async () => {
    const archive = await withPoint();
    const history = attached(archive);
    const gesture = history.beginGesture('move calibration point', { kind: 'layout' });
    moveTo(archive, 40);

    history.attach(await withPoint());
    expect(await gesture.commit()).toBe(false);
    expect(history.size).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('runs without an archive rather than throwing', async () => {
    const history = new EditHistory();
    const gesture = history.beginGesture('move calibration point', { kind: 'layout' });
    expect(await gesture.commit()).toBe(false);
  });
});

describe('EditHistory round-trip', () => {
  // Undo and redo are one operation with the fields swapped, so there is no
  // inverse to author and no inverse to get wrong. The only class of bug scoped
  // snapshots admit is a mis-declared target — an entry that says `layout` and
  // touches an image. This is the test that hunts it.

  /** Deterministic LCG, so a failure is reproducible from the seed alone. */
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  async function fingerprint(archive: R49Archive): Promise<string> {
    const manifest = archive.getManifest();
    const payload: string[] = [];
    for (const image of manifest.images) {
      const data = await archive.getImage(image.filename);
      payload.push(`${image.filename}:${data ? data.length : 'missing'}`);
    }
    return `${JSON.stringify(manifest)}|${payload.join(',')}`;
  }

  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`undoes an arbitrary edit sequence back to the loaded state (seed ${seed})`, async () => {
      const archive = await makeArchive(4);
      const history = attached(archive);
      const random = rng(seed);
      const start = await fingerprint(archive);

      let added = 0;
      for (let step = 0; step < 40; step++) {
        const manifest = archive.getManifest();
        const images = manifest.images;
        const pick = Math.floor(random() * 5);

        if (pick === 0) {
          const filename = `added_${added++}.jpg`;
          await history.record('add image', { kind: 'images' }, () =>
            archive.addImage(filename, bytes(added + 100))
          );
        } else if (pick === 1 && images.length > 1) {
          const filename = images[Math.floor(random() * images.length)].filename;
          await history.record('delete image', { kind: 'images' }, () => archive.removeImage(filename), {
            retain: [filename],
          });
        } else if (pick === 2 && images.length > 1) {
          const from = Math.floor(random() * images.length);
          const to = Math.floor(random() * images.length);
          await history.record('reorder images', { kind: 'images' }, () =>
            archive.reorderImages(from, to)
          );
        } else if (pick === 3) {
          await history.record('edit layout', { kind: 'layout' }, () => {
            manifest.layout = { ...manifest.layout, name: `layout-${step}` };
          });
        } else if (images.length > 0) {
          const index = Math.floor(random() * images.length);
          const image = images[index];
          await history.record('label car', { kind: 'image', filename: image.filename }, () => {
            image.labels = [
              ...image.labels,
              {
                id: `label-${step}`,
                class: 'stock',
                p0: { x: step, y: step },
                p1: { x: step + 10, y: step + 4 },
                provenance: 'human',
              },
            ];
            image.labeled_complete = step % 3 === 0;
          });
        }
      }

      const end = await fingerprint(archive);
      expect(end).not.toBe(start);

      while (history.canUndo) await history.undo();
      expect(await fingerprint(archive)).toBe(start);

      while (history.canRedo) await history.redo();
      expect(await fingerprint(archive)).toBe(end);
    });
  }

  it('does not round-trip when an entry declares the wrong target', async () => {
    // Executable statement of the one hazard scoped snapshots carry: the entry
    // below claims to cover `layout` while mutating an image, so its snapshot
    // captures nothing of what changed and undo restores nothing. Callers must
    // declare the subtree they actually touch.
    const archive = await makeArchive();
    const history = attached(archive);
    const before = snapshot(archive);

    await history.record('mislabelled', { kind: 'layout' }, () => {
      archive.getManifest().images[0].labeled_complete = true;
    });

    await history.undo();
    expect(snapshot(archive)).not.toBe(before);
    expect(archive.getManifest().images[0].labeled_complete).toBe(true);
  });
});
