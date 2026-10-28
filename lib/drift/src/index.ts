// Public interface of @occupancy/drift.
//
// This file is the package's interface — the only surface consumers may rely
// on. Anything not exported here is internal and may change without notice.
// Per-symbol documentation lives on the declarations in ./types.ts,
// ./driftCheck.ts and ./plane.ts, because TypeScript discards doc comments
// written on re-export statements.
//
// **What this package does, and what it refuses to do.** It measures how far
// the camera appears to have moved since an archive's images were shot, and it
// stops there. Correction — homography fitting, autoalign, fiducial markers —
// is out of scope by decision (issue #12 option 3, map #89): detection converts
// today's silent wrongness into a loud refusal, which is most of the safety
// value for a fraction of the effort. It also decides no verdicts: the number
// this returns becomes drift or not-drift against the UI's `MAX_DRIFT_TRACK_FRACTION`
// in `ui/src/driftSession.ts`, because refusing on it is the live view's policy,
// not the measurement's.
//
// One entry point, unlike `classifier` and `detector`. Those split to keep a
// platform's runtime out of the other platform's bundle; this package is
// dependency-free pure TypeScript with a hand-rolled FFT and runs identically
// in a browser and in Node — which it has to, because `tools/drift-bench` is a
// first-class consumer and validates the code that ships rather than a copy.

//── The check ────────────────────────────────────────────────────────────────
// A factory, not a constructor: the per-reference FFTs are fixed for a
// session's life, and a cache bolted onto a pure function is implementation
// leaking into caller folklore.
export { createDriftCheck } from './driftCheck.ts';
export type { DriftCheck, DriftResult, GrayPlane } from './types.ts';

//── Getting a plane ──────────────────────────────────────────────────────────
// What a browser caller holds is an `ImageData`, from a canvas it drew a video
// frame or an archive image into. `RgbaImage` is that shape written
// structurally so this package needs no DOM lib and Node can call it too.
export { fromImageData } from './plane.ts';
export type { RgbaImage } from './plane.ts';

// Withheld: the FFT, the block grid, and every part of the phase correlation.
// They are the implementation of one number, and the benchmark scores that
// number through `createDriftCheck` — the same path the UI takes — so nothing
// outside needs a seam into the middle. Tests import them directly.
//
// Withheld: `WORKING_WIDTH`. It is the resolution the correlation runs at, and
// exporting it would invite a caller to pre-resample — which is exactly the
// resolution normalization the module took on so that neither consumer has to
// know a live stream and an archive photo differ.
//
// Withheld: a threshold, a boolean, and anything else shaped like a verdict.
// See above: the drift tolerance is `ui/src/driftSession.ts`'s, and a copy here
// would give it a second home and an implied second owner.
