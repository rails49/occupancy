# @occupancy/drift-bench

Synthetic camera-drift benchmark for [issue #91](https://github.com/rails49/occupancy/issues/91),
under [Map: camera-drift detection](https://github.com/rails49/occupancy/issues/89).

No real drifted frame exists — the fixture corpus was shot with a static
camera — so drift is synthesized. Each fixture image becomes a set of cases
against its own archive's *other* images as references:

* **must-flag**: the image warped by graded homographies — translation
  (2/5/10/20 px), rotation (0.5/1/2°), scale (±1/2 %), a perspective tilt,
  and a combo (5 px + 0.5° + brightness shift). All magnitudes are in the
  benchmark's working resolution (960-wide frames).
* **must-pass**: the unmodified image against its siblings (legitimate scene
  change: rolling stock moved between frames) and photometric perturbations
  (brighter/darker/contrast/gamma — the room's lighting changed, the camera
  did not).

Every image in every case is cropped by one shared border margin that covers
the largest displacement any grade inflicts, so the invalid border pixels a
synthetic warp drags in never reach a scorer, and pass and flag cases are
treated identically.

A candidate implements `Scorer` (`src/harness.ts`): `(frame, refs) → score`,
higher = more drift, continuous — thresholding is the harness's job. The
report gives per-grade score distributions, AUC against the pass set, and
detection rate at the zero-false-alarm threshold.

## What it scores, and why that matters

The default scorer is **`phasecorr`, which is `@occupancy/drift` itself** —
`src/phasecorr.ts` is an adapter around `createDriftCheck` and holds no
arithmetic of its own. That is the point: the benchmark exists to validate the
code the UI runs, so a scorer carrying its own copy of the algorithm would grade
the copy and pass while the shipped path failed. The throwaway prototype that
proved the approach ([#92](https://github.com/rails49/occupancy/issues/92)) lived in
`src/prototype/` on a `drift-prototype` branch; it is gone, and nothing should
take its place.

Latest full run (46 fixture images, 736 cases, ~10 min on a 2017 i7):

| scorer | overall AUC | pass max | flag min | det@0FA |
| :-- | :-- | :-- | :-- | :-- |
| mad | 0.596 | 0.245 | 0.020 | 0% |
| zmad | 0.915 | 0.783 | 0.081 | 4–15% |
| **phasecorr** | **1.000** | **0.00000** | **1.00000** | **100%** |

Every one of the 230 must-pass cases scores **exactly 0** — the correlation peak
is taken at integer lag, so an unmoved frame reads a hard zero rather than a
noise floor — and every must-flag grade is detected at the zero-false-alarm
threshold, down to 2 px of translation and the perspective tilt. The score is
interpretable: `flag:translate-10px` reads a median of 10.00000.

That gap is the check's **detection floor** — it says how little the check can
resolve, not how much occupancy tolerates. The tolerance is
`MAX_DRIFT_TRACK_FRACTION` in `ui/src/driftSession.ts`, a quarter of a track
width, and it is deliberately far above this: the number that matters is the
displacement at which a sensor stops sitting on the car it reads. Its comment
there gives the derivation.

## Running

The fixtures live in [rails49/r49](https://github.com/rails49/r49) `fixtures/`;
clone it beside this repo (`../r49`), or point `--fixtures` at it.

```bash
pnpm --filter @occupancy/drift-bench bench
pnpm --filter @occupancy/drift-bench bench -- --scorer zmad --archive lighting --json report.json
```

`--refs first` scores each image against its archive's `images[0]` alone, the
reference the UI uses ([#118](https://github.com/rails49/occupancy/issues/118)).
The default, `--refs siblings`, scores it against the archive's other images.

`phasecorr` is the default. The naive pixel baselines `mad` and `zmad`
(`src/baseline.ts`) stay reachable by name: they prove the harness end to end and
put a number on why structural comparison was needed at all — `zmad` tops out at
AUC 0.915 because the lighting archive's legitimate variation scores like drift.
A table without them loses the comparison that justifies the approach.

A full run rebuilds each case's reference spectra from scratch, which the UI does
once per session — so this pays setup 736 times. It measures separation, not
throughput; use `--archive` to scope a run while iterating.
