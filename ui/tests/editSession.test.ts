import { describe, it, expect, vi } from 'vitest';
import { R49Archive, MANIFEST_VERSION, getDPT } from '@rails49/r49';
import type { ReferencePoint, CarLabel, ManifestData, Point, Sensor } from '@rails49/r49';
import { ALREADY_LABELED, EditSession } from '../src/editSession.js';
import type { Reveal } from '../src/editSession.js';
import { TOOLS } from '../src/tools.js';
import type { EditorTool } from '../src/tools.js';
import { classChoices, rootClass } from '../src/vocabulary.js';

// No DOM: the session is a plain module, driven here the way the editor drives
// it, with image-pixel points and the screen scale of the pointer event.

/** Image pixels per screen pixel: the unzoomed scale, unless a test says otherwise. */
const SCALE = 1;

/** Two reference points at a nonzero separation: DPT 89.7, so the gate is open. */
const CALIBRATION: readonly ReferencePoint[] = [
  { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
  { px: { x: 100, y: 0 }, world: { x: 10, y: 0, z: 0 } },
];

type HumanCar = Extract<CarLabel, { provenance: 'human' }>;

function manifest(filenames: readonly string[], calibrated: boolean): ManifestData {
  return {
    version: MANIFEST_VERSION,
    layout: {
      name: 'Test Layout',
      scale: 'N',
      calibration: { points: calibrated ? structuredClone([...CALIBRATION]) : [] },
      sensors: [],
    },
    camera: { resolution: { width: 2000, height: 2000 } },
    images: filenames.map(filename => ({ filename, labeled_complete: false, labels: [] })),
  };
}

/**
 * A session on an archive whose images have no bytes: enough for everything
 * except adding and deleting images, which use {@link withBytes}.
 */
function session({
  images = ['img1.jpg'],
  calibrated = true,
  tool,
}: {
  images?: readonly string[];
  calibrated?: boolean;
  tool?: EditorTool;
} = {}): EditSession {
  const archive = new R49Archive();
  archive.setManifest(manifest(images, calibrated));
  const s = new EditSession(archive);
  if (tool) s.selectTool(tool);
  return s;
}

/** A calibrated session whose images carry bytes. */
async function withBytes(filenames: readonly string[]): Promise<EditSession> {
  const archive = new R49Archive();
  archive.setManifest(manifest([], true));
  for (const [i, filename] of filenames.entries()) {
    await archive.addImage(filename, Uint8Array.from([i + 1, 2, 3]));
  }
  return new EditSession(archive);
}

function points(s: EditSession): ReferencePoint[] {
  return s.archive.getManifest().layout.calibration.points;
}

function sensors(s: EditSession): Sensor[] {
  return s.archive.getManifest().layout.sensors;
}

/** The cars on an image, by filename; the first image by default. */
function cars(s: EditSession, filename?: string): CarLabel[] {
  const images = s.archive.getManifest().images;
  return (filename ? images.find(image => image.filename === filename) : images[0])!.labels;
}

function seedPoints(s: EditSession, ...pixels: readonly Point[]) {
  s.archive.getManifest().layout.calibration.points = pixels.map((px, i) => ({
    px,
    world: { x: i * 10, y: 0, z: 0 },
  }));
}

function seedCar(s: EditSession, over: Partial<HumanCar> = {}): HumanCar {
  const car: HumanCar = {
    id: 'C1abcdefghi',
    class: 'stock',
    provenance: 'human',
    p0: { x: 100, y: 100 },
    p1: { x: 400, y: 100 },
    ...over,
  };
  s.archive.getManifest().images[0].labels.push(car);
  return car;
}

async function clicks(s: EditSession, ...at: Point[]) {
  for (const point of at) await s.click(point, SCALE);
}

/** A drag along `path`, ended. Returns whether anything was grabbed. */
async function drag(s: EditSession, path: readonly Point[], scale = SCALE): Promise<boolean> {
  const d = s.beginDrag(path[0], scale);
  if (!d) return false;
  for (const point of path.slice(1)) d.move(point);
  await d.end();
  return true;
}

/** Cars chained end to end along y, one per pair of neighbouring xs, then the chain ended. */
async function train(s: EditSession, xs: readonly number[], y = 100) {
  await clicks(s, ...xs.map(x => ({ x, y })));
  s.endChain();
}

describe('EditSession', () => {
  describe('the tool and the calibration gate', () => {
    it('opens on calibration, with an uncalibrated archive gated', () => {
      const s = session({ calibrated: false });
      expect(s.tool).toBe('calibration');
      expect(s.calibrated).toBe(false);
    });

    it('opens on calibration for a calibrated archive too', () => {
      expect(session().tool).toBe('calibration');
    });

    it('opens the gate the moment a second point resolves DPT', async () => {
      const s = session({ calibrated: false });

      await s.placeReferencePoint({ x: 0, y: 0 }, { x: 0, y: 0, z: 0 });
      expect(s.calibrated).toBe(false);

      await s.placeReferencePoint({ x: 100, y: 0 }, { x: 10, y: 0, z: 0 });
      expect(s.calibrated).toBe(true);
    });

    it('stays gated for two points at the same position', () => {
      const s = session({ calibrated: false });
      const point = { px: { x: 50, y: 50 }, world: { x: 0, y: 0, z: 0 } };
      s.archive.getManifest().layout.calibration.points = [point, structuredClone(point)];
      expect(s.calibrated).toBe(false);
    });

    it('drops a gated tool back to calibration when DPT stops resolving', async () => {
      const s = session({ tool: 'sensor' });

      const subject = s.rightClick({ x: 100, y: 0 }, SCALE)!;
      await s.delete(subject);

      expect(s.calibrated).toBe(false);
      expect(s.tool).toBe('calibration');
      // A click now asks for a reference point rather than placing nothing.
      expect(await s.click({ x: 400, y: 400 }, SCALE)).toEqual({
        kind: 'place-reference-point',
        px: { x: 400, y: 400 },
      });
      expect(sensors(s)).toHaveLength(0);
    });

    it('keeps calibration when a gated tool is chosen without DPT, and authors no car', async () => {
      const s = session({ calibrated: false, tool: 'car' });

      expect(s.tool).toBe('calibration');
      expect(await s.click({ x: 100, y: 100 }, SCALE)).toMatchObject({
        kind: 'place-reference-point',
      });
      expect(cars(s)).toHaveLength(0);
    });

    it('gates each tool by its needsDpt in tools.ts', async () => {
      // A tool that needs no DPT stays live on an uncalibrated archive.
      const sensor = TOOLS.find(spec => spec.tool === 'sensor') as { needsDpt: boolean };
      sensor.needsDpt = false;
      try {
        const s = session({ calibrated: false, tool: 'sensor' });

        expect(s.tool).toBe('sensor');
        await s.click({ x: 300, y: 300 }, SCALE);
        expect(sensors(s)).toHaveLength(1);
      } finally {
        sensor.needsDpt = true;
      }
    });
  });

  describe('reference points', () => {
    it('asks for the world position of a click on empty image, writing nothing yet', async () => {
      const s = session({ calibrated: false });

      expect(await s.click({ x: 120.4, y: 200.6 }, SCALE)).toEqual({
        kind: 'place-reference-point',
        px: { x: 120, y: 201 },
      });
      expect(points(s)).toHaveLength(0);
      expect(s.history.size).toBe(0);
    });

    it('writes a point as one layout entry, and undo reverses it', async () => {
      const s = session({ calibrated: false });

      await s.placeReferencePoint({ x: 10, y: 10 }, { x: 0, y: 0, z: 0 });
      await s.placeReferencePoint({ x: 110, y: 10 }, { x: 10, y: 0, z: 0 });

      expect(points(s)).toEqual([
        { px: { x: 10, y: 10 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 110, y: 10 }, world: { x: 10, y: 0, z: 0 } },
      ]);
      expect(s.history.size).toBe(2);
      expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });
      expect(s.history.undoLabel).toContain('calibration');

      await s.undo();
      expect(points(s)).toHaveLength(1);
      await s.redo();
      expect(points(s)).toHaveLength(2);
    });

    it('asks to edit the point under a click rather than stacking another on it', async () => {
      const s = session({ calibrated: false });
      seedPoints(s, { x: 100, y: 100 });

      // Inside the grab radius.
      expect(await s.click({ x: 105, y: 103 }, SCALE)).toEqual({
        kind: 'edit-reference-point',
        index: 0,
        px: { x: 100, y: 100 },
        world: { x: 0, y: 0, z: 0 },
      });

      await s.editReferencePoint(0, { x: 100, y: 100 }, { x: 0, y: 250, z: 0 });
      expect(points(s)).toEqual([{ px: { x: 100, y: 100 }, world: { x: 0, y: 250, z: 0 } }]);
      expect(s.history.size).toBe(1);

      await s.undo();
      expect(points(s)[0].world).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('asks to place a new point for a click beyond the grab radius', async () => {
      const s = session({ calibrated: false });
      seedPoints(s, { x: 100, y: 100 });

      expect(await s.click({ x: 300, y: 300 }, SCALE)).toMatchObject({
        kind: 'place-reference-point',
      });
    });

    it('scales the grab radius with the screen scale', async () => {
      const s = session({ calibrated: false });
      seedPoints(s, { x: 100, y: 100 });

      // 40 image px away: outside the radius at 1:1, inside it at four image px per screen px.
      expect((await s.click({ x: 140, y: 100 }, 1)).kind).toBe('place-reference-point');
      expect((await s.click({ x: 140, y: 100 }, 4)).kind).toBe('edit-reference-point');
    });

    it('drops an edit whose point moved after the dialog opened', async () => {
      const s = session({ calibrated: false });
      seedPoints(s, { x: 100, y: 100 }, { x: 400, y: 100 });
      const layout = s.archive.getManifest().layout;

      // An undo removes the first point while the dialog is open on the second.
      layout.calibration = { points: [layout.calibration.points[1]] };
      await s.editReferencePoint(1, { x: 400, y: 100 }, { x: 999, y: 999, z: 999 });

      expect(points(s)).toEqual([{ px: { x: 400, y: 100 }, world: { x: 10, y: 0, z: 0 } }]);
    });

    it('round-trips through a save and reopen', async () => {
      const s = session({ calibrated: false });
      await s.placeReferencePoint({ x: 0, y: 0 }, { x: 0, y: 0, z: 0 });
      await s.placeReferencePoint({ x: 100, y: 0 }, { x: 10, y: 0, z: 0 });

      const reopened = await R49Archive.load(await s.archive.export());

      expect(reopened.getManifest().layout.calibration.points).toEqual(points(s));
      expect(getDPT(reopened.getManifest())).toBe(getDPT(s.archive.getManifest()));
    });

    describe('dragging', () => {
      it('moves the point that was grabbed, keeping the grab offset', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        await drag(s, [
          { x: 103, y: 102 },
          { x: 150, y: 150 },
          { x: 203, y: 202 },
        ]);

        expect(points(s)[0].px).toEqual({ x: 200, y: 200 });
      });

      it('writes one entry however many moves there were', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        const path: Point[] = [{ x: 100, y: 100 }];
        for (let i = 1; i <= 200; i++) path.push({ x: 100 + i, y: 100 });
        await drag(s, path);

        expect(points(s)[0].px).toEqual({ x: 300, y: 100 });
        expect(s.history.size).toBe(1);
        expect(s.history.undoLabel).toContain('calibration');
        expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });

        await s.undo();
        expect(points(s)[0].px).toEqual({ x: 100, y: 100 });
        await s.redo();
        expect(points(s)[0].px).toEqual({ x: 300, y: 100 });
      });

      it('writes the manifest on every move, before the drag ends', () => {
        const s = session();
        const d = s.beginDrag({ x: 100, y: 0 }, SCALE)!;

        d.move({ x: 200, y: 0 });

        expect(points(s)[1].px).toEqual({ x: 200, y: 0 });
        expect(getDPT(s.archive.getManifest())).toBeCloseTo(179.4, 1);
        expect(s.history.size).toBe(0);
      });

      it('writes nothing for a drag returned to its origin', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        await drag(s, [
          { x: 100, y: 100 },
          { x: 400, y: 250 },
          { x: 100, y: 100 },
        ]);

        expect(points(s)[0].px).toEqual({ x: 100, y: 100 });
        expect(s.history.size).toBe(0);
        expect(s.history.isDirty).toBe(false);
      });

      it('writes a drag that ends outside the image', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        await drag(s, [
          { x: 100, y: 100 },
          { x: -400, y: -300 },
        ]);

        expect(points(s)[0].px).toEqual({ x: -400, y: -300 });
        expect(s.history.size).toBe(1);
      });

      it('puts the point back and writes nothing when cancelled', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        const d = s.beginDrag({ x: 100, y: 100 }, SCALE)!;
        d.move({ x: 400, y: 250 });
        await d.cancel();

        expect(points(s)[0].px).toEqual({ x: 100, y: 100 });
        expect(s.history.size).toBe(0);
        expect(s.history.canUndo).toBe(false);
      });

      it('grabs nothing on empty image', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        expect(s.beginDrag({ x: 600, y: 600 }, SCALE)).toBeNull();
        expect(points(s)[0].px).toEqual({ x: 100, y: 100 });
      });

      it('starts no second drag while one is open', () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 }, { x: 500, y: 500 });

        expect(s.beginDrag({ x: 100, y: 100 }, SCALE)).not.toBeNull();
        expect(s.beginDrag({ x: 500, y: 500 }, SCALE)).toBeNull();
      });

      it('grabs at the same screen distance at every scale', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });
        const path = [
          { x: 120, y: 100 },
          { x: 220, y: 100 },
        ];

        // 20 image px is 40 screen px at 0.5, outside the radius, and 10 at 2, inside it.
        expect(await drag(s, path, 0.5)).toBe(false);
        expect(await drag(s, path, 2)).toBe(true);
        expect(points(s)[0].px).toEqual({ x: 200, y: 100 });
        expect(s.history.size).toBe(1);
      });
    });

    describe('the menu', () => {
      it('acts on the point under a right-click', () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 });

        expect(s.rightClick({ x: 103, y: 101 }, SCALE)).toEqual({
          kind: 'calibration',
          index: 0,
          px: { x: 100, y: 100 },
        });
        expect(s.rightClick({ x: 500, y: 500 }, SCALE)).toBeNull();
      });

      it('deletes the point as one layout entry, and undo restores it', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 }, { x: 400, y: 100 });
        const before = structuredClone(points(s));

        await s.delete(s.rightClick({ x: 400, y: 100 }, SCALE)!);

        expect(points(s)).toEqual([before[0]]);
        expect(s.history.undoLabel).toContain('calibration');
        expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });

        await s.undo();
        expect(points(s)).toEqual(before);
        await s.redo();
        expect(points(s)).toEqual([before[0]]);
      });

      it('drops a delete whose point moved after the menu opened', async () => {
        const s = session({ calibrated: false });
        seedPoints(s, { x: 100, y: 100 }, { x: 400, y: 100 });
        const layout = s.archive.getManifest().layout;

        const subject = s.rightClick({ x: 400, y: 100 }, SCALE)!;
        layout.calibration = { points: [layout.calibration.points[1]] };
        await s.delete(subject);

        expect(points(s)).toEqual([{ px: { x: 400, y: 100 }, world: { x: 10, y: 0, z: 0 } }]);
      });
    });
  });

  describe('sensors', () => {
    it('places an unnamed sensor at the clicked pixel, with a snowflake id', async () => {
      const s = session({ tool: 'sensor' });

      // A sensor needs nothing from the editor.
      expect(await s.click({ x: 320.4, y: 240.6 }, SCALE)).toEqual({ kind: 'none' });

      expect(sensors(s)).toHaveLength(1);
      const [sensor] = sensors(s);
      expect(sensor).toMatchObject({ x: 320, y: 241 });
      expect(sensor.name).toBeUndefined();
      expect(sensor.id).toHaveLength(11);
    });

    it('gives every sensor its own id', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 100, y: 400 }, { x: 200, y: 400 }, { x: 300, y: 400 });
      expect(new Set(sensors(s).map(sensor => sensor.id)).size).toBe(3);
    });

    it('writes one layout entry per sensor, and undo reverses it', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });

      expect(s.history.size).toBe(1);
      expect(s.history.undoLabel).toContain('sensor');
      expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });

      await s.undo();
      expect(sensors(s)).toHaveLength(0);
      await s.redo();
      expect(sensors(s)).toHaveLength(1);
    });

    it('asks for the name of a sensor under a click, whatever the tool', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });
      s.selectTool('calibration');

      expect(await s.click({ x: 322, y: 241 }, SCALE)).toEqual({
        kind: 'name-sensor',
        id: sensors(s)[0].id,
        name: null,
      });
      expect(points(s)).toHaveLength(2);
    });

    it('grabs a sensor anywhere on the symbol it is drawn as', async () => {
      // At DPT 89.7 the symbol is about 90 image px across, wider than the grab radius.
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 600, y: 400 });

      expect((await s.click({ x: 640, y: 400 }, SCALE)).kind).toBe('name-sensor');
      expect(sensors(s)).toHaveLength(1);
    });

    it('names a sensor as one layout entry, and undo removes the name', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });
      const { id } = sensors(s)[0];

      await s.nameSensor(id, 'Yard throat');
      expect(sensors(s)[0].name).toBe('Yard throat');
      expect(s.history.undoLabel).toContain('sensor');

      await s.undo();
      expect(sensors(s)[0].name).toBeUndefined();
    });

    it('removes the name key for a blank name', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });
      const { id } = sensors(s)[0];

      await s.nameSensor(id, 'Yard throat');
      await s.nameSensor(id, null);

      expect('name' in sensors(s)[0]).toBe(false);
    });

    it('writes nothing for a name that did not change', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });
      const { id } = sensors(s)[0];
      await s.nameSensor(id, 'Yard throat');
      const size = s.history.size;

      await s.nameSensor(id, 'Yard throat');

      expect(s.history.size).toBe(size);
    });

    it('drops a name for a sensor that is gone', async () => {
      const s = session({ tool: 'sensor' });
      await s.nameSensor('S1abcdefghi', 'Yard throat');
      expect(s.history.size).toBe(0);
    });

    it('drags a sensor as one layout entry, keeping its id and name', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });
      const { id } = sensors(s)[0];
      await s.nameSensor(id, 'Yard throat');
      const size = s.history.size;
      const before = structuredClone(points(s));

      await drag(s, [
        { x: 323, y: 242 },
        { x: 400, y: 300 },
        { x: 423, y: 342 },
      ]);

      expect(sensors(s)[0]).toEqual({ id, x: 420, y: 340, name: 'Yard throat' });
      expect(s.history.size).toBe(size + 1);
      expect(s.history.undoLabel).toContain('sensor');
      expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });
      expect(points(s)).toEqual(before);

      await s.undo();
      expect(sensors(s)[0]).toMatchObject({ x: 320, y: 240 });
    });

    it('drags whichever object is nearest, whatever the tool', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });

      await drag(s, [
        { x: 100, y: 0 },
        { x: 150, y: 50 },
      ]);

      expect(points(s)[1].px).toEqual({ x: 150, y: 50 });
      expect(sensors(s)[0]).toMatchObject({ x: 320, y: 240 });
    });

    it('deletes a sensor from the menu, and undo restores it whole', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 }, { x: 500, y: 240 });
      const before = structuredClone(sensors(s));

      const subject = s.rightClick({ x: 320, y: 240 }, SCALE)!;
      expect(subject).toEqual({ kind: 'sensor', id: before[0].id });
      await s.delete(subject);

      expect(sensors(s)).toEqual([before[1]]);
      expect(s.history.undoLabel).toContain('sensor');

      await s.undo();
      expect(sensors(s)).toEqual(before);
    });

    it('survives a save and reopen', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 240 });
      await s.nameSensor(sensors(s)[0].id, 'Yard throat');

      const reopened = await R49Archive.load(await s.archive.export());

      expect(reopened.getManifest().layout.sensors).toEqual(sensors(s));
    });
  });

  describe('cars', () => {
    it('writes a car from two clicks on its ends, the first writing nothing', async () => {
      const s = session({ tool: 'car' });

      await clicks(s, { x: 200.4, y: 300.6 });
      expect(cars(s)).toHaveLength(0);
      expect(s.history.size).toBe(0);

      await clicks(s, { x: 500, y: 300 });

      expect(cars(s)).toHaveLength(1);
      expect(cars(s)[0]).toMatchObject({ p0: { x: 200, y: 301 }, p1: { x: 500, y: 300 } });
    });

    it('writes a human-authored car at the taxonomy root', async () => {
      const s = session({ tool: 'car' });
      await clicks(s, { x: 200, y: 300 }, { x: 500, y: 300 });

      const [car] = cars(s);
      expect(car.class).toBe(rootClass());
      expect(car.provenance).toBe('human');
      expect('proposed_by' in car).toBe(false);
      expect(car.id).toHaveLength(11);
    });

    it('gives every car its own id', async () => {
      const s = session({ tool: 'car' });
      for (const y of [100, 400, 700]) await train(s, [100, 400], y);

      expect(new Set(cars(s).map(car => car.id)).size).toBe(3);
    });

    it('writes one entry per car, on the image it is on', async () => {
      const s = session({ tool: 'car' });
      await clicks(s, { x: 200, y: 300 }, { x: 500, y: 300 });

      expect(s.history.size).toBe(1);
      expect(s.history.undoLabel).toContain('car');
      expect(s.history.undoEntry!.target).toEqual({ kind: 'image', filename: 'img1.jpg' });
    });

    it('writes nothing for a car abandoned by a tool change', async () => {
      const s = session({ tool: 'car' });

      await clicks(s, { x: 200, y: 300 });
      s.selectTool('sensor');
      await clicks(s, { x: 500, y: 300 });

      expect(cars(s)).toHaveLength(0);
      expect(sensors(s)).toHaveLength(1);
      expect(s.history.size).toBe(1);
    });

    it('ends a chain on right-click, writing nothing and naming no menu subject', async () => {
      const s = session({ tool: 'car' });
      await clicks(s, { x: 200, y: 300 });

      expect(s.rightClick({ x: 500, y: 300 }, SCALE)).toBeNull();
      expect(s.anchor).toBeNull();
      expect(s.history.size).toBe(0);

      await clicks(s, { x: 600, y: 600 }, { x: 800, y: 600 });
      expect(cars(s)[0].p0).toEqual({ x: 600, y: 600 });
    });

    it('completes a car on a second click that lands on another object', async () => {
      const s = session({ tool: 'car' });

      await clicks(s, { x: 200, y: 300 });
      // (100, 0) is a reference point.
      expect(await s.click({ x: 100, y: 0 }, SCALE)).toEqual({ kind: 'none' });

      expect(cars(s)).toHaveLength(1);
      expect(cars(s)[0].p1).toEqual({ x: 100, y: 0 });
    });

    describe('a click on a car already labeled (#43)', () => {
      it('refuses a click on its body, with a notice', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        const size = s.history.size;

        expect(await s.click({ x: 250, y: 100 }, SCALE)).toEqual({
          kind: 'notice',
          message: ALREADY_LABELED,
        });
        expect(cars(s)).toHaveLength(1);
        expect(s.anchor).toBeNull();
        expect(s.history.size).toBe(size);
      });

      it('refuses a click on one of its ends with the same notice', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        expect(await s.click({ x: 400, y: 100 }, SCALE)).toEqual({
          kind: 'notice',
          message: ALREADY_LABELED,
        });
        expect(s.anchor).toBeNull();
        expect(cars(s)).toHaveLength(1);
      });

      it('says nothing about a car end under another tool', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        s.selectTool('sensor');

        expect(await s.click({ x: 400, y: 100 }, SCALE)).toEqual({ kind: 'none' });
      });

      it('starts a chain outside every car', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        await clicks(s, { x: 250, y: 400 });
        expect(s.anchor).toEqual({ x: 250, y: 400 });
        await clicks(s, { x: 600, y: 400 });
        expect(cars(s)).toHaveLength(2);
      });

      it('lets a live chain end its next car inside an existing car', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        await clicks(s, { x: 250, y: 400 }, { x: 250, y: 100 });

        expect(cars(s)).toHaveLength(2);
        expect(cars(s)[1].p1).toEqual({ x: 250, y: 100 });
      });

      it('lets an end be dragged into another car', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        await train(s, [250, 600], 400);

        await drag(s, [
          { x: 600, y: 400 },
          { x: 300, y: 100 },
          { x: 250, y: 100 },
        ]);

        expect(cars(s)[1].p1).toEqual({ x: 250, y: 100 });
      });

      it('edits an archive whose cars already overlap', async () => {
        const s = session({ tool: 'car' });
        seedCar(s, { id: 'aaaaaaaaaaa' });
        seedCar(s, { id: 'bbbbbbbbbbb', p0: { x: 150, y: 100 }, p1: { x: 450, y: 100 } });

        await drag(s, [
          { x: 450, y: 100 },
          { x: 470, y: 100 },
        ]);

        expect(cars(s)[1].p1).toEqual({ x: 470, y: 100 });
      });
    });

    describe('chaining a train', () => {
      it('makes every click after the first one car\'s end and the next car\'s start', async () => {
        const s = session({ tool: 'car' });

        await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 700, y: 100 }, { x: 1000, y: 100 });

        expect(cars(s)).toHaveLength(3);
        expect(cars(s)[0].p1).toEqual({ x: 400, y: 100 });
        expect(cars(s)[0].p1).toEqual(cars(s)[1].p0);
        expect(cars(s)[1].p1).toEqual(cars(s)[2].p0);
      });

      it('couples a chain drawn along a diagonal, pixel for pixel', async () => {
        const s = session({ tool: 'car' });

        await clicks(s, { x: 100.4, y: 100.6 }, { x: 240.5, y: 180.5 }, { x: 390.2, y: 260.7 });

        expect(cars(s)[0].p1).toEqual(cars(s)[1].p0);
        expect(cars(s)[1].p0).toEqual({ x: 241, y: 181 });
      });

      it('writes one entry per car, never one for the train', async () => {
        const s = session({ tool: 'car' });
        await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 700, y: 100 });
        expect(s.history.size).toBe(2);
      });

      it('moves the anchor to the coupling each click makes', async () => {
        const s = session({ tool: 'car' });
        expect(s.anchor).toBeNull();

        await clicks(s, { x: 100, y: 100 });
        expect(s.anchor).toEqual({ x: 100, y: 100 });

        await clicks(s, { x: 400, y: 100 });
        expect(s.anchor).toEqual({ x: 400, y: 100 });
      });

      it('keeps the cars when the chain ends, and starts a new train on the next click', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        expect(s.anchor).toBeNull();
        expect(cars(s)).toHaveLength(1);
        expect(s.history.size).toBe(1);

        await clicks(s, { x: 100, y: 500 }, { x: 400, y: 500 });
        expect(cars(s)[1].p0).toEqual({ x: 100, y: 500 });
      });

      it('writes no car for a second click on the anchor, and keeps the chain', async () => {
        const s = session({ tool: 'car' });

        await clicks(s, { x: 200, y: 200 }, { x: 200, y: 200 });
        expect(cars(s)).toHaveLength(0);
        expect(s.history.size).toBe(0);

        await clicks(s, { x: 500, y: 200 });
        expect(cars(s)[0].p0).toEqual({ x: 200, y: 200 });
      });

      it('leaves the manifest untouched for a chain that never got a second click', async () => {
        const s = session({ tool: 'car' });
        const before = structuredClone(s.archive.getManifest());

        await clicks(s, { x: 200, y: 200 });
        s.endChain();

        expect(s.archive.getManifest()).toEqual(before);
        expect(s.history.canUndo).toBe(false);
      });

      describe('undo while the chain is live', () => {
        it('takes one car and moves the anchor back to where it started', async () => {
          const s = session({ tool: 'car' });
          await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 700, y: 100 });

          await s.undo();

          expect(cars(s)).toHaveLength(1);
          expect(s.history.canRedo).toBe(true);
          expect(s.anchor).toEqual({ x: 400, y: 100 });

          await clicks(s, { x: 700, y: 400 });
          expect(cars(s)).toHaveLength(2);
          expect(cars(s)[1].p0).toEqual({ x: 400, y: 100 });
        });

        it('walks a whole chain back, one car at a time', async () => {
          const s = session({ tool: 'car' });
          await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 700, y: 100 });

          await s.undo();
          await s.undo();

          expect(cars(s)).toHaveLength(0);
          expect(s.anchor).toEqual({ x: 100, y: 100 });
        });

        it('stops at the chain\'s start: it ends the chain and undoes nothing', async () => {
          const s = session({ tool: 'car' });
          await train(s, [100, 400]);
          await clicks(s, { x: 100, y: 500 });

          await s.undo();

          expect(s.anchor).toBeNull();
          expect(cars(s)).toHaveLength(1);
          expect(s.history.size).toBe(1);
          expect(s.history.canRedo).toBe(false);
        });

        it('undoes from the history once the chain has ended', async () => {
          const s = session({ tool: 'car' });
          await train(s, [100, 400]);

          await s.undo();

          expect(cars(s)).toHaveLength(0);
        });

        it('leaves the anchor where it is when the undo reversed something else', async () => {
          const s = session({ tool: 'car' });
          await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 });
          await drag(s, [
            { x: 100, y: 0 },
            { x: 120, y: 40 },
          ]);

          await s.undo();

          expect(points(s)[1].px).toEqual({ x: 100, y: 0 });
          expect(cars(s)).toHaveLength(1);
          expect(s.anchor).toEqual({ x: 400, y: 100 });
        });
      });
    });

    describe('the shared coupler handle', () => {
      it('drags both cars of a coupling as one entry, keeping them coupled', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400, 700, 1000]);
        const size = s.history.size;

        await drag(s, [
          { x: 400, y: 100 },
          { x: 450, y: 220 },
        ]);

        expect(cars(s)[0].p1).toEqual({ x: 450, y: 220 });
        expect(cars(s)[1].p0).toEqual({ x: 450, y: 220 });
        expect(s.history.size).toBe(size + 1);
        expect(s.history.undoLabel).toBe('move coupler');
      });

      it('names one car at a coupling, the first in scene order', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400, 700, 1000]);
        const [first] = structuredClone(cars(s));

        const subject = s.rightClick({ x: 400, y: 100 }, SCALE)!;
        expect(subject).toEqual({ kind: 'car', id: first.id });

        await s.delete(subject);
        expect(cars(s)).toHaveLength(2);
      });

      it('deletes the middle car of a train through its body, leaving two', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400, 700, 1000]);
        const [first, middle, last] = structuredClone(cars(s));

        await s.delete(s.rightClick({ x: 550, y: 100 }, SCALE)!);

        expect(cars(s)).toEqual([first, last]);
        expect(s.history.undoEntry!.target).toEqual({ kind: 'image', filename: 'img1.jpg' });

        await s.undo();
        expect(cars(s)).toEqual([first, middle, last]);
      });

      it('names one car where three ends meet, and reaches the others by body', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400, 700, 1000]);
        // A fourth car chained into the joint from below.
        await clicks(s, { x: 400, y: 400 }, { x: 400, y: 100 });
        s.endChain();

        expect(s.rightClick({ x: 400, y: 100 }, SCALE)?.kind).toBe('car');

        await s.delete(s.rightClick({ x: 400, y: 300 }, SCALE)!);
        expect(cars(s)).toHaveLength(3);
        expect(cars(s).every(car => car.p0.y === 100 && car.p1.y === 100)).toBe(true);
      });
    });

    describe('dragging an end', () => {
      it('moves the end that was grabbed, keeping the grab offset', async () => {
        const s = session({ tool: 'car' });
        seedCar(s);

        await drag(s, [
          { x: 103, y: 102 },
          { x: 200, y: 150 },
          { x: 203, y: 202 },
        ]);

        expect(cars(s)[0].p0).toEqual({ x: 200, y: 200 });
        expect(cars(s)[0].p1).toEqual({ x: 400, y: 100 });
      });

      it('writes one entry, on the image, keeping the label whole', async () => {
        const s = session({ tool: 'car' });
        seedCar(s);

        const path: Point[] = [{ x: 400, y: 100 }];
        for (let i = 1; i <= 100; i++) path.push({ x: 400 + i, y: 100 });
        await drag(s, path);

        expect(cars(s)[0]).toEqual({
          id: 'C1abcdefghi',
          class: 'stock',
          provenance: 'human',
          p0: { x: 100, y: 100 },
          p1: { x: 500, y: 100 },
        });
        expect(s.history.size).toBe(1);
        expect(s.history.undoLabel).toBe('move car endpoint');
        expect(s.history.undoEntry!.target).toEqual({ kind: 'image', filename: 'img1.jpg' });

        await s.undo();
        expect(cars(s)[0].p1).toEqual({ x: 400, y: 100 });
      });

      it('writes nothing for a drag returned to its origin', async () => {
        const s = session({ tool: 'car' });
        seedCar(s);

        await drag(s, [
          { x: 100, y: 100 },
          { x: 300, y: 300 },
          { x: 100, y: 100 },
        ]);

        expect(s.history.size).toBe(0);
      });

      it('leaves the layout alone', async () => {
        const s = session({ tool: 'car' });
        seedCar(s);
        const before = structuredClone(s.archive.getManifest().layout);

        await drag(s, [
          { x: 100, y: 100 },
          { x: 250, y: 250 },
        ]);

        expect(s.archive.getManifest().layout).toEqual(before);
      });

      it('finds the car by id after an undo and redo replaced it', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        const { id } = cars(s)[0];

        await s.undo();
        await s.redo();
        await drag(s, [
          { x: 400, y: 100 },
          { x: 500, y: 100 },
        ]);

        expect(cars(s)).toHaveLength(1);
        expect(cars(s)[0]).toMatchObject({ id, p1: { x: 500, y: 100 } });
      });

      it('writes to the image the drag began on', async () => {
        const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'car' });
        seedCar(s);

        const d = s.beginDrag({ x: 100, y: 100 }, SCALE)!;
        s.selectImage('img2.jpg');
        d.move({ x: 150, y: 150 });
        await d.end();

        expect(cars(s, 'img1.jpg')[0].p0).toEqual({ x: 150, y: 150 });
        expect(cars(s, 'img2.jpg')).toEqual([]);
      });
    });

    describe('what a right-click acts on (#45)', () => {
      it('names a car by its body', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        expect(s.rightClick({ x: 250, y: 140 }, SCALE)).toEqual({ kind: 'car', id: cars(s)[0].id });
      });

      it('names nothing past the end of a car', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        expect(s.rightClick({ x: 402, y: 101 }, SCALE)).toBeNull();
      });

      it('names a sensor drawn over a car, not the car', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        sensors(s).push({ id: 'S1abcdefghi', x: 250, y: 100 });

        expect(s.rightClick({ x: 250, y: 100 }, SCALE)).toEqual({ kind: 'sensor', id: 'S1abcdefghi' });
      });

      it('names a reference point drawn over a car, not the car', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        expect(s.rightClick({ x: 100, y: 10 }, SCALE)?.kind).toBe('calibration');
      });

      it('reaches a car drawn with no rectangle after DPT went away', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        s.archive.getManifest().layout.calibration.points = [];

        await s.delete(s.rightClick({ x: 250, y: 100 }, SCALE)!);

        expect(cars(s)).toEqual([]);
      });
    });

    describe('deleting', () => {
      it('deletes that car only, and undo restores it with everything it had', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        await train(s, [100, 400], 500);
        const before = structuredClone(cars(s));

        await s.delete(s.rightClick({ x: 250, y: 100 }, SCALE)!);

        expect(cars(s)).toEqual([before[1]]);
        expect(s.history.undoLabel).toContain('car');
        expect(s.history.undoEntry!.target).toEqual({ kind: 'image', filename: 'img1.jpg' });

        await s.undo();
        expect(cars(s)).toEqual(before);
        await s.redo();
        expect(cars(s)).toEqual([before[1]]);
      });

      it('clears labeled_complete in the same entry (ADR 0011)', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        await s.setComplete(true);
        const size = s.history.size;

        await s.delete(s.rightClick({ x: 250, y: 100 }, SCALE)!);

        expect(s.image!.labeled_complete).toBe(false);
        expect(s.history.size).toBe(size + 1);

        await s.undo();
        expect(s.image!.labeled_complete).toBe(true);
        expect(cars(s)).toHaveLength(1);
      });

      it('leaves an already-incomplete image incomplete, and records one entry', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        const size = s.history.size;

        await s.delete(s.rightClick({ x: 250, y: 100 }, SCALE)!);

        expect(s.image!.labeled_complete).toBe(false);
        expect(s.history.size).toBe(size + 1);
      });

      it('drops a delete whose car went away after the menu opened', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        await train(s, [100, 400], 500);
        const before = structuredClone(cars(s));

        const subject = s.rightClick({ x: 250, y: 100 }, SCALE)!;
        s.archive.getManifest().images[0].labels = [before[1]];
        await s.delete(subject);

        expect(cars(s)).toEqual([before[1]]);
      });
    });

    describe('reclassifying', () => {
      const [firstChoice] = classChoices();
      const target = firstChoice.children[0] ?? firstChoice;

      it('writes the full dotted class as one image entry, and nothing else', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        const before = structuredClone(cars(s));

        await s.reclassifyCar(before[0].id, target.class);

        expect(cars(s)[0]).toEqual({ ...before[0], class: target.class });
        expect(s.history.undoEntry!.target).toEqual({ kind: 'image', filename: 'img1.jpg' });

        await s.undo();
        expect(cars(s)).toEqual(before);
        await s.redo();
        expect(cars(s)[0].class).toBe(target.class);
      });

      it('reclassifies a coupled car through its body', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400, 700]);

        const subject = s.rightClick({ x: 550, y: 100 }, SCALE)!;
        await s.reclassifyCar((subject as { id: string }).id, target.class);

        expect(cars(s)[0].class).toBe(rootClass());
        expect(cars(s)[1].class).toBe(target.class);
      });

      it('drops a reclassify for a car that is gone', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        const { id } = cars(s)[0];
        s.archive.getManifest().images[0].labels = [];

        await s.reclassifyCar(id, target.class);

        expect(cars(s)).toEqual([]);
      });
    });

    describe('per image', () => {
      it('writes each image\'s cars to that image, and records nothing for a switch', async () => {
        const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'car' });
        await train(s, [100, 400]);
        const size = s.history.size;

        s.selectImage('img2.jpg');
        expect(s.history.size).toBe(size);
        expect(s.image!.filename).toBe('img2.jpg');

        await train(s, [200, 500], 200);

        expect(cars(s, 'img1.jpg')).toHaveLength(1);
        expect(cars(s, 'img2.jpg')).toHaveLength(1);
        expect(cars(s, 'img2.jpg')[0].p0).toEqual({ x: 200, y: 200 });
      });

      it('ends a chain when the image changes', async () => {
        const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'car' });

        await clicks(s, { x: 100, y: 100 });
        s.selectImage('img2.jpg');
        await clicks(s, { x: 400, y: 100 });

        expect(cars(s, 'img1.jpg')).toHaveLength(0);
        expect(cars(s, 'img2.jpg')).toHaveLength(0);
      });

      it('grabs only the cars of the image on screen', async () => {
        const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'car' });
        await train(s, [100, 400]);
        const before = structuredClone(cars(s, 'img1.jpg'));

        s.selectImage('img2.jpg');

        expect(s.beginDrag({ x: 100, y: 100 }, SCALE)).toBeNull();
        expect(cars(s, 'img1.jpg')).toEqual(before);
      });
    });

    it('round-trips through a save and reopen', async () => {
      const s = session({ tool: 'car' });
      await train(s, [100, 400]);
      await train(s, [100, 400], 500);

      const reopened = await R49Archive.load(await s.archive.export());

      expect(reopened.getManifest().images[0].labels).toEqual(cars(s));
      expect(cars(s)).toHaveLength(2);
    });
  });

  describe('labeled complete', () => {
    it('writes the flag for the image on screen as one entry', async () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'] });
      s.selectImage('img2.jpg');

      await s.setComplete(true);

      expect(s.archive.getManifest().images.map(image => image.labeled_complete)).toEqual([false, true]);
      expect(s.history.undoEntry!.target).toEqual({ kind: 'image', filename: 'img2.jpg' });

      await s.undo();
      expect(s.image!.labeled_complete).toBe(false);
      await s.redo();
      expect(s.image!.labeled_complete).toBe(true);
    });

    it('writes clearing the flag as its own entry', async () => {
      const s = session();
      await s.setComplete(true);
      await s.setComplete(false);

      expect(s.image!.labeled_complete).toBe(false);
      expect(s.history.size).toBe(2);
      await s.undo();
      expect(s.image!.labeled_complete).toBe(true);
    });

    it('marks an image with no cars complete', async () => {
      const s = session();
      await s.setComplete(true);
      expect(s.image).toMatchObject({ labels: [], labeled_complete: true });
    });

    it('round-trips through a save and reopen', async () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'] });
      await s.setComplete(true);

      const reopened = await R49Archive.load(await s.archive.export());

      expect(reopened.getManifest().images.map(image => image.labeled_complete)).toEqual([true, false]);
    });
  });

  describe('images', () => {
    it('shows the first image of an archive', () => {
      expect(session({ images: ['a.jpg', 'b.jpg'] }).image!.filename).toBe('a.jpg');
    });

    it('has no image for an archive without one', () => {
      const s = session({ images: [] });
      expect(s.image).toBeUndefined();
      expect(s.imageIndex).toBe(0);
    });

    it('adds an image as one entry, incomplete, and shows it', async () => {
      const s = await withBytes(['a.jpg']);

      await s.addImage('b.jpg', Uint8Array.from([9, 9]));

      expect(s.image).toEqual({ filename: 'b.jpg', labeled_complete: false, labels: [] });
      expect(s.imageIndex).toBe(1);
      expect(s.history.undoEntry!.target).toEqual({ kind: 'images' });
    });

    describe('the first image sets camera.resolution (#254)', () => {
      const SIZE = { width: 8064, height: 6048 };
      const resolution = (s: EditSession) => s.archive.getManifest().camera.resolution;

      it('takes the size of the first image into an uncalibrated archive', async () => {
        const s = session({ images: [], calibrated: false });

        await s.addImage('a.jpg', Uint8Array.from([1]), SIZE);

        expect(resolution(s)).toEqual(SIZE);
      });

      it('restores the old size when the add is undone, and the new one on redo', async () => {
        const s = session({ images: [], calibrated: false });
        await s.addImage('a.jpg', Uint8Array.from([1]), SIZE);

        await s.undo();
        expect(resolution(s)).toEqual({ width: 2000, height: 2000 });
        await s.redo();
        expect(resolution(s)).toEqual(SIZE);
      });

      it('keeps the size once an image is in the archive', async () => {
        const s = await withBytes(['a.jpg']);
        s.archive.getManifest().layout.calibration.points = [];

        await s.addImage('b.jpg', Uint8Array.from([9]), SIZE);

        expect(resolution(s)).toEqual({ width: 2000, height: 2000 });
      });

      it('keeps the size while calibration points are positioned in it', async () => {
        const s = session({ images: [], calibrated: true });

        await s.addImage('a.jpg', Uint8Array.from([1]), SIZE);

        expect(resolution(s)).toEqual({ width: 2000, height: 2000 });
      });

      it('keeps the size while sensors are positioned in it', async () => {
        const s = session({ images: [], calibrated: false });
        s.archive.getManifest().layout.sensors = [{ id: 's1', x: 5, y: 5 }];

        await s.addImage('a.jpg', Uint8Array.from([1]), SIZE);

        expect(resolution(s)).toEqual({ width: 2000, height: 2000 });
      });

      it('keeps the size when the image did not decode', async () => {
        const s = session({ images: [], calibrated: false });

        await s.addImage('a.jpg', Uint8Array.from([1]));

        expect(resolution(s)).toEqual({ width: 2000, height: 2000 });
      });
    });

    describe('requiredImageSize (#260)', () => {
      it('is null while nothing is positioned, so the next image sets the size', () => {
        expect(session({ images: [], calibrated: false }).requiredImageSize).toBeNull();
      });

      it('is the declared resolution once an image is in the archive', () => {
        const s = session({ images: ['a.jpg'], calibrated: false });

        expect(s.requiredImageSize).toEqual({ width: 2000, height: 2000 });
      });

      it('is the declared resolution while calibration points are positioned', () => {
        expect(session({ images: [], calibrated: true }).requiredImageSize).toEqual({
          width: 2000,
          height: 2000,
        });
      });

      it('is the declared resolution while sensors are positioned', () => {
        const s = session({ images: [], calibrated: false });
        s.archive.getManifest().layout.sensors = [{ id: 's1', x: 5, y: 5 }];

        expect(s.requiredImageSize).toEqual({ width: 2000, height: 2000 });
      });
    });

    describe('a pick lands as one entry (#262)', () => {
      const SIZE = { width: 2000, height: 2000 };
      const names = (s: EditSession) =>
        s.archive.getManifest().images.map(image => image.filename);
      const pick = (...filenames: readonly string[]) =>
        filenames.map((filename, i) => ({
          filename,
          bytes: Uint8Array.from([i + 10]),
          size: SIZE,
        }));

      it('adds the images in the order given and shows the first of them', async () => {
        const s = await withBytes(['a.jpg']);

        await s.addImages(pick('IMG_2866.jpg', 'IMG_2867.jpg'));

        expect(names(s)).toEqual(['a.jpg', 'IMG_2866.jpg', 'IMG_2867.jpg']);
        expect(s.image!.filename).toBe('IMG_2866.jpg');
      });

      it('costs one undo entry, labelled for the pick', async () => {
        const s = await withBytes(['a.jpg']);

        await s.addImages(pick('IMG_2866.jpg', 'IMG_2867.jpg', 'IMG_2868.jpg'));

        expect(s.history.undoEntry!.label).toBe('add images');
        expect(s.history.undoEntry!.target).toEqual({ kind: 'images' });
        await s.undo();
        expect(names(s)).toEqual(['a.jpg']);
        expect(s.history.canUndo).toBe(false);
      });

      it('restores every image of the pick, bytes included, on redo', async () => {
        const s = await withBytes(['a.jpg']);
        await s.addImages(pick('IMG_2866.jpg', 'IMG_2867.jpg'));
        await s.undo();

        await s.redo();

        expect(names(s)).toEqual(['a.jpg', 'IMG_2866.jpg', 'IMG_2867.jpg']);
        expect(await s.archive.getImage('IMG_2866.jpg')).toEqual(Uint8Array.from([10]));
        expect(await s.archive.getImage('IMG_2867.jpg')).toEqual(Uint8Array.from([11]));
      });

      it('records nothing for an empty pick', async () => {
        const s = await withBytes(['a.jpg']);

        await s.addImages([]);

        expect(names(s)).toEqual(['a.jpg']);
        expect(s.history.canUndo).toBe(false);
      });

      it('takes the size of the first image into an archive where nothing is positioned', async () => {
        const s = session({ images: [], calibrated: false });

        await s.addImages([
          { filename: 'a.jpg', bytes: Uint8Array.from([1]), size: { width: 8064, height: 6048 } },
          { filename: 'b.jpg', bytes: Uint8Array.from([2]), size: { width: 8064, height: 6048 } },
        ]);

        expect(s.archive.getManifest().camera.resolution).toEqual({ width: 8064, height: 6048 });
      });

      it('takes the size of the first image that decoded', async () => {
        const s = session({ images: [], calibrated: false });

        await s.addImages([
          { filename: 'broken.jpg', bytes: Uint8Array.from([1]) },
          { filename: 'b.jpg', bytes: Uint8Array.from([2]), size: { width: 8064, height: 6048 } },
        ]);

        expect(s.archive.getManifest().camera.resolution).toEqual({ width: 8064, height: 6048 });
      });

      describe('a taken filename falls back to a generated one (#256)', () => {
        it('keeps a name the archive does not hold', async () => {
          const s = await withBytes(['a.jpg']);

          await s.addImages(pick('IMG_2866.jpg'));

          expect(names(s)).toEqual(['a.jpg', 'IMG_2866.jpg']);
        });

        it('generates a name for one the archive already holds, keeping the extension', async () => {
          const s = await withBytes(['IMG_2866.jpg']);

          await s.addImages(pick('IMG_2866.jpg'));

          const [kept, generated] = names(s);
          expect(kept).toBe('IMG_2866.jpg');
          expect(generated).toMatch(/^img_\w{11}\.jpg$/);
          expect(s.image!.filename).toBe(generated);
        });

        it('keeps a PNG a PNG', async () => {
          const s = await withBytes(['shot.png']);

          await s.addImages(pick('shot.png'));

          expect(names(s)[1]).toMatch(/^img_\w{11}\.png$/);
        });

        it('counts a name an earlier image of the same pick took', async () => {
          const s = await withBytes(['a.jpg']);

          await s.addImages(pick('IMG_2866.jpg', 'IMG_2866.jpg'));

          const stored = names(s);
          expect(stored).toHaveLength(3);
          expect(stored[1]).toBe('IMG_2866.jpg');
          expect(stored[2]).toMatch(/^img_\w{11}\.jpg$/);
        });

        it('falls back to .jpg for a name with no extension', async () => {
          const s = await withBytes(['photo']);

          await s.addImages(pick('photo'));

          expect(names(s)[1]).toMatch(/^img_\w{11}\.jpg$/);
        });
      });
    });

    it('ends a live chain when an image is added', async () => {
      const s = await withBytes(['a.jpg']);
      s.selectTool('car');
      await clicks(s, { x: 100, y: 100 });

      await s.addImage('b.jpg', Uint8Array.from([9, 9]));
      await clicks(s, { x: 400, y: 100 });

      expect(cars(s, 'a.jpg')).toEqual([]);
      expect(cars(s, 'b.jpg')).toEqual([]);
    });

    it('shows the next image when the one on screen is deleted, and ends its chain', async () => {
      const s = await withBytes(['a.jpg', 'b.jpg', 'c.jpg']);
      s.selectImage('b.jpg');
      s.selectTool('car');
      await clicks(s, { x: 100, y: 100 });

      await s.deleteImage('b.jpg');

      expect(s.image!.filename).toBe('c.jpg');
      expect(s.anchor).toBeNull();
    });

    it('shows the previous image when the last one is deleted', async () => {
      const s = await withBytes(['a.jpg', 'b.jpg']);
      s.selectImage('b.jpg');

      await s.deleteImage('b.jpg');

      expect(s.image!.filename).toBe('a.jpg');
    });

    it('keeps the image on screen when an image before it is deleted', async () => {
      const s = await withBytes(['a.jpg', 'b.jpg', 'c.jpg']);
      s.selectImage('b.jpg');
      s.selectTool('car');
      await clicks(s, { x: 100, y: 100 });

      await s.deleteImage('a.jpg');
      await clicks(s, { x: 400, y: 100 });

      expect(s.image!.filename).toBe('b.jpg');
      expect(cars(s, 'b.jpg')).toHaveLength(1);
      expect(cars(s, 'c.jpg')).toEqual([]);
    });

    it('undoes a delete with the image\'s bytes', async () => {
      const s = await withBytes(['a.jpg', 'b.jpg']);

      await s.deleteImage('a.jpg');
      expect(await s.archive.getImage('a.jpg')).toBeNull();

      await s.undo();
      expect(s.archive.getManifest().images.map(image => image.filename)).toEqual(['a.jpg', 'b.jpg']);
      expect(await s.archive.getImage('a.jpg')).toEqual(Uint8Array.from([1, 2, 3]));
    });

    it('keeps the image on screen through a reorder', async () => {
      const s = await withBytes(['a.jpg', 'b.jpg', 'c.jpg']);
      s.selectImage('a.jpg');

      await s.reorderImages(0, 2);

      expect(s.archive.getManifest().images.map(image => image.filename)).toEqual(['b.jpg', 'c.jpg', 'a.jpg']);
      expect(s.image!.filename).toBe('a.jpg');
      expect(s.imageIndex).toBe(2);
      expect(s.history.undoEntry!.target).toEqual({ kind: 'images' });
    });

    it('shows a neighbour when an undo removes the image on screen', async () => {
      const s = await withBytes(['a.jpg']);
      await s.addImage('b.jpg', Uint8Array.from([9, 9]));

      await s.undo();

      expect(s.image!.filename).toBe('a.jpg');
    });
  });

  describe('undo and redo', () => {
    it('selects the image an entry is on before applying it, and reports what changed', async () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'car' });
      await train(s, [100, 400]);
      const { id } = cars(s)[0];
      s.selectImage('img2.jpg');
      const reveals: (Reveal | null)[] = [];
      s.subscribe(reveal => reveals.push(reveal));

      await s.undo();

      expect(s.image!.filename).toBe('img1.jpg');
      expect(cars(s, 'img1.jpg')).toEqual([]);
      expect(reveals.at(-1)).toEqual({ highlights: [{ kind: 'car', id }] });

      s.selectImage('img2.jpg');
      await s.redo();

      expect(s.image!.filename).toBe('img1.jpg');
      expect(cars(s, 'img1.jpg')).toHaveLength(1);
      expect(reveals.at(-1)).toEqual({ highlights: [{ kind: 'car', id }] });
    });

    it('leaves the image alone for an entry on the layout', async () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'sensor' });
      await clicks(s, { x: 300, y: 300 });
      s.selectImage('img2.jpg');

      await s.undo();

      expect(s.image!.filename).toBe('img2.jpg');
      expect(sensors(s)).toEqual([]);
    });

    it('does nothing with nothing to undo or redo', async () => {
      const s = session();
      const reveals: (Reveal | null)[] = [];
      s.subscribe(reveal => reveals.push(reveal));

      await s.undo();
      await s.redo();

      expect(reveals.every(reveal => reveal === null)).toBe(true);
    });

    it('refuses an undo while a drag is open', async () => {
      const s = session({ tool: 'car' });
      await train(s, [100, 400]);
      const d = s.beginDrag({ x: 100, y: 100 }, SCALE)!;
      d.move({ x: 150, y: 150 });

      await s.undo();

      expect(cars(s)).toHaveLength(1);
      expect(s.history.size).toBe(1);
      await d.end();
      expect(s.history.size).toBe(2);
    });

    it('does not move to another image for an undo refused during a drag', async () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'], tool: 'car' });
      await train(s, [100, 400]);
      s.selectImage('img2.jpg');
      seedPoints(s, { x: 900, y: 900 });
      const d = s.beginDrag({ x: 900, y: 900 }, SCALE)!;
      d.move({ x: 950, y: 950 });

      await s.undo();

      expect(s.image!.filename).toBe('img2.jpg');
      expect(cars(s, 'img1.jpg')).toHaveLength(1);
      d.move({ x: 960, y: 960 });
      expect(points(s)[0].px).toEqual({ x: 960, y: 960 });
    });

    it('ends a live chain on redo', async () => {
      const s = session({ tool: 'car' });
      await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 700, y: 100 });
      await s.undo();

      await s.redo();

      expect(s.anchor).toBeNull();
      expect(cars(s)).toHaveLength(2);
    });

    it('drops a gated tool back to calibration when an undo takes DPT away', async () => {
      const s = session({ calibrated: false });
      await s.placeReferencePoint({ x: 0, y: 0 }, { x: 0, y: 0, z: 0 });
      await s.placeReferencePoint({ x: 100, y: 0 }, { x: 10, y: 0, z: 0 });
      s.selectTool('car');

      await s.undo();

      expect(s.calibrated).toBe(false);
      expect(s.tool).toBe('calibration');
    });
  });

  describe('layout settings', () => {
    it('writes a layout field as one layout entry named for the field', async () => {
      const s = session();

      await s.editLayout({ scale: 'HO' });

      expect(s.archive.getManifest().layout.scale).toBe('HO');
      expect(s.history.undoLabel).toBe('edit scale');
      expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });
      await s.undo();
      expect(s.archive.getManifest().layout.scale).toBe('N');
    });

    it('writes the camera height, and removes the key for none', async () => {
      const s = session();

      await s.setCameraHeight(1200);
      expect(s.archive.getManifest().layout.calibration).toMatchObject({ camera_height_mm: 1200 });
      expect(s.history.undoLabel).toBe('edit camera height');

      await s.setCameraHeight(undefined);
      expect('camera_height_mm' in s.archive.getManifest().layout.calibration).toBe(false);
      expect(points(s)).toEqual(CALIBRATION);
    });

    it('drops a gated tool and ends a live chain when a settings edit takes DPT away', async () => {
      // Points above the reference plane resolve DPT only with a camera height.
      const s = session({ calibrated: false });
      s.archive.getManifest().layout.calibration = {
        points: CALIBRATION.map(point => ({ ...point, world: { ...point.world, z: 50 } })),
        camera_height_mm: 1000,
      };
      s.selectTool('car');
      await clicks(s, { x: 100, y: 100 });
      expect(s.anchor).toEqual({ x: 100, y: 100 });

      await s.setCameraHeight(undefined);

      expect(s.calibrated).toBe(false);
      expect(s.tool).toBe('calibration');
      expect(s.anchor).toBeNull();
    });
  });

  describe('listeners', () => {
    it('hear every change, and stop when unsubscribed', async () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'] });
      const listener = vi.fn();
      const stop = s.subscribe(listener);

      s.selectTool('car');
      await clicks(s, { x: 100, y: 100 });
      await clicks(s, { x: 400, y: 100 });
      s.endChain();
      s.selectImage('img2.jpg');
      const d = s.beginDrag({ x: 100, y: 0 }, SCALE)!;
      d.move({ x: 120, y: 0 });
      await d.end();

      expect(listener).toHaveBeenCalledTimes(7);
      expect(listener).toHaveBeenCalledWith(null);

      stop();
      s.selectTool('sensor');
      expect(listener).toHaveBeenCalledTimes(7);
    });
  });
});

