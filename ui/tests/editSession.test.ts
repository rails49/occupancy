import { describe, it, expect, vi } from 'vitest';
import { R49Archive, MANIFEST_VERSION, getDPT } from '@rails49/r49';
import type { ReferencePoint, CarLabel, Centerline, ManifestData, Point, Sensor } from '@rails49/r49';
import { EditSession } from '../src/editSession.js';
import { ALREADY_LABELED } from '../src/carChain.js';
import { NO_TRACK } from '../src/chain.js';
import { TRACK_FIT, fitNodes, fitTrack, poses } from '../src/trackFit.js';
import { traceOptions } from '../src/trackTrace.js';
import type { TraceView } from '../src/trackTrace.js';
import { G, along, clicksAlong, offLine, type Piece } from './trackClicks.js';
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

/**
 * Straight track along y = 100, 200, … 800, from x = -1000 to 3000, so cars
 * and sensors placed on those rows land where they are clicked. DPT 89.7 puts
 * the snap reach at 134 px, so every row between is near one of them.
 */
const ROWS: readonly Centerline[] = Array.from({ length: 8 }, (_, i) => ({
  nodes: [
    { x: -1000, y: 100 * (i + 1), heading: 0 },
    { x: 3000, y: 100 * (i + 1), heading: 0 },
  ],
}));

