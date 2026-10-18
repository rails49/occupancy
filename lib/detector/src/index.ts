// Public interface of @occupancy/detector (root entry point).
//
// This file is the package's interface — the only surface consumers may rely
// on. Anything not exported here is internal and may change without notice.
// Per-symbol documentation lives on the declarations in ./types.ts,
// ./geometry.ts and ./occupancy.ts, because TypeScript discards doc comments
// written on re-export statements.
//
// The name undersells it. This root entry point is really the **car box**
// package: a car is a rectangle derived from two points and one width
// constant, and everything here is that rectangle seen from one side or the
// other — authored into a training label, predicted back out by the model,
// or tested against a sensor. The geometry is not drift; it is here because
// the width constant has to have exactly one home, and the model's consumers
// and the label exporter both need it. The session itself is behind a
// platform entry point, so nothing that only wants the geometry pays for ORT:
//
//   import { loadDetector } from '@occupancy/detector/browser';

//── L0: what the model saw ───────────────────────────────────────────────────
// One detection per car, in the frame the caller asked `detect` to answer in —
// pose exactly as emitted, raw predicted width included.
export type { Detection, Frame } from './types.ts';

//── L1: what the sensors say ─────────────────────────────────────────────────
// Pure geometry over L0 — no second model, and total: one state per sensor,
// always, so no caller ever constructs an `unknown` itself.
export type { SensorState, UnknownReason } from './types.ts';
export { occupancy } from './occupancy.ts';

//── Car geometry ─────────────────────────────────────────────────────────────
// The rectangle, from both ends. `spanToPolygon` turns an authored span into
// the training label Ultralytics reads; `boxCorners` turns a detection into
// drawable corners in the same winding — which is what lets the UI put ground
// truth and prediction in one picture and compare them by eye. `carWidthPx` is
// the constant both are built on, and L1 substitutes for the model's own.
export { boxCorners, carWidthPx, spanToPolygon } from './geometry.ts';

//── Class index ──────────────────────────────────────────────────────────────
// The YOLO class a stored `class` trains as. The class list is this project's
// and the vocabulary is the format's, so the mapping lives here; the
// segment-prefix rule it matches by is imported from `@rails49/r49` (#181).
export { detectorClassIndex } from './classIndex.ts';

//── Box overlap ──────────────────────────────────────────────────────────────
// How much two oriented boxes share. Exported because it has two consumers
// that are not each other's: the decode suppresses duplicate boxes with it
// (#107), and the UI's archive diagnostics match predictions against labels
// with it. It lived in `ui/src/diagnostics.ts` until the second caller
// appeared, which is the bar this file sets everywhere else for moving
// something down.
export { convexIntersectionArea, polygonArea, polygonIoU } from './overlap.ts';

// Withheld: `covers`, the point-in-oriented-box test, and the width
// normalization it is applied with. `occupancy` is the only caller, so
// exporting them would publish a seam nothing yet stands on. `boxCorners` is
// exported despite being derivable from a `Detection` for the opposite reason:
// two consumers need corners to draw, and "derivable" is exactly how the width
// constant came to be written twice in the first place.
//
// Withheld: a `./geometry` entry point. The classifier's split is load-bearing
// — it keeps `onnxruntime-node` and `sharp` out of the browser bundle — but
// pure geometry has no dependency to keep out of anything, so a third entry
// point here would be ceremony. What is worth splitting is the ORT session,
// and that is `./browser`.
//
// Withheld: a `./node` entry point. Nothing needs node-side inference: the
// archive diagnostics live in the browser deliberately, so that what they
// exercise is the shipped `onnxruntime-web` path rather than a second one that
// could pass while the real one fails. Add it when something wants to score a
// corpus offline, not before.
//
// Withheld: `DETECTOR_CLASSES`, `DETECTOR_CONFIDENCE_THRESHOLD` and
// `DETECTOR_INPUT`. They are `@occupancy/config`'s, generated from
// `config.yaml`; re-exporting them here would give them a second import path
// and an implied second owner.
