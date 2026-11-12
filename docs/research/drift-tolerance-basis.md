# What sets the drift tolerance

Research note for [#338](https://github.com/rails49/occupancy/issues/338), recording the measurements
in [#336's comment](https://github.com/rails49/occupancy/issues/336#issuecomment-6654937791). Written
2026-11-08. Supersedes [drift-tolerance-measured.md](drift-tolerance-measured.md), which was written
without that comment.

Question: `MAX_DRIFT_TRACK_FRACTION` was 0.25, a number argued from geometry and validated only on
synthetic warps. How much does a shifted camera cost the classifier, what does the check read from a
camera nobody moved, and where does the tolerance have to sit?

Tags: [REPO] read from this repository or the user's archives, [MEAS] measured in #336, [DER]
derived here or in #336.

G is one track gauge, 9 mm in N. DPT is pixels per G, so a tolerance of 0.5 G is `0.5 · DPT` pixels.

## Answer

1. Up to 0.5 G the classifier's error rates move little. The largest change is false occupied near an
   end, from 27% to 38%. Past 0.5 G the false-occupied rates climb faster: elsewhere it is 4.3%,
   7.4% and 13.1% at 0.5, 0.75 and 1 G. At 0.5 G the worst fold's false clear inside a train is
   0.97%. The classifier's target is 0.1%, which one fold already misses at 0.25 G (0.32%). [MEAS]
2. On the whole frame, every photo from an untouched phone read zero or one step of the check. One
   step is 0.257–0.259 G on the ceiling rig, so none read past 0.5 G, and 18 of 32 read past 0.25 G,
   the tolerance before #338. Crops toward the corners read up to 0.49 G. [MEAS] [DER]
3. #336 set the tolerance at 0.5 G: all 32 photos pass, and the worst fold keeps false clear inside a
   train under 1% (decision 3).
4. It is provisional. One rig, one camera, one classifier. The readings that confirm or change it
   come from the occupancy service on a 2018 Mac mini, Ubuntu 26.04
   ([rails49/occupancy-service#12](https://github.com/rails49/occupancy-service/issues/12)). Until
   then the live view's refusal keeps its override. [INF]

## Classifier error against camera shift

The 1× model from [rails49/classifier#4](https://github.com/rails49/classifier/issues/4). Each fold
scores its held-out archive at that fold's threshold. Each patch is cut from a position moved by the
shift in four image directions, with the label kept at the true position. Positions: all near a train
end and beside a car, 4,000 inside a train and 6,000 elsewhere, so read the rates per column and do
not pool them. The zero-shift row reproduces the published baseline for near-end and beside-car
positions. [MEAS]

| Shift (G) | False clear, inside a train | False clear, near an end | False occupied, near an end | False occupied, beside a car | False occupied, elsewhere |
|---|---|---|---|---|---|
| 0 | 0.00% | 1.03% | 27.45% | 15.45% | 2.55% |
| 0.125 | 0.03% | 0.89% | 28.92% | 16.82% | 2.74% |
| 0.25 | 0.10% | 0.82% | 31.05% | 15.68% | 3.15% |
| 0.5 | 0.28% | 1.52% | 37.58% | 19.55% | 4.30% |
| 0.75 | 0.52% | 2.82% | 41.50% | 28.18% | 7.39% |
| 1 | 0.57% | 4.05% | 49.35% | 37.05% | 13.12% |
| 1.5 | 0.39% | 5.37% | 68.63% | 56.14% | 32.73% |
| 2 | 0.69% | 7.68% | 77.45% | 69.77% | 50.32% |
| 3 | 7.72% | 16.87% | 74.02% | 74.77% | 54.19% |

By fold: false clear inside a train, then false occupied elsewhere. Fold 10-29's threshold is
0.00004, which inflates its false occupied. [MEAS]

| Shift (G) | 10-28 | 10-29 | 10-29b |
|---|---|---|---|
| 0 | 0.00%, 0.00% | 0.00%, 6.88% | 0.00%, 0.07% |
| 0.25 | 0.32%, 0.04% | 0.00%, 8.40% | 0.02%, 0.15% |
| 0.5 | 0.97%, 0.00% | 0.00%, 11.58% | 0.00%, 0.15% |
| 0.75 | 1.75%, 0.20% | 0.00%, 19.50% | 0.04%, 0.55% |
| 1 | 1.94%, 0.72% | 0.00%, 32.76% | 0.02%, 3.14% |
| 1.5 | 1.27%, 11.88% | 0.00%, 56.12% | 0.06%, 30.27% |
| 2 | 2.20%, 35.68% | 0.05%, 65.93% | 0.12%, 49.78% |
| 3 | 15.60%, 42.75% | 2.20%, 68.68% | 7.57%, 50.37% |

## How far real photos moved

The rig is the ceiling capture in `README.md` § Capture: an iPhone 16 Pro Max face down about
1500 mm above an N-scale layout, ProRAW 8064 × 6048. The three `ceiling-2026-10-*` archives have DPT
32.45, 32.55 and 32.65. [REPO]

The shipped check ran on the 32 non-reference photos in those archives, each against its archive's
`images[0]`. The phone was not touched within an archive. It was taken down between 10-28 and 10-29,
and left up between 10-29 and 10-29b. [MEAS]

| Comparison | Result |
|---|---|
| Whole frame, within an archive | Only 0 or one step; one step is 0.257 G on this rig |
| Photos past 0.25 G | 18 of 32, all at that one step |
| Full-resolution crop at the image centre | 0–0.12 G |
| Full-resolution crops toward the corners | Up to 0.49 G |
| Archive 10-28 against 10-29 (remount) | 5.5 G |
| Archive 10-29 against 10-29b (left up) | 0.26 G |

On the OBSBOT at DPT 19.5 at 4K one step of the check is 0.205 G. In N on the OBSBOT at 1.33 m,
0.25 G is 2.25 mm on the layout or about 0.1° of tilt, and 0.5 G is 4.5 mm or about 0.2°. [DER]

The scripts for the sweep, the whole-frame readings and the crops are in #336's comment.

## Why one step is 0.257–0.259 G

`createDriftCheck` resamples every plane to `WORKING_WIDTH` 960 px wide and splits it into
`BLOCK_SIZE` 128 px blocks. Each block reports `hypot(dx, dy)` of its correlation peak's integer lag,
with no sub-pixel interpolation, so an unmoved frame reads zero rather than a noise floor
([#92](https://github.com/rails49/occupancy/issues/92)). The frame's reading is the median over the
blocks, scaled back to the reference by `pxScale = refs[0].width / 960`
(`lib/drift/src/phaseCorrelation.ts`, `lib/drift/src/driftCheck.ts`). [REPO]

On the ceiling rig the working plane is 960 × 720, 7 × 5 = 35 blocks. With an odd count the median is
one block's value, so the frame reads one of the lags below, times `pxScale` 8.4. Across DPT
32.45–32.65: [DER]

| lag | working px | reference px | G | past 0.25 G? | past 0.5 G? |
|---|---|---|---|---|---|
| (0, 0) | 0.000 | 0.0 | 0.000 | no | no |
| (1, 0) | 1.000 | 8.4 | 0.257–0.259 | yes | no |
| (1, 1) | 1.414 | 11.9 | 0.364–0.366 | yes | no |
| (2, 0) | 2.000 | 16.8 | 0.515–0.518 | yes | yes |
| (2, 1) | 2.236 | 18.8 | 0.575–0.579 | yes | yes |

At 0.25 G the tolerance sat between zero and one step, so on this rig the check could report only
"steady" or "refuse". [DER]

With an even block count the median is the mean of the two middle blocks, so a frame can read half a
step. A 1920 × 1080 archive works at 960 × 540, 7 × 4 = 28 blocks, and can read 0.5 working px.

What sets the step in G is DPT per working pixel: DPT divided by `pxScale`. The ceiling rig has about
32.5 / 8.4 = 3.9, the OBSBOT at 4K 19.5 / 4 = 4.9, and a 1920-px archive at DPT 18 has 18 / 2 = 9.
The ceiling rig has the coarsest step of the three. [DER]

## What was not measured

#336's list, plus one item:

* USB video. These are iPhone ProRAW stills.
* Rotation and scale change. The classifier sweep is a uniform shift.
* The 2× model and the detector. By geometry the detector has about 1 G of sideways slack from the
  car width (SPEC § The occupancy test). [REPO] [DER]
* A noise floor for the corner crops, so 0.49 G may overstate the real movement. The corners read
  more than the centre, which a mount that settled or tilted between shots would also produce; these
  readings cannot tell the two apart. [INF]
* Any second rig. One camera, one mount, one layout, one scale.

## Where the number lives

`MAX_DRIFT_TRACK_FRACTION` in `ui/src/driftSession.ts`, multiplied by a DPT in `maxDriftPx` and
nowhere else ([ADR 0020](../adr/0020-only-the-live-view-measures-drift.md)). `SPEC.md` § Image
Alignment states the basis and points here. [REPO]
