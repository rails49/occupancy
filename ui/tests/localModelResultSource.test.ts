import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { R49Archive } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import { localModelResultSource } from '../src/localModelResultSource.js';
import type { SourceFrame } from '../src/liveSources.js';
import { DETECTOR_MODEL_URL } from '../modelAssets.js';

// The model's half of the live loop, away from the view (#330). `occupancy()` is
// the real one: it is pure, it is what makes L1 total, and stubbing it would
// leave this unable to tell `unknown` / `no-model` from a fabricated map.

/** A car over the sensor the fixture authors, in the frame the manifest declares. */
const detections: Detection[] = [
  { centre: { x: 50, y: 50 }, length: 60, width: 42, angle: 0, class: 'stock', confidence: 0.9 },
];

const detect = vi.fn(async (_source: unknown, _frame: unknown, _dpt: number) => detections);
const dispose = vi.fn(async () => {});
const loadDetector = vi.fn(async (_source: string) => ({ detect, dispose }));

vi.mock('@rails49/detector/browser', () => ({
  loadDetector: (source: string) => loadDetector(source),
}));

/** What a frame source hands over; nothing here reads a pixel. */
const frame: SourceFrame = {
  source: {} as CanvasImageSource,
  width: 1280,
  height: 720,
};

/**
 * A turn that carried no frame: the camera has none to give (#345). The pixels
 * are the same object, which is the point — nothing may read them.
 */
const quiet: SourceFrame = { ...frame, fresh: false };

/** One sensor at the centre of a 100x100 frame, under the car above. */
function oneSensorArchive() {
  const archive = new R49Archive();
  archive.setManifest({
    version: 4,
    layout: {
      name: 'Sources Test',
      scale: 'N',
      calibration: { points: [] },
      sensors: [{ id: 'S1abcdefghi', x: 50, y: 50 }],
    },
    camera: { resolution: { width: 100, height: 100 } },
    images: [],
  });
  return archive;
}

/**
 * The DPT the view resolves for its own fixture: 100 px over 10 model mm in N
 * scale. Handed in rather than read from the archive — the calibration here is
 * empty, which is the point of the DPT being a parameter.
 */
const DPT = 89.6875;