/**
 * The centerline tool (#275).
 *
 * The session's half: the gate, the run, what a click does, editing, and undo.
 * The snap itself is `tests/centerlineSnap.test.ts`'s, and it is reached here
 * through `setTracePixels` with a synthetic two-rail plane — the same shape the
 * editor hands over after decoding the image on screen.
 *
 * **Nothing is in the manifest.** Centerlines are an additive `.r49` field
 * arriving with rails49/r49#52, and the pinned `@rails49/r49` refuses
 * `layout.centerlines`, so the list is the session's and these tests read it
 * off `session.centerlines`. What *is* final is every rule above it, which is
 * what this file pins.
 */

/** DPT 89.7 is the fixture's; a gauge is that many pixels. */
function gauge(s: EditSession): number {
  return getDPT(s.archive.getManifest())!;
}

/**
 * A two-rail plane the snap can read: track running along `centreY`, rails half
 * a gauge either side, roadbed shoulders at 1.3 G.
 *
 * The same profile `tests/centerlineSnap.test.ts` builds, kept separate on
 * purpose — this file is about what the session does with a snap, not about
 * what the snap answers.
 */
function trackPlane(dpt: number, centreY: number, width = 2000, height = 2000) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const d = Math.abs((y - centreY) / dpt);
    const value =
      0.42 - 0.3 / (1 + Math.exp((1.3 - d) / 0.06)) + 0.5 * Math.exp(-(((d - 0.5) / 0.1) ** 2) / 2);
    for (let x = 0; x < width; x++) data[y * width + x] = value;
  }
  return { width, height, data };
}

