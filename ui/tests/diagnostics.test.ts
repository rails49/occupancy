import { describe, it, expect } from 'vitest';
import type { CarLabel } from '@rails49/r49';
import type { Detection } from '@rails49/detector';
import { carWidthPx } from '@rails49/detector';
import {
  AGREE_IOU,
  MATCH_IOU,
  describeFinding,
  diagnoseImage,
  findingBounds,
  rollUp,
} from '../src/diagnostics.js';

// The polygon arithmetic moved into `@rails49/detector` with the decode's
// duplicate suppression (#107); its tests went with it, to
// rails49/detector's `lib/detector/tests/overlap.test.ts`.

// One DPT for the whole file, so every width below is the same number the
// matcher derives. 10 px per track gauge puts a car at ~20.9 px wide.
const DPT = 10;
const WIDTH = carWidthPx(DPT);
const FRAME = { width: 1920, height: 1080 };

function label(id: string, x0: number, x1: number, y = 0): CarLabel {
  return { id, class: 'stock', provenance: 'human', p0: { x: x0, y }, p1: { x: x1, y } };
}

function box(
  centreX: number,
  centreY: number,
  length: number,
  overrides: Partial<Detection> = {}
): Detection {
  return {
    centre: { x: centreX, y: centreY },
    length,
    width: WIDTH,
    angle: 0,
    class: 'stock',
    confidence: 0.9,
    ...overrides,
  };
}

describe('diagnoseImage', () => {
  const base = { filename: 'img.jpg', labeledComplete: true, dpt: DPT };

  it('calls an exact overlap agreed', () => {
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 100)],
    });

    expect(result.counts).toEqual({ agreed: 1, 'pose-off': 0, missed: 0, phantom: 0, duplicate: 0 });
    expect(result.findings[0].iou).toBeCloseTo(1, 6);
    expect(result.findings[0].deviation).toBeNull();
    expect(result.disagreements).toBe(0);
  });

  it('ignores the predicted width, which has no ground truth to be wrong against', () => {
    // Width is a fit to a constant (see Detection.width) and a label's width is
    // derived rather than authored, so scoring it would charge the model for a
    // quantity nothing measures. A 3x width must still agree.
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 100, { width: WIDTH * 3 })],
    });

    expect(result.counts.agreed).toBe(1);
    // ...but it is still reported, so a drifting model is visible.
    const off = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 60, { width: WIDTH * 3 })],
    });
    expect(off.findings[0].deviation!.widthRatio).toBeCloseTo(3, 6);
  });

  it('calls a partial overlap pose-off and says how', () => {
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 60)],
    });

    expect(result.counts['pose-off']).toBe(1);
    const finding = result.findings[0];
    expect(finding.iou).toBeGreaterThanOrEqual(MATCH_IOU);
    expect(finding.iou).toBeLessThan(AGREE_IOU);
    expect(finding.deviation!.lengthRatio).toBeCloseTo(0.6, 6);
    expect(describeFinding(finding)).toContain('short by 40%');
  });

  it('calls an unmatched label missed and an unmatched box phantom', () => {
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(900, 500, 100)],
    });

    expect(result.counts).toEqual({
      agreed: 0,
      'pose-off': 0,
      missed: 1,
      phantom: 1,
      duplicate: 0,
    });
    expect(result.findings.find(f => f.kind === 'missed')!.label!.id).toBe('L1');
    expect(result.findings.find(f => f.kind === 'phantom')!.detection).not.toBeNull();
  });

  it('a box across a car is a phantom, not a pose-off — which centre distance cannot see', () => {
    // The case that decided the matcher. A box perpendicular to the car, on its
    // exact centre, is zero distance away: a nearest-centre rule calls it a
    // perfect match. Overlap calls it what it is — the model boxed something
    // that is not this car.
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 100, 200)],
      detections: [box(150, 0, 100, { angle: Math.PI / 2 })],
    });

    expect(result.counts).toEqual({
      agreed: 0,
      'pose-off': 0,
      missed: 1,
      phantom: 1,
      duplicate: 0,
    });
  });

  it('pairs every car of a consist with its own box', () => {
    // Coupled cars share endpoints, so the spans abut exactly. Each box is
    // drifted along the axis by most of a car width; every one must still land
    // on its own car rather than shuffling down the train.
    const labels = [label('L1', 0, 100), label('L2', 100, 200), label('L3', 200, 300)];
    const drift = WIDTH * 0.7;
    const detections = [
      box(50 + drift, 0, 100),
      box(150 + drift, 0, 100),
      box(250 + drift, 0, 100),
    ];

    const result = diagnoseImage({ ...base, labels, detections });

    expect(result.counts.missed).toBe(0);
    expect(result.counts.phantom).toBe(0);
    const paired = result.findings
      .filter(f => f.label && f.detection)
      .map(f => [f.label!.id, f.detection!.centre.x] as const);
    expect(paired).toEqual(
      expect.arrayContaining([
        ['L1', 50 + drift],
        ['L2', 150 + drift],
        ['L3', 250 + drift],
      ])
    );
  });

  it('calls a second box on a found car a duplicate, not a phantom', () => {
    // What the shipped model actually does, found the first time this view ran
    // against a real archive: two or three boxes on one car. Reporting those as
    // "box over no label" sends the reader hunting for phantom detections in
    // the ballast, when the fault is that nothing deduplicated the output.
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 100, { confidence: 0.9 }), box(52, 0, 98, { confidence: 0.5 })],
    });

    expect(result.counts.duplicate).toBe(1);
    expect(result.counts.phantom).toBe(0);
    const duplicate = result.findings.find(f => f.kind === 'duplicate')!;
    // It carries the label it duplicates, so a crop can frame both and name
    // which car was double-counted.
    expect(duplicate.label!.id).toBe('L1');
    expect(duplicate.iou).toBeGreaterThan(MATCH_IOU);
    expect(duplicate.detection!.confidence).toBe(0.5);
    // Still a disagreement: it is a false positive whatever it is called.
    expect(result.disagreements).toBe(1);
  });

  it('a box overlapping nothing stays a phantom even when labels exist', () => {
    const result = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 100, { confidence: 0.9 }), box(900, 600, 100, { confidence: 0.5 })],
    });

    expect(result.counts.duplicate).toBe(0);
    expect(result.counts.phantom).toBe(1);
    expect(result.findings.find(f => f.kind === 'phantom')!.label).toBeNull();
  });

  it('gives a contested label to the more confident box', () => {
    // Both boxes overlap the one label. Confidence order is what decides, and
    // the loser is a phantom rather than silently dropped.
    const labels = [label('L1', 0, 100)];
    const detections = [
      box(60, 0, 100, { confidence: 0.4 }),
      box(45, 0, 100, { confidence: 0.95 }),
    ];

    const result = diagnoseImage({ ...base, labels, detections });

    // The loser overlaps the same car, so it is a duplicate rather than a
    // phantom — but it is still the loser, and still a disagreement.
    expect(result.counts.duplicate).toBe(1);
    const matched = result.findings.find(f => f.kind === 'agreed' || f.kind === 'pose-off')!;
    expect(matched.detection!.confidence).toBe(0.95);
    expect(result.findings.find(f => f.kind === 'duplicate')!.detection!.confidence).toBe(0.4);
  });

  it('reports the lowest confidence on the image, and null with no boxes', () => {
    const withBoxes = diagnoseImage({
      ...base,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 100, { confidence: 0.8 }), box(500, 300, 100, { confidence: 0.31 })],
    });
    expect(withBoxes.worstConfidence).toBeCloseTo(0.31, 6);

    const none = diagnoseImage({ ...base, labels: [label('L1', 0, 100)], detections: [] });
    expect(none.worstConfidence).toBeNull();
  });

  it('an image with no labels and no boxes is a clean sheet, not a divide by zero', () => {
    const result = diagnoseImage({ ...base, labels: [], detections: [] });
    expect(result.counts).toEqual({
      agreed: 0,
      'pose-off': 0,
      missed: 0,
      phantom: 0,
      duplicate: 0,
    });
    expect(result.disagreements).toBe(0);
    expect(result.worstConfidence).toBeNull();
  });
});