function manifest(filenames: readonly string[], calibrated: boolean, rows = true): ManifestData {
  return {
    version: MANIFEST_VERSION,
    layout: {
      name: 'Test Layout',
      scale: 'N',
      calibration: { points: calibrated ? structuredClone([...CALIBRATION]) : [] },
      sensors: [],
      ...(rows ? { centerlines: structuredClone([...ROWS]) } : {}),
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
  rows = true,
}: {
  images?: readonly string[];
  calibrated?: boolean;
  tool?: EditorTool;
  /** Whether the layout has the {@link ROWS} of track. */
  rows?: boolean;
} = {}): EditSession {
  const archive = new R49Archive();
  archive.setManifest(manifest(images, calibrated, rows));
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

/** Where the next car of a live car chain starts, or null when none is live. */
function anchor(s: EditSession): Point | null {
  const chain = s.chain;
  return chain?.tool === 'car' ? chain.end : null;
}

/** A live track chain's clicks and the line it writes, or null when none is live. */
function trackChain(s: EditSession) {
  const chain = s.chain;
  return chain?.tool === 'track' ? { line: chain.line, clicks: chain.trace.clicks } : null;
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
    it('places an unnamed sensor on the nearest track, with a snowflake id', async () => {
      const s = session({ tool: 'sensor' });

      // A sensor needs nothing from the editor.
      expect(await s.click({ x: 320.4, y: 240.6 }, SCALE)).toEqual({ kind: 'none' });

      expect(sensors(s)).toHaveLength(1);
      const [sensor] = sensors(s);
      expect(sensor).toMatchObject({ x: 320, y: 200 });
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
      await clicks(s, { x: 320, y: 200 });
      const { id } = sensors(s)[0];
      await s.nameSensor(id, 'Yard throat');
      const size = s.history.size;
      const before = structuredClone(points(s));

      await drag(s, [
        { x: 323, y: 202 },
        { x: 400, y: 260 },
        { x: 423, y: 302 },
      ]);

      expect(sensors(s)[0]).toEqual({ id, x: 420, y: 300, name: 'Yard throat' });
      expect(s.history.size).toBe(size + 1);
      expect(s.history.undoLabel).toContain('sensor');
      expect(s.history.undoEntry!.target).toEqual({ kind: 'layout' });
      expect(points(s)).toEqual(before);

      await s.undo();
      expect(sensors(s)[0]).toMatchObject({ x: 320, y: 200 });
    });

    it('refuses a sensor with no track near, and says why', async () => {
      const s = session({ tool: 'sensor', rows: false });

      expect(await s.click({ x: 320, y: 200 }, SCALE)).toEqual({ kind: 'notice', message: NO_TRACK });
      expect(sensors(s)).toHaveLength(0);
      expect(s.history.canUndo).toBe(false);
    });

    it('drags a sensor onto the nearest track, and leaves it there past the reach', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 800 });

      const d = s.beginDrag({ x: 320, y: 800 }, SCALE)!;
      d.move({ x: 400, y: 760 });
      expect(sensors(s)[0]).toMatchObject({ x: 400, y: 800 });
      d.move({ x: 500, y: 1100 });
      expect(sensors(s)[0]).toMatchObject({ x: 400, y: 800 });
      await d.end();
      expect(sensors(s)[0]).toMatchObject({ x: 400, y: 800 });
    });

    it('puts a sensor off the track back exactly when its drag is cancelled', async () => {
      const s = session({ tool: 'sensor' });
      sensors(s).push({ id: 'S1abcdefghi', x: 333, y: 255 });

      const d = s.beginDrag({ x: 333, y: 255 }, SCALE)!;
      d.move({ x: 400, y: 300 });
      expect(sensors(s)[0]).toMatchObject({ x: 400, y: 300 });
      await d.cancel();

      expect(sensors(s)[0]).toMatchObject({ x: 333, y: 255 });
    });

    it('drags whichever object is nearest, whatever the tool', async () => {
      const s = session({ tool: 'sensor' });
      await clicks(s, { x: 320, y: 200 });

      await drag(s, [
        { x: 100, y: 0 },
        { x: 150, y: 50 },
      ]);

      expect(points(s)[1].px).toEqual({ x: 150, y: 50 });
      expect(sensors(s)[0]).toMatchObject({ x: 320, y: 200 });
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

      await clicks(s, { x: 200.4, y: 290.6 });
      expect(cars(s)).toHaveLength(0);
      expect(s.history.size).toBe(0);

      await clicks(s, { x: 500, y: 330 });

      expect(cars(s)).toHaveLength(1);
      // Both ends land on the track along y = 300, in whole pixels.
      expect(cars(s)[0]).toMatchObject({ p0: { x: 200, y: 300 }, p1: { x: 500, y: 300 } });
    });

    it('refuses to start a chain with no track near, and says why', async () => {
      const s = session({ tool: 'car', rows: false });

      expect(await s.click({ x: 200, y: 300 }, SCALE)).toEqual({ kind: 'notice', message: NO_TRACK });
      expect(anchor(s)).toBeNull();
    });

    it('refuses a car end with no track near, and keeps the chain', async () => {
      const s = session({ tool: 'car' });
      await clicks(s, { x: 200, y: 800 });

      expect(await s.click({ x: 500, y: 1000 }, SCALE)).toEqual({ kind: 'notice', message: NO_TRACK });
      expect(cars(s)).toHaveLength(0);
      expect(anchor(s)).toEqual({ x: 200, y: 800 });
    });

    it('previews where the next car would end: on the track, or nowhere', async () => {
      const s = session({ tool: 'car' });
      expect(s.previewCar({ x: 450, y: 230 })).toEqual({ x: 450, y: 200 });
      expect(s.previewCar({ x: 450, y: 1000 })).toBeNull();
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
      expect(anchor(s)).toBeNull();
      expect(s.history.size).toBe(0);

      await clicks(s, { x: 600, y: 600 }, { x: 800, y: 600 });
      expect(cars(s)[0].p0).toEqual({ x: 600, y: 600 });
    });

    it('completes a car on a second click that lands on another object', async () => {
      const s = session({ tool: 'car' });

      await clicks(s, { x: 200, y: 300 });
      sensors(s).push({ id: 'S1abcdefghi', x: 500, y: 300 });
      expect(await s.click({ x: 500, y: 300 }, SCALE)).toEqual({ kind: 'none' });

      expect(cars(s)).toHaveLength(1);
      expect(cars(s)[0].p1).toEqual({ x: 500, y: 300 });
    });

    describe('a click on a car already labeled (#43)', () => {
      it('splits a car where a click lands on its body, as one entry', async () => {
        const s = session({ tool: 'car' });
        seedCar(s, { class: 'stock.freight' });

        expect(await s.click({ x: 250, y: 110 }, SCALE)).toEqual({ kind: 'none' });

        expect(cars(s).map(car => [car.p0, car.p1])).toEqual([
          [{ x: 100, y: 100 }, { x: 250, y: 100 }],
          [{ x: 250, y: 100 }, { x: 400, y: 100 }],
        ]);
        expect(cars(s)[0].id).toBe('C1abcdefghi');
        expect(cars(s)[1].id).not.toBe('C1abcdefghi');
        expect(cars(s).map(car => car.class)).toEqual(['stock.freight', 'stock.freight']);
        expect(anchor(s)).toBeNull();
        expect(s.history.undoLabel).toBe('split car');
        await s.undo();
        expect(cars(s)).toHaveLength(1);
        expect(cars(s)[0].p1).toEqual({ x: 400, y: 100 });
      });

      it('splits nothing within the grab radius of an end', async () => {
        const s = session({ tool: 'car' });
        seedCar(s);

        await clicks(s, { x: 110, y: 40 });

        expect(cars(s)).toHaveLength(1);
        expect(s.history.canUndo).toBe(false);
      });

      it('continues a chain from a free end', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        await clicks(s, { x: 400, y: 100 });
        expect(anchor(s)).toEqual({ x: 400, y: 100 });
        await clicks(s, { x: 700, y: 100 });

        expect(cars(s)).toHaveLength(2);
        expect(cars(s)[1].p0).toEqual({ x: 400, y: 100 });
        expect(cars(s)[1].p1).toEqual({ x: 700, y: 100 });
      });

      it('continues a chain from the first car\'s free end too', async () => {
        const s = session({ tool: 'car' });
        await train(s, [400, 700]);

        await clicks(s, { x: 400, y: 100 }, { x: 100, y: 100 });

        expect(cars(s)[1].p0).toEqual({ x: 400, y: 100 });
        expect(cars(s)[1].p1).toEqual({ x: 100, y: 100 });
      });

      it('ends a continued chain on undo once it is back at the end it continued', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        await clicks(s, { x: 400, y: 100 }, { x: 700, y: 100 });

        await s.undo();
        expect(anchor(s)).toEqual({ x: 400, y: 100 });
        await s.undo();

        expect(anchor(s)).toBeNull();
        expect(cars(s)).toHaveLength(1);
      });

      it('refuses a click on a coupling, with a notice', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400, 700]);

        expect(await s.click({ x: 400, y: 100 }, SCALE)).toEqual({
          kind: 'notice',
          message: ALREADY_LABELED,
        });
        expect(anchor(s)).toBeNull();
        expect(cars(s)).toHaveLength(2);
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
        expect(anchor(s)).toEqual({ x: 250, y: 400 });
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

      it('couples a chain drawn along a diagonal track, pixel for pixel', async () => {
        const s = session({ tool: 'car', rows: false });
        const heading = Math.atan2(80, 140);
        s.archive.getManifest().layout.centerlines = [
          {
            nodes: [
              { x: 0, y: 0, heading },
              { x: 1400, y: 800, heading },
            ],
          },
        ];

        await clicks(s, { x: 100.4, y: 60.6 }, { x: 240.5, y: 140.5 }, { x: 390.2, y: 220.7 });

        expect(cars(s)).toHaveLength(2);
        expect(cars(s)[0].p1).toEqual(cars(s)[1].p0);
        expect(cars(s)[1].p0).toEqual({ x: 242, y: 138 });
      });

      it('writes one entry per car, never one for the train', async () => {
        const s = session({ tool: 'car' });
        await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 700, y: 100 });
        expect(s.history.size).toBe(2);
      });

      it('moves the anchor to the coupling each click makes', async () => {
        const s = session({ tool: 'car' });
        expect(anchor(s)).toBeNull();

        await clicks(s, { x: 100, y: 100 });
        expect(anchor(s)).toEqual({ x: 100, y: 100 });

        await clicks(s, { x: 400, y: 100 });
        expect(anchor(s)).toEqual({ x: 400, y: 100 });
      });

      it('keeps the cars when the chain ends, and starts a new train on the next click', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);

        expect(anchor(s)).toBeNull();
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

      it('writes no car for a click within the grab radius of the anchor, scaled to the screen', async () => {
        const s = session({ tool: 'car' });

        await clicks(s, { x: 200, y: 200 }, { x: 210, y: 200 });
        expect(cars(s)).toHaveLength(0);

        await s.click({ x: 210, y: 200 }, 0.5);
        expect(cars(s)).toHaveLength(1);
      });

      it('starts the next car from where a drag left the last one\'s end', async () => {
        const s = session({ tool: 'car' });
        await clicks(s, { x: 100, y: 500 }, { x: 400, y: 500 });

        await drag(s, [
          { x: 400, y: 500 },
          { x: 400, y: 700 },
        ]);
        expect(anchor(s)).toEqual({ x: 400, y: 700 });
        await clicks(s, { x: 700, y: 700 });

        expect(cars(s)[0].p1).toEqual({ x: 400, y: 700 });
        expect(cars(s)[1].p0).toEqual({ x: 400, y: 700 });
      });

      it('ends a chain still at its first click when something is dragged', async () => {
        const s = session({ tool: 'car' });
        await train(s, [100, 400]);
        await clicks(s, { x: 800, y: 800 });

        await drag(s, [
          { x: 400, y: 100 },
          { x: 450, y: 100 },
        ]);

        expect(anchor(s)).toBeNull();
        expect(cars(s)[0].p1).toEqual({ x: 450, y: 100 });
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
          expect(anchor(s)).toEqual({ x: 400, y: 100 });

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
          expect(anchor(s)).toEqual({ x: 100, y: 100 });
        });

        it('stops at the chain\'s start: it ends the chain and undoes nothing', async () => {
          const s = session({ tool: 'car' });
          await train(s, [100, 400]);
          await clicks(s, { x: 100, y: 500 });

          await s.undo();

          expect(anchor(s)).toBeNull();
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
          expect(anchor(s)).toEqual({ x: 400, y: 100 });
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

        // Both ends land on the track along y = 200, on one pixel.
        expect(cars(s)[0].p1).toEqual({ x: 450, y: 200 });
        expect(cars(s)[1].p0).toEqual({ x: 450, y: 200 });
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
        d.move({ x: 150, y: 200 });
        await d.end();

        expect(cars(s, 'img1.jpg')[0].p0).toEqual({ x: 150, y: 200 });
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
      expect(anchor(s)).toBeNull();
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

      expect(anchor(s)).toBeNull();
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
      expect(anchor(s)).toEqual({ x: 100, y: 100 });

      await s.setCameraHeight(undefined);

      expect(s.calibrated).toBe(false);
      expect(s.tool).toBe('calibration');
      expect(anchor(s)).toBeNull();
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
describe('EditSession track tool (#284, #298)', () => {
  /** Synthetic clicks along `pieces`, at this session's DPT, in whole pixels. */
  function laidAlong(s: EditSession, pieces: readonly Piece[]): Point[] {
    const k = getDPT(s.archive.getManifest())! / G;
    return clicksAlong(pieces).map(p => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) }));
  }

  /** The true centerline point `s` gauges along `pieces`, at this session's DPT. */
  function trueAt(s: EditSession, pieces: readonly Piece[], gauges: number): Point {
    const k = getDPT(s.archive.getManifest())! / G;
    const p = along(pieces, gauges);
    return { x: p.x * k, y: p.y * k };
  }

  function line(s: EditSession, index = 0): Centerline {
    return s.archive.getManifest().layout.centerlines![index];
  }

  it('writes the clicks and the fitted nodes of a straight, one layout entry per click', async () => {
    const s = session({ tool: 'track', rows: false });
    const pieces = [{ straight: 20 }];
    const at = laidAlong(s, pieces);
    const tolerance = 0.25 * getDPT(s.archive.getManifest())!;

    await clicks(s, at[0]);
    expect(s.history.size).toBe(0);
    for (const [i, p] of at.slice(1).entries()) {
      await clicks(s, p);
      expect(s.history.size).toBe(i + 1);
      expect(line(s).clicks).toEqual(at.slice(0, i + 2));
    }
    expect(s.history.undoLabel).toBe('extend centerline');

    const nodes = line(s).nodes;
    expect(nodes).toHaveLength(2);
    for (const [n, gauges] of [[nodes[0], 0] as const, [nodes[1], 20] as const]) {
      const p = trueAt(s, pieces, gauges);
      expect(Math.hypot(n.x - p.x, n.y - p.y)).toBeLessThan(tolerance);
      expect(n.heading).toBeCloseTo(0.3, 1);
    }
  });

  it('splits a fitted arc past 90° at its midpoint, and adds no entry on finishing', async () => {
    const s = session({ tool: 'track', rows: false });
    const pieces = [{ radius: 30, turn: 120 }];
    const at = laidAlong(s, pieces);
    const tolerance = 0.25 * getDPT(s.archive.getManifest())!;
    await clicks(s, ...at);

    const nodes = line(s).nodes;
    const arc = (30 * 120 * Math.PI) / 180;
    expect(nodes).toHaveLength(3);
    nodes.forEach((n, i) => {
      const p = trueAt(s, pieces, (arc * i) / 2);
      expect(Math.hypot(n.x - p.x, n.y - p.y)).toBeLessThan(tolerance);
      expect(n.heading).toBeCloseTo(0.3 + (i * Math.PI) / 3, 1);
    });

    const entries = s.history.size;
    s.endChain();
    expect(trackChain(s)).toBeNull();
    expect(s.history.size).toBe(entries);
    expect(line(s).nodes).toEqual(nodes);
  });

  it('takes undo click by click while tracing, and draws the line as it was', async () => {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [{ straight: 20 }, { radius: 30, turn: 90 }, { straight: 20 }]);
    const after: { line: Centerline; trace: unknown }[] = [];
    for (const p of at) {
      await clicks(s, p);
      const chain = s.chain;
      if (chain?.tool !== 'track') throw new Error('no track chain');
      if (chain.line !== null) after.push(structuredClone({ line: line(s), trace: chain.trace }));
    }
    // A join commits before the end, so an undo has one to take back.
    const first = after.findIndex(a => (a.trace as { committed: unknown }).committed !== null);
    expect(first).toBeGreaterThan(0);

    for (let n = after.length - 2; n >= 0; n--) {
      await s.undo();
      const chain = s.chain;
      expect(chain?.tool === 'track' && structuredClone({ line: line(s), trace: chain.trace })).toEqual(after[n]);
    }
    await s.undo();
    expect(trackChain(s)).toEqual({ line: null, clicks: [at[0]] });
    expect(s.tracks).toEqual([]);
    await s.undo();
    expect(trackChain(s)).toBeNull();
    expect(s.history.canUndo).toBe(false);
  });

  it('ends the chain on redo, then redoes', async () => {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [{ straight: 20 }]);
    await clicks(s, ...at);
    await s.undo();
    expect(trackChain(s)?.clicks).toEqual(at.slice(0, -1));
    await s.redo();
    expect(trackChain(s)).toBeNull();
    expect(line(s).clicks).toEqual(at);
  });

  it('ignores a click within the grab radius of the last click, scaled to the screen', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    expect(await s.click({ x: 310, y: 100 }, SCALE)).toEqual({ kind: 'none' });
    expect(s.history.size).toBe(1);
    expect(line(s).clicks).toHaveLength(2);
    await s.click({ x: 310, y: 100 }, 0.5);
    expect(line(s).clicks).toHaveLength(3);
  });

  it('puts a click near the line and behind its last click between clicks, as one entry; Shift-click extends', async () => {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [{ straight: 20 }]);
    const [first, last] = [at[0], at[at.length - 1]];
    const between = { x: Math.round((first.x + last.x) / 2), y: Math.round((first.y + last.y) / 2) };
    await clicks(s, first, last);

    await s.click(between, SCALE);
    expect(line(s).clicks).toEqual([first, between, last]);
    expect(s.history.undoLabel).toBe('add click');
    await s.undo();
    expect(trackChain(s)?.clicks).toEqual([first, last]);

    await s.click(between, SCALE, true);
    expect(line(s).clicks).toEqual([first, last, between]);
    expect(s.history.undoLabel).toBe('extend centerline');
  });

  it('puts a click between clicks in stored order on a line continued from its first click', async () => {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [{ straight: 20 }]);
    const [first, last] = [at[0], at[at.length - 1]];
    const between = { x: Math.round((first.x + last.x) / 2), y: Math.round((first.y + last.y) / 2) };
    await clicks(s, first, last);
    s.endChain();

    await clicks(s, first, between);
    expect(line(s).clicks).toEqual([first, between, last]);
  });

  it('saves a valid line mid-trace, and loads it as written with no refit', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, ...laidAlong(s, [{ straight: 10 }, { radius: 30, turn: 45 }]));
    const written = structuredClone(line(s));
    // Nodes no fit of these clicks would give: what is stored is what loads.
    s.archive.getManifest().layout.centerlines![0] = {
      ...written,
      nodes: [written.nodes[0], { x: 1, y: 2, heading: 3 }],
    };

    const reopened = new EditSession(await R49Archive.load(await s.archive.export()));

    expect(reopened.tracks).toEqual([{ ...written, nodes: [written.nodes[0], { x: 1, y: 2, heading: 3 }] }]);
    expect(trackChain(s)).not.toBeNull();
  });

  it('is gated on DPT', async () => {
    const s = session({ calibrated: false, rows: false });
    s.selectTool('track');
    expect(s.tool).toBe('calibration');
    await clicks(s, { x: 10, y: 10 });
    expect(trackChain(s)).toBeNull();
  });

  it('starts a trace on a sensor rather than opening its name', async () => {
    const s = session({ tool: 'track', rows: false });
    sensors(s).push({ id: 'S1abcdefghi', x: 100, y: 100 });
    expect(await s.click({ x: 100, y: 100 }, SCALE)).toEqual({ kind: 'none' });
    expect(trackChain(s)).toEqual({ line: null, clicks: [{ x: 100, y: 100 }] });
  });

  it('writes a second line beside the first', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    s.endChain();
    await clicks(s, { x: 100, y: 500 }, { x: 300, y: 500 });
    expect(trackChain(s)?.line).toBe(1);
    expect(s.tracks.map(t => t.clicks![0].y)).toEqual([100, 500]);
  });

  it('writes nothing for a trace that never got past its start', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 });
    s.endChain();
    expect(s.tracks).toHaveLength(0);
    expect('centerlines' in s.archive.getManifest().layout).toBe(false);
  });

  it('starts the line again after undoing back to the start', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    await s.undo();
    await clicks(s, { x: 100, y: 300 });
    expect(s.tracks).toHaveLength(1);
    expect(line(s).clicks).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 300 },
    ]);
  });

  it('ends a trace on right-click, opening no menu', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    expect(s.rightClick({ x: 300, y: 100 }, SCALE)).toBeNull();
    expect(trackChain(s)).toBeNull();
    expect(s.tracks).toHaveLength(1);
  });

  it('ends a trace on a tool change, keeping the line', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    s.selectTool('car');
    expect(trackChain(s)).toBeNull();
    expect(s.tracks).toHaveLength(1);
  });

  it('keeps a trace across an image change', async () => {
    const s = session({ images: ['a.jpg', 'b.jpg'], tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    s.selectImage('b.jpg');
    expect(trackChain(s)?.clicks).toHaveLength(2);
  });

  it('grabs nothing while a trace is live, so a sensor on the track stays put', async () => {
    const s = session({ tool: 'track', rows: false });
    sensors(s).push({ id: 'S1abcdefghi', x: 300, y: 100 });
    await clicks(s, { x: 100, y: 100 });
    expect(s.beginDrag({ x: 300, y: 100 }, SCALE)).toBeNull();
    s.endChain();
    expect(s.beginDrag({ x: 300, y: 100 }, SCALE)).not.toBeNull();
  });

  it('ends a chain on redo, then redoes an entry of another tool', async () => {
    const s = session({ tool: 'sensor' });
    await clicks(s, { x: 50, y: 100 });
    await s.undo();
    s.selectTool('track');
    await clicks(s, { x: 100, y: 1000 });
    expect(trackChain(s)).not.toBeNull();
    await s.redo();
    expect(trackChain(s)).toBeNull();
    expect(sensors(s)).toHaveLength(1);
  });

  it('ends a chain when DPT stops resolving', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 300, y: 100 });
    await s.delete({ kind: 'calibration', index: 0, px: { x: 0, y: 0 } });
    expect(s.tool).toBe('calibration');
    expect(trackChain(s)).toBeNull();
    expect(s.tracks).toHaveLength(1);
  });
});

