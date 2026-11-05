# What a camera nobody touched reads on the drift check

Research note for [#338](https://github.com/rails49/occupancy/issues/338), recording the readings
taken in [#336](https://github.com/rails49/occupancy/issues/336). Written 2026-11-05.

Question: `MAX_DRIFT_TRACK_FRACTION` was 0.25, a number argued from geometry and validated only on
synthetic warps. On a real rig, what does the check read when the camera has not been moved, and
where does a tolerance have to sit to accept that?

Tags: [REPO] read from this repository or the user's archives, [MEAS] measured on the ceiling rig
and reported in #336, [DER] derived here, [INF] my inference.

## Answer

1. **The tolerance was below the check's own step.** The check correlates at `WORKING_WIDTH` 960
   and scales the result back, so on the ceiling rig's 8064-px-wide frames one working pixel is
   8.4 reference pixels — **0.257 of a track width** at DPT 32.6–32.7. A tolerance of 0.25 G is
   8.2 px: smaller than the smallest non-zero number the check can report. Any reading other than
   an exact zero was past it. [REPO] [DER]
2. **An untouched phone does not read zero.** Of 32 frames from a camera nobody had moved between
   shots, **18 read past 0.25 G** — that is, 18 reported at least one step. [MEAS]
3. **0.5 G is the first value that admits one step and nothing more.** It is 16.3 px at DPT 32.6,
   so a one-step reading (0.258 G) passes and a two-step reading (0.515 G) is still refused. The
   tolerance keeps a refusal available for real movement while no longer firing on the
   quantization of its own measurement. [DER]
4. **It is provisional.** One rig, one camera, one mount, and the frames were not independently
   verified to be free of movement — see § What was not measured. The readings that would settle
   the number come from the occupancy service's own check,
   [rails49/occupancy-service#12](https://github.com/rails49/occupancy-service/issues/12). Until
   those exist, 0.5 G is the value the measurements rule out least, not a value they establish, and
   the live view's refusal keeps its override. [INF]

## The rig

The ceiling capture described in `README.md` § Capture, and the archives
`docs/research/track-arcs-in-image.md` § The user's archives reads from. [REPO]

| | |
|---|---|
| Camera | iPhone 16 Pro Max, 1x main camera (24 mm equivalent), ProRAW 48 MP |
| Mount | Face down on the ceiling, about 1500 mm above the layout, shutter from an Apple Watch |
| Frames | 8064 × 6048, JPEG at quality 95 via `bin/dng-to-jpeg.py` |
| Scale | N (gauge 1435/160 mm) |
| DPT | 32.4–32.6 across the three `ceiling-*` archives |
| Archives | `data/ceiling-2026-10-28`, `data/ceiling-2026-10-29`, `data/ceiling-2026-10-29b` |

One track width — one G — is therefore about 32.5 px of a reference frame. [REPO] [DER]

## Why one step is 0.257 G

`createDriftCheck` resamples every plane to `WORKING_WIDTH` 960 px wide, correlates there, and
reports `best * pxScale` with `pxScale = refs[0].width / width`. The correlation peak is taken at
**integer lag** with no sub-pixel interpolation — deliberately, so that an unmoved frame reads a
hard zero rather than a noise floor (`lib/drift/src/phaseCorrelation.ts`,
[#92](https://github.com/rails49/occupancy/issues/92)). The reported displacement is therefore a
multiple of `pxScale`. [REPO]

On this rig `pxScale = 8064 / 960 = 8.4`, so the reported readings and the two tolerances line up
like this: [DER]

| reading | reference px | track widths | past 0.25 G (8.2 px)? | past 0.5 G (16.3 px)? |
|---|---|---|---|---|
| 0 steps | 0.0 | 0.000 | no | no |
| 1 step | 8.4 | 0.258 | **yes** | no |
| 2 steps | 16.8 | 0.515 | yes | **yes** |
| 3 steps | 25.2 | 0.773 | yes | yes |
| 4 steps | 33.6 | 1.031 | yes | yes |

The row that matters is the second: at 0.25 G the tolerance sat *between* zero and one step, so the
check could only ever report "steady" or "refuse" with nothing in between. That is the shape of a
detection floor, not of a tolerance, and `tools/drift-bench`'s own README has said since #92 that
the two are different things. [DER] [INF]

The step shrinks with the frame: a 1920-px-wide archive gives `pxScale` 2.0, and at that archive's
DPT the step is a far smaller fraction of a track width. The ceiling rig is the bad case because it
is the widest frame and the lowest DPT at once — 48 MP of an N-scale layout from 1500 mm. [DER]

## The readings

From #336, on the rig above, frames shot in one session with the mount untouched between
shutters: [MEAS]

| | frames |
|---|---|
| Total | 32 |
| Past 0.25 G, the tolerance before #338 | 18 |
| Past 0.5 G, the tolerance now | not transcribed — see below |

**Not transcribed here.** #336's comment holds the per-frame readings and the scripts that produced
them, and that comment is the record. This note carries the figures #338's brief states — 0.257 G
per step and 18 of 32 past 0.25 G — and derives the rest from the repository. The count past 0.5 G
is in #336 and is deliberately not restated from memory; a number invented to fill a table would be
worse than a pointer. Reconstructing the table means re-running #336's scripts against the
`ceiling-*` archives. [INF]

What the 18 of 32 does establish, with no further data: more than half the frames of an untouched
camera were refused, so the old tolerance was not distinguishing drift from no drift on this rig at
all. [DER]

## Method

As #336 describes it: build a drift check against each `ceiling-*` archive's `images[0]` through
`createDriftCheck`, run every other image of the same archive through `check()`, and read
`displacementPx`. That is the `--refs first` arrangement `tools/drift-bench` already offers and the
one the live view uses ([#118](https://github.com/rails49/occupancy/issues/118)); the readings are
in the reference frame, which is `camera.resolution`. Convert to track widths by dividing by the
archive's DPT, which is the same division `maxDriftPx` does in the other direction. [REPO]

No synthetic warp is applied. That is the difference from `tools/drift-bench`, whose must-flag
grades are warps of tripod shots: these are separate exposures of a scene through a mount that was
left alone, so whatever they read is the floor a real deployment starts from. [REPO] [INF]

## What was not measured

* **Whether the camera really did not move.** Nobody touched the mount, which is not the same as
  the mount not moving. A ceiling bracket with a phone on it, triggered from a watch, can settle or
  flex; the readings cannot separate that from the check's own noise, and so neither can this note.
  This is the largest open question behind the number. [INF]
* **Any second rig.** One camera, one mount, one layout, one scale, one frame size. Nothing here
  says what a tripod, a lower mount, an HO layout or a 1920-px archive reads. [INF]
* **Where occupancy actually breaks.** The geometric argument — a sensor fails when it slides off
  its car or onto a neighbouring track's, and both sit about one track width away — is still an
  argument. No one has measured the displacement at which a sensor's answer goes wrong, which is
  the quantity the tolerance is nominally about. 0.5 G is bounded above by that argument and below
  by these readings, and the gap between the bounds is one step wide. [INF]
* **The rate of real drift.** How often a ceiling mount drifts past 0.5 G over a session, or a
  week, is unknown. It is why the refusal carries an override rather than being a hard stop
  ([ADR 0020](../adr/0020-only-the-live-view-measures-drift.md)). [REPO]
* **Sub-pixel reporting.** Interpolating the correlation peak would shrink the step and make the
  tolerance a free choice again rather than one pinned to a quantum. That is a change to the check,
  out of scope for #338, and #92's reason for integer lag — an exact zero for an unmoved frame —
  would have to be given up or reworked. [INF]

## Where the number lives

`MAX_DRIFT_TRACK_FRACTION` in `ui/src/driftSession.ts`, multiplied by a DPT in `maxDriftPx` and
nowhere else ([ADR 0020](../adr/0020-only-the-live-view-measures-drift.md),
`docs/SYSTEM.md` § Workspace packages). `SPEC.md` § Image Alignment states the basis and points
here; neither document carries a second copy of the value. [REPO]