describe('rollUp', () => {
  it('sums the counts and tracks which images carry the completeness claim', () => {
    const complete = diagnoseImage({
      filename: 'a.jpg',
      labeledComplete: true,
      dpt: DPT,
      labels: [label('L1', 0, 100)],
      detections: [box(50, 0, 100)],
    });
    const incomplete = diagnoseImage({
      filename: 'b.jpg',
      labeledComplete: false,
      dpt: DPT,
      labels: [],
      detections: [box(400, 200, 100)],
    });

    const archive = rollUp([complete, incomplete]);

    expect(archive.counts).toEqual({
      agreed: 1,
      'pose-off': 0,
      missed: 0,
      phantom: 1,
      duplicate: 0,
    });
    expect(archive.labels).toBe(1);
    expect(archive.detections).toBe(2);
    expect(archive.imagesWithDisagreements).toBe(1);
    // The phantom above is on the image nobody asserted complete, so it is not
    // evidence against the model — the surfaces have to be able to say so.
    expect(archive.incompleteImages).toBe(1);
  });
});

describe('findingBounds', () => {
  it('contains both sides of a disagreement, however far apart they are', () => {
    const finding = diagnoseImage({
      filename: 'img.jpg',
      labeledComplete: true,
      dpt: DPT,
      labels: [label('L1', 100, 200)],
      detections: [box(150, 0, 100, { angle: Math.PI / 2 })],
    }).findings.find(f => f.kind === 'phantom')!;

    // A phantom has no label, so this one frames the box alone.
    const rect = findingBounds(finding, DPT, FRAME);
    expect(rect.x).toBeLessThanOrEqual(150 - 10);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(150 + 10);
  });

  it('frames a matched pair around both rectangles, not the label alone', () => {
    const slid = 6 * WIDTH;
    const finding = diagnoseImage({
      filename: 'img.jpg',
      labeledComplete: true,
      dpt: DPT,
      labels: [label('L1', 0, 200)],
      detections: [box(100 + slid, 0, 200)],
    }).findings.find(f => f.detection && f.label)!;

    const rect = findingBounds(finding, DPT, FRAME);
    // Both the label's far end and the box's far end are inside.
    expect(rect.x).toBeLessThanOrEqual(0);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(200 + slid);
  });

  it('never leaves the frame', () => {
    const finding = diagnoseImage({
      filename: 'img.jpg',
      labeledComplete: true,
      dpt: DPT,
      labels: [label('L1', 0, 40, 0)],
      detections: [],
    }).findings[0];

    const rect = findingBounds(finding, DPT, FRAME);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(FRAME.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(FRAME.height);
  });
});