describe('EditSession track lines without clicks (#284, #298, #302)', () => {
  /** A calibrated session with the track tool and one straight line of three nodes, no clicks. */
  function withLine(): EditSession {
    const s = session({ tool: 'track', rows: false });
    s.archive.getManifest().layout.centerlines = [
      {
        nodes: [
          { x: 100, y: 100, heading: 0 },
          { x: 300, y: 100, heading: 0 },
          { x: 500, y: 100, heading: 0 },
        ],
      },
    ];
    return s;
  }

  it('does nothing for a click on the line or on its nodes', async () => {
    const s = withLine();
    await clicks(s, { x: 200, y: 104 }, { x: 300, y: 100 }, { x: 500, y: 100 });
    expect(trackChain(s)).toBeNull();
    expect(s.history.canUndo).toBe(false);
  });

  it('grabs no node', () => {
    const s = withLine();
    expect(s.beginDrag({ x: 300, y: 100 }, SCALE)).toBeNull();
  });

  it('names the line as the subject of a right-click, on a node too', () => {
    const s = withLine();
    for (const at of [{ x: 200, y: 104 }, { x: 300, y: 100 }]) {
      expect(s.rightClick(at, SCALE)).toEqual({ kind: 'track', line: 0, px: { x: 100, y: 100 } });
    }
  });

  it('deletes a whole line', async () => {
    const s = withLine();
    await s.delete({ kind: 'track', line: 0, px: { x: 100, y: 100 } });
    expect(s.tracks).toHaveLength(0);
    expect(s.history.undoLabel).toBe('delete centerline');
  });

  it('lands a sensor', async () => {
    const s = withLine();
    s.selectTool('sensor');
    await clicks(s, { x: 250, y: 130 });
    expect(sensors(s)).toMatchObject([{ x: 250, y: 100 }]);
  });

  it('leaves track alone under another tool', async () => {
    const s = withLine();
    s.selectTool('sensor');
    await clicks(s, { x: 200, y: 100 });
    expect(s.tracks[0].nodes.map(n => n.x)).toEqual([100, 300, 500]);
    expect(sensors(s)).toHaveLength(1);
  });
});