/** A calibrated session on one image marked labeled complete, with the tool selected. */
function tracing({ pixels = true, centreY = 500 }: { pixels?: boolean; centreY?: number } = {}) {
  const s = session();
  s.archive.getManifest().images[0].labeled_complete = true;
  s.selectTool('centerline');
  if (pixels) s.setTracePixels('img1.jpg', trackPlane(gauge(s), centreY));
  return s;
}

describe('the centerline tool (#275)', () => {
  describe('availability', () => {
    it('is in TOOLS as the fourth tool, gated on DPT and on completeness', () => {
      const spec = TOOLS.find(entry => entry.tool === 'centerline');
      expect(spec).to.exist;
      expect(spec!.needsDpt).to.be.true;
      expect(spec!.needsLabeledComplete).to.be.true;
    });

    it('is not available on an image that is not labeled complete', () => {
      const s = session();
      expect(s.image!.labeled_complete).to.be.false;
      expect(s.toolReason('centerline')).to.contain('labeled complete');
    });

    it('becomes available once the image is marked complete', async () => {
      const s = session();
      await s.setComplete(true);
      expect(s.toolReason('centerline')).to.be.null;
    });

    it('names DPT rather than completeness on an uncalibrated archive', () => {
      // Both gates are shut; the one the person cannot lift by navigating is
      // the one to send them at.
      const s = session({ calibrated: false });
      s.archive.getManifest().images[0].labeled_complete = true;
      expect(s.toolReason('centerline')).to.contain('DPT');
    });

    it('refuses a click with a notice while the image is not complete', async () => {
      const s = session();
      s.selectTool('centerline');
      const result = await s.click({ x: 100, y: 500 }, SCALE);
      expect(result).to.deep.equal({
        kind: 'notice',
        message: s.toolReason('centerline'),
      });
      expect(s.run).to.be.null;
    });

    it('follows the image on screen, so another image can lift the gate', () => {
      const s = session({ images: ['img1.jpg', 'img2.jpg'] });
      s.archive.getManifest().images[1].labeled_complete = true;
      expect(s.toolReason('centerline')).to.not.be.null;
      s.selectImage('img2.jpg');
      expect(s.toolReason('centerline')).to.be.null;
    });

    it('keeps the tool selected across an image that is not complete', () => {
      // The gate is the image's and is lifted by navigating, so the tool must
      // not drop — dropping it would end a run on every image switch, and
      // tracing a run across images is the point (#275).
      const s = tracing();
      s.archive.getManifest().images.push({
        filename: 'img2.jpg',
        labeled_complete: false,
        labels: [],
      });
      s.selectImage('img2.jpg');
      expect(s.tool).to.equal('centerline');
    });
  });

  describe('tracing a run', () => {
    it('keeps the first click unsnapped: it has no direction yet', async () => {
      const s = tracing();
      await s.click({ x: 300, y: 500 + 0.4 * gauge(s) }, SCALE);
      expect(s.run!.points).to.deep.equal([{ x: 300, y: Math.round(500 + 0.4 * gauge(s)) }]);
    });

    it('snaps both clicks on the second, and fills the stretch between them', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 + 0.4 * g }, { x: 300 + 6 * g, y: 500 - 0.3 * g });

      const run = s.run!;
      // The opening click was snapped once the second gave it a direction.
      expect(Math.abs(run.points[0].y - 500) / g).to.be.lessThan(0.25);
      // Every point, including the fill, is on the middle of the track.
      for (const point of run.points) {
        expect(Math.abs(point.y - 500) / g).to.be.lessThan(0.25);
      }
      // About one point per gauge over six gauges, both clicks included.
      expect(run.points.length).to.be.greaterThan(5);
    });

    it('writes nothing for a click on the point the run is already at', async () => {
      const s = tracing();
      await s.click({ x: 300, y: 500 }, SCALE);
      const before = s.run!.points.length;
      await s.click({ x: 300, y: 500 }, SCALE);
      expect(s.run!.points.length).to.equal(before);
    });

    it('keeps a click the snap refuses, and marks the spot', async () => {
      // The second half of the image is blank, so the snap finds no symmetric
      // section there and the click is kept where it was made.
      const s = tracing({ pixels: false });
      const g = gauge(s);
      const plane = trackPlane(g, 500);
      for (let y = 0; y < plane.height; y++) {
        for (let x = 1000; x < plane.width; x++) plane.data[y * plane.width + x] = 0.4;
      }
      s.setTracePixels('img1.jpg', plane);

      await clicks(s, { x: 300, y: 500 }, { x: 1500, y: 500 + 0.4 * g });
      const run = s.run!;
      expect(run.points[run.points.length - 1]).to.deep.equal({
        x: 1500,
        y: Math.round(500 + 0.4 * g),
      });
      expect(run.stops.length).to.be.greaterThan(0);
      expect(s.traceStops.length).to.be.greaterThan(0);
    });

    it('lays no fill and snaps nothing when the editor supplied no pixels', async () => {
      // The honest outcome: a run traced against pixels nobody supplied would
      // be a hand-drawn polyline wearing the snap's name.
      const s = tracing({ pixels: false });
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 + 0.4 * g }, { x: 300 + 6 * g, y: 500 });
      expect(s.run!.points).to.deep.equal([
        { x: 300, y: Math.round(500 + 0.4 * g) },
        { x: Math.round(300 + 6 * g), y: 500 },
      ]);
    });

    it('refuses a click on track under a car, naming the remedy', async () => {
      const s = tracing();
      seedCar(s, { p0: { x: 400, y: 500 }, p1: { x: 800, y: 500 } });
      const result = await s.click({ x: 600, y: 500 }, SCALE);
      expect(result.kind).to.equal('notice');
      expect(s.run).to.be.null;
    });

    it('stops the fill before a car and marks the spot', async () => {
      const s = tracing();
      const g = gauge(s);
      seedCar(s, { p0: { x: 700, y: 500 }, p1: { x: 1100, y: 500 } });
      await clicks(s, { x: 300, y: 500 }, { x: 650, y: 500 });
      // Reaching past the car is refused, so the run is clicked up to it.
      const run = s.run!;
      for (const point of run.points) expect(point.x).to.be.lessThan(700 - 0.4 * g);
    });

    it('does not let the hit-test intercept a click near a stored point', async () => {
      // A stored run carries a point every gauge, so a hit-test ahead of the
      // run would make the tool unusable along the track it just traced.
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.endRun();
      expect(s.centerlines).to.have.lengthOf(1);

      await s.click({ x: 300 + 2 * g, y: 500 }, SCALE);
      expect(s.run, 'a click on the traced line starts a run').to.not.be.null;
    });
  });

  describe('ending a run', () => {
    it('stores it as one history entry', async () => {
      const s = tracing();
      const g = gauge(s);
      const before = s.history.size;
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      expect(s.history.size, 'nothing is recorded while a run is in flight').to.equal(before);

      await s.endRun();
      expect(s.history.size).to.equal(before + 1);
      expect(s.history.undoLabel).to.equal('trace centerline');
      expect(s.centerlines).to.have.lengthOf(1);
      expect(s.run).to.be.null;
    });

    it('does not store a run of fewer than two points', async () => {
      const s = tracing();
      const before = s.history.size;
      await s.click({ x: 300, y: 500 }, SCALE);
      await s.endRun();
      expect(s.centerlines).to.be.empty;
      expect(s.history.size).to.equal(before);
    });

    it('ends on a tool switch', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      s.selectTool('sensor');
      expect(s.run).to.be.null;
      expect(s.centerlines).to.have.lengthOf(1);
    });

    it('ends on a right-click, like a chain, and opens no menu', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      expect(s.rightClick({ x: 300, y: 500 }, SCALE)).to.be.null;
      expect(s.run).to.be.null;
      expect(s.centerlines).to.have.lengthOf(1);
    });

    it('drops a run on dropRun, storing nothing and marking nothing', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      s.dropRun();
      expect(s.run).to.be.null;
      expect(s.centerlines).to.be.empty;
      expect(s.traceStops).to.be.empty;
    });

    it('selects the line it stored, so its points show', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.endRun();
      expect(s.selectedCenterline).to.equal(s.centerlines[0].id);
    });

    it('keeps the stops of a stored run for the rest of the session', async () => {
      const s = tracing({ pixels: false });
      const g = gauge(s);
      const plane = trackPlane(g, 500);
      for (let y = 0; y < plane.height; y++) {
        for (let x = 1000; x < plane.width; x++) plane.data[y * plane.width + x] = 0.4;
      }
      s.setTracePixels('img1.jpg', plane);
      await clicks(s, { x: 300, y: 500 }, { x: 1500, y: 500 });
      await s.endRun();
      expect(s.traceStops.length).to.be.greaterThan(0);
    });
  });

  describe('extending an existing centerline', () => {
    async function traced(s: EditSession, from: Point, to: Point) {
      await clicks(s, from, to);
      await s.endRun();
    }

    it('continues a line when the run starts within half a gauge of its end', async () => {
      const s = tracing();
      const g = gauge(s);
      await traced(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      const line = s.centerlines[0];
      const end = line.points[line.points.length - 1];
      const length = line.points.length;

      await traced(
        s,
        { x: Math.round(end.x + 0.3 * g), y: Math.round(end.y) },
        { x: Math.round(end.x + 6 * g), y: 500 }
      );
      expect(s.centerlines, 'no second line').to.have.lengthOf(1);
      expect(s.centerlines[0].id).to.equal(line.id);
      expect(s.centerlines[0].points.length).to.be.greaterThan(length);
      // The join is the line's own end, so there is no half-gauge kink beside it.
      expect(s.centerlines[0].points[length - 1]).to.deep.equal(end);
    });

    it('prepends, reversed, when the run starts at the line’s first point', async () => {
      const s = tracing();
      const g = gauge(s);
      await traced(s, { x: 900, y: 500 }, { x: 900 + 6 * g, y: 500 });
      const line = s.centerlines[0];
      const start = line.points[0];

      await traced(
        s,
        { x: Math.round(start.x), y: Math.round(start.y) },
        { x: Math.round(start.x - 6 * g), y: 500 }
      );
      const joined = s.centerlines[0].points;
      expect(s.centerlines).to.have.lengthOf(1);
      // Still in order along the track: x increases from one end to the other.
      for (let i = 1; i < joined.length; i++) {
        expect(joined[i].x).to.be.greaterThan(joined[i - 1].x);
      }
    });

    it('prepends even when the snap moves the opening click off the line’s end', async () => {
      // The regression: the opening click is snapped once the second gives it a
      // direction, so by the time the run is stored its first point is no
      // longer the end it left from. Comparing the two spliced the stretch onto
      // whichever end happened to match — the wrong one — and the polyline
      // jumped across the layout. The end is the run's own record now.
      const s = tracing({ centreY: 480 });
      const g = gauge(s);
      await traced(s, { x: 900, y: 480 }, { x: 900 + 6 * g, y: 480 });
      const line = s.centerlines[0];
      const start = line.points[0];
      expect(Math.abs(start.y - 480)).to.be.lessThan(0.25 * g);

      // The track has moved under the tracing: the snap now pulls toward 500,
      // so the opening click will not stay on the line's first point.
      s.setTracePixels('img1.jpg', trackPlane(g, 500));
      await traced(
        s,
        { x: Math.round(start.x), y: Math.round(start.y) },
        { x: Math.round(start.x - 6 * g), y: 500 }
      );

      const joined = s.centerlines[0].points;
      expect(s.centerlines).to.have.lengthOf(1);
      // Still one run in order along the track, not a line doubling back.
      for (let i = 1; i < joined.length; i++) {
        expect(joined[i].x, `point ${i}`).to.be.greaterThan(joined[i - 1].x);
      }
    });

    it('starts a line of its own further off than half a gauge', async () => {
      const s = tracing();
      const g = gauge(s);
      await traced(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      const end = s.centerlines[0].points[s.centerlines[0].points.length - 1];

      await traced(
        s,
        { x: Math.round(end.x + 0.8 * g), y: Math.round(end.y) },
        { x: Math.round(end.x + 6 * g), y: 500 }
      );
      expect(s.centerlines).to.have.lengthOf(2);
    });
  });

  describe('undo while a run is being traced', () => {
    it('removes the last click and the stretch it asked for', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      const after2 = s.run!.points.length;
      await s.click({ x: 300 + 12 * g, y: 500 }, SCALE);
      expect(s.run!.points.length).to.be.greaterThan(after2);

      await s.undo();
      expect(s.run!.points.length).to.equal(after2);
    });

    it('cannot reach past the run’s start', async () => {
      // The chain's rule: at the start the run ends and nothing on the stack is
      // touched. The run is not on the stack at all, so reaching past it would
      // undo the edit *before* the trace began.
      const s = tracing();
      // One entry on the stack before the run opens, so "nothing was undone"
      // is a claim with something behind it.
      s.selectTool('sensor');
      await s.click({ x: 50, y: 50 }, SCALE);
      s.selectTool('centerline');
      await s.click({ x: 300, y: 500 }, SCALE);
      const size = s.history.size;
      expect(size).to.equal(1);

      await s.undo();
      expect(s.run).to.be.null;
      expect(s.history.size).to.equal(size);
      expect(s.history.canUndo).to.be.true;
    });

    it('stores nothing for a run undone back to its start', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.undo();
      await s.undo();
      expect(s.run).to.be.null;
      expect(s.centerlines).to.be.empty;
    });

    it('drops a run on redo rather than storing it', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.endRun();
      await s.undo();
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 3 * g, y: 500 });
      await s.redo();
      expect(s.run).to.be.null;
      expect(s.centerlines).to.have.lengthOf(1);
    });
  });

  describe('undo of a finished edit', () => {
    async function withLine(): Promise<EditSession> {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.endRun();
      return s;
    }

    it('puts a traced run back, and redo brings it again', async () => {
      const s = await withLine();
      const id = s.centerlines[0].id;
      await s.undo();
      expect(s.centerlines).to.be.empty;
      await s.redo();
      expect(s.centerlines.map(line => line.id)).to.deep.equal([id]);
    });

    it('puts an extend back as one entry, with no half-extended state', async () => {
      const s = await withLine();
      const g = gauge(s);
      const before = s.centerlines[0].points;
      const end = before[before.length - 1];
      await clicks(
        s,
        { x: Math.round(end.x), y: Math.round(end.y) },
        { x: Math.round(end.x + 6 * g), y: 500 }
      );
      await s.endRun();
      expect(s.centerlines[0].points.length).to.be.greaterThan(before.length);

      await s.undo();
      expect(s.centerlines).to.have.lengthOf(1);
      expect(s.centerlines[0].points).to.deep.equal(before);
    });

    it('is one entry per point drag, and the point is not re-snapped', async () => {
      const s = await withLine();
      const g = gauge(s);
      const line = s.centerlines[0];
      s.selectCenterline(line.id);
      const index = 2;
      const from = line.points[index];
      const size = s.history.size;

      const moved = await drag(s, [
        { x: from.x, y: from.y },
        { x: from.x, y: from.y + 0.4 * g },
      ]);
      expect(moved, 'a centerline point is grabbable').to.be.true;
      expect(s.history.size).to.equal(size + 1);
      expect(s.history.undoLabel).to.equal('move centerline point');
      // Where the drag left it, not where the snap would put it back — and
      // unrounded, because a centerline point is a measurement.
      expect(s.centerlines[0].points[index].x).to.be.closeTo(from.x, 1e-9);
      expect(s.centerlines[0].points[index].y).to.be.closeTo(from.y + 0.4 * g, 1e-9);

      await s.undo();
      expect(s.centerlines[0].points[index]).to.deep.equal(from);
    });

    it('writes no entry for a point drag returned to its origin', async () => {
      const s = await withLine();
      s.selectCenterline(s.centerlines[0].id);
      const from = s.centerlines[0].points[2];
      const size = s.history.size;
      await drag(s, [from, { x: from.x + 40, y: from.y }, from]);
      expect(s.history.size).to.equal(size);
      // And the point it merely touched is still the fraction the snap reported.
      expect(s.centerlines[0].points[2]).to.deep.equal(from);
    });

    it('does not grab a point of a line that is not selected', async () => {
      // Only the selected line is drawn with handles, so only it is grabbable —
      // a pan over traced track must not move a point nobody can see.
      const s = await withLine();
      s.selectCenterline(null);
      const from = s.centerlines[0].points[2];
      const size = s.history.size;
      expect(await drag(s, [from, { x: from.x, y: from.y + 20 }])).to.be.false;
      expect(s.history.size).to.equal(size);
      expect(s.centerlines[0].points[2]).to.deep.equal(from);
    });

    it('is one entry per point delete', async () => {
      const s = await withLine();
      const line = s.centerlines[0];
      const length = line.points.length;
      const gone = line.points[1];

      await s.delete({ kind: 'centerline-point', id: line.id, index: 1 });
      expect(s.history.undoLabel).to.equal('delete centerline point');
      expect(s.centerlines[0].points).to.have.lengthOf(length - 1);
      expect(s.centerlines[0].points).to.not.deep.include(gone);

      await s.undo();
      expect(s.centerlines[0].points).to.have.lengthOf(length);
    });

    it('takes the line with the last point, rather than leaving a stub', async () => {
      const s = tracing();
      s.setTracePixels('img1.jpg', null);
      await clicks(s, { x: 300, y: 500 }, { x: 900, y: 500 });
      await s.endRun();
      expect(s.centerlines[0].points).to.have.lengthOf(2);

      await s.delete({ kind: 'centerline-point', id: s.centerlines[0].id, index: 0 });
      expect(s.centerlines).to.be.empty;
    });

    it('is one entry per centerline delete', async () => {
      const s = await withLine();
      const id = s.centerlines[0].id;
      await s.delete({ kind: 'centerline', id });
      expect(s.history.undoLabel).to.equal('delete centerline');
      expect(s.centerlines).to.be.empty;

      await s.undo();
      expect(s.centerlines.map(line => line.id)).to.deep.equal([id]);
    });

    it('writes nothing for a delete of something already gone', async () => {
      const s = await withLine();
      const id = s.centerlines[0].id;
      await s.delete({ kind: 'centerline', id });
      const size = s.history.size;
      await s.delete({ kind: 'centerline', id });
      await s.delete({ kind: 'centerline-point', id, index: 0 });
      expect(s.history.size).to.equal(size);
    });
  });

  describe('selection and the menu', () => {
    async function withLine(): Promise<EditSession> {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.endRun();
      s.selectCenterline(null);
      return s;
    }

    it('places a sensor on traced track rather than selecting the line', async () => {
      // A click does not look for a centerline point. The grab radius is a
      // fingertip in screen pixels, which at a fit zoom is far wider than the
      // gauge the points sit a step apart on, so a click that resolved to one
      // would stop the sensor and car tools working over any traced track.
      const s = await withLine();
      s.selectTool('sensor');
      const point = s.centerlines[0].points[2];
      await s.click(point, SCALE);
      expect(s.selectedCenterline).to.be.null;
      expect(sensors(s)).to.have.lengthOf(1);
    });

    it('selects the line a right-click names, which is how its points appear', async () => {
      const s = await withLine();
      s.selectTool('sensor');
      const line = s.centerlines[0];
      const a = line.points[2];
      const b = line.points[3];
      expect(s.rightClick({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, SCALE)).to.deep.equal({
        kind: 'centerline',
        id: line.id,
      });
      expect(s.selectedCenterline).to.equal(line.id);
    });

    it('names a point once its line is selected and the handles are drawn', async () => {
      const s = await withLine();
      s.selectTool('sensor');
      s.selectCenterline(s.centerlines[0].id);
      const point = s.centerlines[0].points[3];
      expect(s.rightClick(point, SCALE)).to.deep.equal({
        kind: 'centerline-point',
        id: s.centerlines[0].id,
        index: 3,
      });
    });

    it('names no point on a line that is not selected', async () => {
      const s = await withLine();
      s.selectTool('sensor');
      const point = s.centerlines[0].points[3];
      expect(s.rightClick(point, SCALE)!.kind).to.equal('centerline');
    });

    it('names the whole line for a right-click between the selected line’s points', async () => {
      const s = await withLine();
      s.selectTool('sensor');
      const line = s.centerlines[0];
      s.selectCenterline(line.id);
      // Midway between two points, off every handle but on the line.
      const a = line.points[2];
      const b = line.points[3];
      expect(s.rightClick({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, SCALE)).to.deep.equal({
        kind: 'centerline',
        id: line.id,
      });
    });

    it('names a car before the centerline running under it', async () => {
      const s = await withLine();
      s.selectTool('sensor');
      const car = seedCar(s, { p0: { x: 400, y: 500 }, p1: { x: 800, y: 500 } });
      expect(s.rightClick({ x: 600, y: 500 }, SCALE)).to.deep.equal({ kind: 'car', id: car.id });
    });

    it('drops a selection whose line an undo took away', async () => {
      const s = tracing();
      const g = gauge(s);
      await clicks(s, { x: 300, y: 500 }, { x: 300 + 6 * g, y: 500 });
      await s.endRun();
      expect(s.selectedCenterline).to.not.be.null;
      await s.undo();
      expect(s.selectedCenterline).to.be.null;
    });

    it('selects nothing for an id that is not there', async () => {
      const s = await withLine();
      s.selectCenterline('nope');
      expect(s.selectedCenterline).to.be.null;
    });
  });
});