describe('localModelResultSource', () => {
  let archive: R49Archive;
  let logged: { mockRestore(): void };

  beforeEach(() => {
    detect.mockReset();
    detect.mockImplementation(async () => detections);
    dispose.mockClear();
    loadDetector.mockClear();
    loadDetector.mockImplementation(async () => ({ detect, dispose }));
    archive = oneSensorArchive();
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => logged.mockRestore());

  it('opens the detector the bundle ships, and reports no error', async () => {
    const source = localModelResultSource(archive);

    expect(await source.open()).toBeNull();
    // The URL, not a filename: the filename is the detector package's (#234).
    expect(loadDetector).toHaveBeenCalledWith(DETECTOR_MODEL_URL);
  });

  it('reports why the model is missing, as the message to show', async () => {
    loadDetector.mockRejectedValue(new Error(`404 on ${DETECTOR_MODEL_URL}`));
    const source = localModelResultSource(archive);

    expect(await source.open()).toContain('404');
  });

  it('runs the detector once per frame, in the authored frame', async () => {
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect(detect).toHaveBeenCalledTimes(1);
    // `camera.resolution`, not the frame's own 1280x720: the frame sensors and
    // labels are authored in (`SPEC.md` § Output encoding).
    // The DPT in the source's own pixels: it is 1280 wide against the 100 the
    // layout's DPT is measured in.
    expect(detect).toHaveBeenCalledWith(frame.source, { width: 100, height: 100 }, DPT * 12.8);
    expect(result.detections).toEqual(detections);
    expect(result.sensorStates.get('S1abcdefghi')).toEqual({
      state: 'occupied',
      confidence: detections[0].confidence,
      detection: detections[0],
    });
    expect(result.inference).toBeTypeOf('number');
  });

  it('reports every sensor unknown / no-model when no model opened', async () => {
    loadDetector.mockRejectedValue(new Error('no model'));
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect(detect).not.toHaveBeenCalled();
    expect(result.detections).toEqual([]);
    expect([...result.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'no-model' }]);
    // Nothing inferred, so nothing to time — and the stats bar keeps the last
    // number it was given rather than being handed a zero.
    expect(result.inference).toBeUndefined();
  });

  it('does not look at a turn that carried no frame, and says so', async () => {
    // `SourceFrame.fresh: false` says nothing may read pixels from it, so the
    // detector is not asked: there is no frame to ask it about (#345).
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(quiet, { drifted: false, dpt: DPT });

    expect(detect).not.toHaveBeenCalled();
    expect([...result.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'no-frame' }]);
    // No L0 at all, rather than an empty list: nothing looked, so no boxes are
    // drawn and nothing counted cars for this turn.
    expect(result.detections).toBeUndefined();
    // Nothing inferred, so the readout keeps the last real measurement.
    expect(result.inference).toBeUndefined();
  });

  it('answers the frame after a turn with no frame as usual', async () => {
    const source = localModelResultSource(archive);
    await source.open();
    await source.resultFor(quiet, { drifted: false, dpt: DPT });

    const back = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect(back.detections).toEqual(detections);
    expect(back.sensorStates.get('S1abcdefghi')).toMatchObject({ state: 'occupied' });
  });

  it('says no-model rather than no-frame when no model opened either', async () => {
    // A model that never loaded is a session-long fact a frame would not have
    // fixed, and it is the one that tells a human what to fix.
    loadDetector.mockRejectedValue(new Error('no model'));
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(quiet, { drifted: false, dpt: DPT });

    expect([...result.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'no-model' }]);
  });

  it('says no-frame rather than no-calibration for a turn with no frame', async () => {
    // Without pixels there was nothing for the DPT to resample.
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(quiet, { drifted: false, dpt: null });

    expect([...result.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'no-frame' }]);
  });

  it('gives unknown for a frame whose detect failed, and runs the next one', async () => {
    const source = localModelResultSource(archive);
    await source.open();
    detect.mockRejectedValueOnce(new Error('inference failed'));

    const failed = await source.resultFor(frame, { drifted: false, dpt: DPT });

    // A frame that fails is one frame: `unknown` for it, not the previous
    // answer frozen on screen, and not a rejection the loop would die on.
    expect(failed.detections).toEqual([]);
    expect([...failed.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'no-model' }]);
    expect(failed.inference).toBeUndefined();

    const next = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect(next.detections).toEqual(detections);
    expect(next.sensorStates.get('S1abcdefghi')).toMatchObject({ state: 'occupied' });
  });

  it('withholds L1 and keeps L0 while the view is refusing on drift', async () => {
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(frame, { drifted: true, dpt: DPT });

    expect(result.detections).toEqual(detections);
    expect([...result.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'drift' }]);
  });

  it('reports no-calibration from the DPT it is handed, not from the archive', async () => {
    // The view resolves DPT once when the archive arrives and passes it in, so
    // #166 stays one fix.
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(frame, { drifted: false, dpt: null });

    expect([...result.sensorStates.values()]).toEqual([
      { state: 'unknown', reason: 'no-calibration' },
    ]);
  });

  it('does not run the detector with no DPT to resample by', async () => {
    const source = localModelResultSource(archive);
    await source.open();

    const result = await source.resultFor(frame, { drifted: false, dpt: null });

    expect(detect).not.toHaveBeenCalled();
    expect(result.detections).toEqual([]);
  });

  it('reads the sensors per frame, so one authored later is answered', async () => {
    const source = localModelResultSource(archive);
    await source.open();
    archive.getManifest().layout.sensors.push({ id: 'S2abcdefghi', x: 20, y: 80 });

    const result = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect([...result.sensorStates.keys()]).toEqual(['S1abcdefghi', 'S2abcdefghi']);
  });

  it('releases the model when closed', async () => {
    const source = localModelResultSource(archive);
    await source.open();

    source.close();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('releases a model that arrives after it was closed', async () => {
    // Leaving the view while the session is still loading: the WASM heap would
    // otherwise be held for a view nobody is looking at.
    let land!: (detector: { detect: typeof detect; dispose: typeof dispose }) => void;
    loadDetector.mockImplementation(() => new Promise(resolve => (land = resolve)));
    const source = localModelResultSource(archive);
    const opening = source.open();

    source.close();
    land({ detect, dispose });
    await opening;

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('opens again after a close, for a source handed back on a remount', async () => {
    // A source the app holds across mounts — which is what #331's service is —
    // would otherwise answer `unknown` for the whole second session, with no
    // error to show for it.
    const source = localModelResultSource(archive);
    await source.open();
    source.close();

    expect(await source.open()).toBeNull();
    const result = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect(result.detections).toEqual(detections);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('answers unknown after it has been closed, rather than on a disposed session', async () => {
    const source = localModelResultSource(archive);
    await source.open();
    source.close();

    const result = await source.resultFor(frame, { drifted: false, dpt: DPT });

    expect(detect).not.toHaveBeenCalled();
    expect([...result.sensorStates.values()]).toEqual([{ state: 'unknown', reason: 'no-model' }]);
  });
});