/** Expects `nodes` to be the whole-line fit of `at`. */
function expectFitOf(s: EditSession, nodes: readonly Centerline['nodes'][number][], at: readonly Point[]) {
  const dpt = getDPT(s.archive.getManifest())!;
  expect(nodes).toEqual(fitNodes(fitTrack(at, traceOptions(dpt))!.fit));
}

describe('EditSession finished track lines (#302)', () => {
  /** Synthetic clicks along `pieces`, at this session's DPT, in whole pixels. */
  function laidAlong(s: EditSession, pieces: readonly Piece[]): Point[] {
    const k = getDPT(s.archive.getManifest())! / G;
    return clicksAlong(pieces).map(p => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) }));
  }

  function line(s: EditSession, index = 0): Centerline {
    return s.archive.getManifest().layout.centerlines![index];
  }

  /** The nodes a fresh whole-line fit of `at` gives, at this session's DPT. */
  function fitOf(s: EditSession, at: readonly Point[]) {
    return fitNodes(fitTrack(at, traceOptions(getDPT(s.archive.getManifest())!))!.fit);
  }

  /** A traced and finished line along a straight and an arc, and its clicks. */
  async function finished(): Promise<{ s: EditSession; at: Point[] }> {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [{ straight: 20 }, { radius: 30, turn: 60 }]);
    await clicks(s, ...at);
    s.endChain();
    return { s, at };
  }

  it('refits the whole line once, on release, when a click is dragged', async () => {
    const { s, at } = await finished();
    const before = structuredClone(line(s));
    const entries = s.history.size;
    const from = at[3];
    const to = { x: from.x + 3, y: from.y - 40 };

    const d = s.beginDrag(from, SCALE)!;
    expect(d).not.toBeNull();
    d.move({ x: from.x + 1, y: from.y - 20 });
    d.move(to);
    expect(line(s).nodes).toEqual(before.nodes);
    expect(s.history.size).toBe(entries);
    await d.end();

    const moved = at.map((p, i) => (i === 3 ? to : p));
    expect(s.history.size).toBe(entries + 1);
    expect(s.history.undoLabel).toBe('move click');
    expect(line(s).clicks).toEqual(moved);
    expect(line(s).nodes).toEqual(fitOf(s, moved));
    expect(trackChain(s)).toBeNull();
  });
  it('names a click as the subject of a right-click, and the line between clicks', async () => {
    const { s, at } = await finished();
    expect(s.rightClick(at[3], SCALE)).toEqual({ kind: 'track-click', line: 0, index: 3, px: at[3] });
    const between = { x: Math.round((at[1].x + at[2].x) / 2), y: Math.round((at[1].y + at[2].y) / 2) };
    expect(s.rightClick(between, SCALE)).toMatchObject({ kind: 'track', line: 0 });
  });

  it('deletes a click and refits the whole line, as one entry', async () => {
    const { s, at } = await finished();
    const entries = s.history.size;
    await s.delete({ kind: 'track-click', line: 0, index: 3, px: at[3] });
    const left = at.filter((_, i) => i !== 3);
    expect(s.history.size).toBe(entries + 1);
    expect(s.history.undoLabel).toBe('delete click');
    expect(line(s).clicks).toEqual(left);
    expect(line(s).nodes).toEqual(fitOf(s, left));
  });

  it('does nothing for a delete of a click that has moved since the menu opened', async () => {
    const { s, at } = await finished();
    const entries = s.history.size;
    await s.delete({ kind: 'track-click', line: 0, index: 3, px: at[4] });
    expect(s.history.size).toBe(entries);
  });

  it('deletes the line with one of its last two clicks', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 });
    s.endChain();
    await s.delete({ kind: 'track-click', line: 0, index: 1, px: { x: 400, y: 100 } });
    expect(s.tracks).toHaveLength(0);
    expect(s.history.undoLabel).toBe('delete centerline');
  });
  it('adds a click on the line in track order, and refits the whole line, as one entry', async () => {
    const { s, at } = await finished();
    const entries = s.history.size;
    // Off the middle of two clicks, toward the line's outside: still on the line.
    const added = { x: Math.round((at[4].x + at[5].x) / 2) + 2, y: Math.round((at[4].y + at[5].y) / 2) - 3 };
    expect(await s.click(added, SCALE)).toEqual({ kind: 'none' });
    const expected = [...at.slice(0, 5), added, ...at.slice(5)];
    expect(trackChain(s)).toBeNull();
    expect(s.history.size).toBe(entries + 1);
    expect(s.history.undoLabel).toBe('add click');
    expect(line(s).clicks).toEqual(expected);
    expect(line(s).nodes).toEqual(fitOf(s, expected));
  });

  it('does nothing for a click on a click between the ends', async () => {
    const { s, at } = await finished();
    const entries = s.history.size;
    await clicks(s, at[3]);
    expect(trackChain(s)).toBeNull();
    expect(s.history.size).toBe(entries);
  });
  it('continues the line from its last click, appending', async () => {
    const { s, at } = await finished();
    // On along the line's end heading, 0.3 rad plus 60°.
    const end = at[at.length - 1];
    const next = [1, 2].map(k => ({
      x: Math.round(end.x + k * 150 * Math.cos(0.3 + Math.PI / 3)),
      y: Math.round(end.y + k * 150 * Math.sin(0.3 + Math.PI / 3)),
    }));
    const entries = s.history.size;

    await clicks(s, at[at.length - 1]);
    expect(trackChain(s)).toEqual({ line: 0, clicks: at });
    expect(s.history.size).toBe(entries);
    await clicks(s, ...next);

    expect(s.history.size).toBe(entries + next.length);
    expect(s.history.undoLabel).toBe('extend centerline');
    expect(s.tracks).toHaveLength(1);
    expect(line(s).clicks).toEqual([...at, ...next]);
    expectFitOf(s, line(s).nodes, [...at, ...next]);
  });

  it('continues the line from its first click, writing back in stored order', async () => {
    const { s, at } = await finished();
    // Back along the line's start heading, 0.3 rad.
    const before = [1, 2].map(k => ({
      x: Math.round(at[0].x - k * 150 * Math.cos(0.3)),
      y: Math.round(at[0].y - k * 150 * Math.sin(0.3)),
    }));

    await clicks(s, at[0]);
    expect(trackChain(s)).toEqual({ line: 0, clicks: [...at].reverse() });
    await clicks(s, ...before);

    const stored = [...[...before].reverse(), ...at];
    expect(trackChain(s)?.clicks).toEqual([...stored].reverse());
    expect(line(s).clicks).toEqual(stored);
    expectFitOf(s, line(s).nodes, stored);
    expect(s.chain?.end).toEqual(before[1]);
  });

  it('ends a continued chain on undo at its start, undoing nothing', async () => {
    const { s, at } = await finished();
    const entries = s.history.size;
    await clicks(s, at[0], { x: at[0].x - 150, y: at[0].y });
    await s.undo();
    expect(trackChain(s)).toEqual({ line: 0, clicks: [...at].reverse() });
    await s.undo();
    expect(trackChain(s)).toBeNull();
    expect(s.history.size).toBe(entries + 1);
    expect(line(s).clicks).toEqual(at);
  });
  it('refits a loaded line everywhere the first time one of its clicks is touched', async () => {
    const { s, at } = await finished();
    // Stored nodes no fit of these clicks gives: an older fit, or a hand edit.
    const stale = line(s).nodes.map(n => ({ ...n, y: n.y + 30 }));
    s.archive.getManifest().layout.centerlines![0] = { nodes: stale, clicks: at };
    const reopened = new EditSession(await R49Archive.load(await s.archive.export()));
    reopened.selectTool('track');
    expect(reopened.tracks[0].nodes).toEqual(stale);

    const to = { x: at[3].x, y: at[3].y + 2 };
    expect(await drag(reopened, [at[3], to])).toBe(true);

    const moved = at.map((p, i) => (i === 3 ? to : p));
    expect(reopened.tracks[0].nodes).toEqual(fitOf(reopened, moved));
    expect(reopened.tracks[0].nodes.every((n, i) => n.y !== stale[i]?.y)).toBe(true);
  });

  it('leaves sensors and car ends where they are when the line refits', async () => {
    const { s, at } = await finished();
    const sensor = { id: 'S1abcdefghi', x: at[2].x, y: at[2].y + 3 };
    sensors(s).push({ ...sensor });
    const car = seedCar(s, { p0: { x: at[5].x, y: at[5].y }, p1: { x: at[7].x, y: at[7].y } });
    const nodes = line(s).nodes;

    expect(await drag(s, [at[4], { x: at[4].x + 10, y: at[4].y + 60 }])).toBe(true);

    expect(line(s).nodes).not.toEqual(nodes);
    expect(sensors(s)).toEqual([sensor]);
    expect(cars(s)).toEqual([car]);
  });

  it('grabs a click rather than a sensor on it', async () => {
    const { s, at } = await finished();
    sensors(s).push({ id: 'S1abcdefghi', x: at[3].x, y: at[3].y });
    expect(await drag(s, [at[3], { x: at[3].x, y: at[3].y + 20 }])).toBe(true);
    expect(sensors(s)[0]).toMatchObject({ x: at[3].x, y: at[3].y });
    expect(line(s).clicks![3]).toEqual({ x: at[3].x, y: at[3].y + 20 });
  });

  it('puts a dragged click back and writes nothing when the drag is cancelled', async () => {
    const { s, at } = await finished();
    const before = structuredClone(line(s));
    const entries = s.history.size;
    const d = s.beginDrag(at[3], SCALE)!;
    d.move({ x: at[3].x, y: at[3].y + 40 });
    await d.cancel();
    expect(line(s)).toEqual(before);
    expect(s.history.size).toBe(entries);
  });

  it('leaves the clicks alone under another tool', async () => {
    const { s, at } = await finished();
    s.selectTool('sensor');
    expect(s.rightClick(at[3], SCALE)).toBeNull();
    expect(await drag(s, [at[3], { x: at[3].x, y: at[3].y + 20 }])).toBe(false);
  });
});

describe('EditSession track edits while tracing (#303)', () => {
  /** Synthetic clicks along `pieces`, at this session's DPT, in whole pixels. */
  function laidAlong(s: EditSession, pieces: readonly Piece[]): Point[] {
    const k = getDPT(s.archive.getManifest())! / G;
    return clicksAlong(pieces).map(p => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) }));
  }

  function line(s: EditSession): Centerline {
    return s.archive.getManifest().layout.centerlines![0];
  }

  function traceOf(s: EditSession): TraceView {
    const chain = s.chain;
    if (chain?.tool !== 'track') throw new Error('no track chain');
    return structuredClone(chain.trace);
  }

  /** `p` moved `gauges` across the line its neighbours give, in whole pixels. */
  function across(s: EditSession, at: readonly Point[], i: number, gauges: number): Point {
    const k = getDPT(s.archive.getManifest())! / G;
    const p = offLine(at[i], at[i - 1], at[i + 1], gauges * k);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  /**
   * A live trace along five pieces, four of them committed, and the middle
   * click of committed part 2, the second straight.
   */
  async function tracing(): Promise<{ s: EditSession; at: Point[]; onPart2: number }> {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [
      { straight: 20 },
      { radius: 30, turn: 90 },
      { straight: 20 },
      { radius: 30, turn: -90 },
      { straight: 20 },
    ]);
    await clicks(s, ...at);
    const trace = traceOf(s);
    expect(trace.committed?.parts).toHaveLength(4);
    const [, , a, b] = poses(trace.committed!);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = at.map(p => Math.hypot(p.x - mid.x, p.y - mid.y));
    const onPart2 = d.indexOf(Math.min(...d));
    return { s, at, onPart2 };
  }

  it('refits from the part before a dragged committed click, on release, as one entry', async () => {
    const { s, at, onPart2 } = await tracing();
    const before = traceOf(s);
    const entries = s.history.size;
    const to = across(s, at, onPart2, 0.2);

    const d = s.beginDrag(at[onPart2], SCALE)!;
    expect(d).not.toBeNull();
    d.move(to);
    expect(traceOf(s).clicks[onPart2]).toEqual(to);
    expect(traceOf(s).committed).toEqual(before.committed);
    expect(s.history.size).toBe(entries);
    await d.end();

    const moved = at.map((p, i) => (i === onPart2 ? to : p));
    const after = traceOf(s);
    expect(after.clicks).toEqual(moved);
    expect(after.committed?.start).toEqual(before.committed?.start);
    expect(after.committed?.parts[0]).toEqual(before.committed?.parts[0]);
    expect(after.committed?.parts[1]).not.toEqual(before.committed?.parts[1]);
    expect(s.history.size).toBe(entries + 1);
    expect(s.history.undoLabel).toBe('move click');
    expect(line(s).clicks).toEqual(moved);
    expectFitOf(s, line(s).nodes, moved);
  });

  it('uncommits a join the edit leaves loose, which draws its bar again', async () => {
    const { s, at } = await tracing();
    const before = traceOf(s);
    const dpt = getDPT(s.archive.getManifest())!;
    const commitSigma = TRACK_FIT.commitSigma * dpt;
    // The click at the join of the arc and the second straight.
    const join = poses(before.committed!)[2];
    const d = at.map(p => Math.hypot(p.x - join.x, p.y - join.y));
    const i = d.indexOf(Math.min(...d));
    expect(await drag(s, [at[i], across(s, at, i, 0.5)])).toBe(true);

    const after = traceOf(s);
    expect(after.committed?.parts.length ?? 0).toBeLessThan(before.committed!.parts.length);
    const loose = after.live!.joins
      .slice(1, -1)
      .filter(j => (j.sigma > commitSigma || j.margin < TRACK_FIT.commitMargin) && j.sigma < TRACK_FIT.barCap * dpt);
    expect(loose.length).toBeGreaterThan(0);
  });

  it('opens Delete click on a traced click, which refits from the part before it and keeps the chain', async () => {
    const { s, at, onPart2 } = await tracing();
    const before = traceOf(s);
    const entries = s.history.size;

    const subject = s.rightClick(at[onPart2], SCALE);
    expect(subject).toEqual({ kind: 'track-click', line: 0, index: onPart2, px: at[onPart2] });
    expect(trackChain(s)).not.toBeNull();
    await s.delete(subject!);

    const left = at.filter((_, i) => i !== onPart2);
    const after = traceOf(s);
    expect(after.clicks).toEqual(left);
    expect(after.committed?.start).toEqual(before.committed?.start);
    expect(after.committed?.parts[0]).toEqual(before.committed?.parts[0]);
    expect(after.committed?.parts[1]).not.toEqual(before.committed?.parts[1]);
    expect(s.history.size).toBe(entries + 1);
    expect(s.history.undoLabel).toBe('delete click');
    expect(line(s).clicks).toEqual(left);
    expectFitOf(s, line(s).nodes, left);
  });

  it('still ends the chain on a right-click off its clicks, or on its last click', async () => {
    const { s, at } = await tracing();
    const between = { x: Math.round((at[1].x + at[2].x) / 2), y: Math.round((at[1].y + at[2].y) / 2) };
    expect(s.rightClick(between, SCALE)).toBeNull();
    expect(trackChain(s)).toBeNull();
    await clicks(s, at[at.length - 1]);
    expect(trackChain(s)).not.toBeNull();
    expect(s.rightClick(at[at.length - 1], SCALE)).toBeNull();
    expect(trackChain(s)).toBeNull();
  });

  it('takes an edit back on undo, clicks and trace as they were, and goes on undoing clicks', async () => {
    const { s, at, onPart2 } = await tracing();
    const before = { line: structuredClone(line(s)), trace: traceOf(s) };
    expect(await drag(s, [at[onPart2], across(s, at, onPart2, 0.2)])).toBe(true);
    await s.delete(s.rightClick(at[onPart2 + 1], SCALE)!);

    await s.undo();
    await s.undo();
    expect({ line: line(s), trace: traceOf(s) }).toEqual(before);
    await s.undo();
    expect(traceOf(s).clicks).toEqual(at.slice(0, -1));
    expect(line(s).clicks).toEqual(at.slice(0, -1));
  });

  it('appends the next click after an edit, committing joins in order and never moving them', async () => {
    const { s, at, onPart2 } = await tracing();
    await s.delete(s.rightClick(at[onPart2], SCALE)!);
    const left = at.filter((_, i) => i !== onPart2);
    const end = at[at.length - 1];
    // On along the last straight, heading 0.3 rad.
    const next = [1, 2, 3, 4].map(k => ({
      x: Math.round(end.x + k * 100 * Math.cos(0.3)),
      y: Math.round(end.y + k * 100 * Math.sin(0.3)),
    }));

    let shown = traceOf(s);
    for (const [k, p] of next.entries()) {
      await clicks(s, p);
      const now = traceOf(s);
      expect(now.clicks).toEqual([...left, ...next.slice(0, k + 1)]);
      const n = shown.committed?.parts.length ?? 0;
      expect(now.committed?.start).toEqual(shown.committed?.start);
      expect(now.committed?.parts.slice(0, n)).toEqual(shown.committed?.parts);
      shown = now;
    }
    expect(s.history.undoLabel).toBe('extend centerline');
    expect(line(s).clicks).toEqual([...left, ...next]);
  });

  it('undoes a delete on a line continued from its end, then ends the chain at its start', async () => {
    const { s, at } = await tracing();
    s.endChain();
    await clicks(s, at[at.length - 1]);
    const entries = s.history.size;
    await s.delete(s.rightClick(at[3], SCALE)!);
    expect(line(s).clicks).toHaveLength(at.length - 1);

    await s.undo();
    expect(line(s).clicks).toEqual(at);
    expect(trackChain(s)).toEqual({ line: 0, clicks: at });
    await s.undo();
    expect(trackChain(s)).toBeNull();
    expect(s.history.size).toBe(entries + 1);
  });

  it('deletes the line and ends the chain with one of its last two clicks', async () => {
    const s = session({ tool: 'track', rows: false });
    await clicks(s, { x: 100, y: 100 }, { x: 400, y: 100 });
    await s.delete(s.rightClick({ x: 100, y: 100 }, SCALE)!);
    expect(s.tracks).toHaveLength(0);
    expect(trackChain(s)).toBeNull();
    expect(s.history.undoLabel).toBe('delete centerline');
  });

  it('puts a dragged click back and writes nothing when the drag is cancelled', async () => {
    const { s, at, onPart2 } = await tracing();
    const before = { line: structuredClone(line(s)), trace: traceOf(s) };
    const entries = s.history.size;
    const d = s.beginDrag(at[onPart2], SCALE)!;
    d.move(across(s, at, onPart2, 0.5));
    await d.cancel();
    expect({ line: line(s), trace: traceOf(s) }).toEqual(before);
    expect(s.history.size).toBe(entries);
    expect(trackChain(s)).not.toBeNull();
  });

  it('moves the stored click on a line continued from its first click', async () => {
    const s = session({ tool: 'track', rows: false });
    const at = laidAlong(s, [{ straight: 20 }, { radius: 30, turn: 60 }]);
    await clicks(s, ...at);
    s.endChain();
    await clicks(s, at[0]);
    const to = across(s, at, 3, 0.2);
    expect(await drag(s, [at[3], to])).toBe(true);

    const moved = at.map((p, i) => (i === 3 ? to : p));
    expect(line(s).clicks).toEqual(moved);
    expect(trackChain(s)).toEqual({ line: 0, clicks: [...moved].reverse() });
  });
});
