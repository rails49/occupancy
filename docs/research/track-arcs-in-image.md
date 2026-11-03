# How round a layout curve looks in the photos

Research note for [#289](https://github.com/rails49/occupancy/issues/289), part of map
[#287](https://github.com/rails49/occupancy/issues/287). Written 2026-11-01.

Question: a curve of track that is a circular arc on the layout, how far is its image from the
best-fitting circle in image pixels, and is that within 0.25 G (G = the track gauge in image
pixels at that place)? Does the planned fit of straights and circular arcs work in image pixels,
or must it work in layout coordinates?

Tags: [REPO] read from this repository or the user's archives, [DER] derived here,
[SIM] computed by the script described in § Method, [INF] my inference.

## Answer

1. A nadir camera (optical axis straight down) and a curve at one height give an exact circle
   in the image, at any camera height and any track height. The layout plane is parallel to
   the image plane, so the image is a scaled, rotated copy of it. [DER] [SIM]
2. Three things bend the circle: camera tilt, a grade along the curve, and lens distortion.
   Each grows with the arc's sweep. One circular arc sweeping 45° stays within 0.25 G for tilt
   up to 15° and grades up to 4% (0.19 G at most). At 90° it stays within 0.25 G for grades up
   to 4% and for tilt up to about 3° (5° gives 0.27–0.43 G with the camera at 1–1.5 m). At
   180° one arc fails under a few degrees of tilt, a 4% grade at any height tested, a 2% grade with the camera below 3 m, or
   3% barrel distortion; 1% barrel alone stays at 0.14 G. [SIM]
3. The user's layout is in the failing range for long curves. The camera is 1.5 m up, the
   calibration points put the tilt somewhere between 1° and 5°, and the photos show a helix
   and a raised level. A 180° N curve of 19" at 5° tilt, 4% grade and 2% barrel is 2.4 G from
   one circle. Split into two arcs it is 0.25 G; into three, 0.11 G. [REPO] [SIM]
4. Fitting in image pixels is good enough if the fit may use more than one arc for a long
   curve. Three pieces of 60° meet 0.25 G in the cases tested except 15° tilt at 1 m
   (0.33–0.38 G); 45° pieces meet it there too. The map allows compound curves at a cost per extra part, so this is a cost
   setting, not a new model. It does conflict with the map's test that "a curve seen as one
   radius comes out as one arc": under tilt or a grade, a long curve of one radius on the
   layout is not one radius in the photo. [SIM] [INF]
5. Fitting an ellipse arc instead of a circular arc removes the tilt term exactly. The image
   of a flat circle under any pinhole view is a conic, and the fit residual drops to 0.00 G.
   It leaves 0.18–0.20 G for a 180° arc on a 4% grade under a 1 m camera. Straights stay
   straight under tilt and grade; only distortion bends them. [DER] [SIM]
6. Fitting in layout coordinates is not needed, and the calibration cannot support it. It
   needs a camera pose (tilt and position) with a focal length, or a homography per height;
   the track height along every line; and a lens model. The calibration holds DPT and camera
   height only, and maps no image position to a layout position (SPEC § Calibration;
   [ADR 0015](../adr/0015-camera-height-corrects-scale.md): "position is not corrected
   because nothing uses image-to-layout positions"). The user's four-point calibrations fit a
   pinhole pose only with an assumed focal length, and leave 26–43 px (about 1 G) of
   reprojection error. A pose from them would carry about as much error as it removes. [REPO]
   [SIM]

## The user's archives

All `.r49` files under `~/rails49` other than conformance cases and the one-image `format-v4`
fixture. The six fixtures named in `docs/SYSTEM.md` live in `rails49/r49`'s `fixtures/` tree,
which is not on this machine; SPEC § Camera height gives their height as 1150 mm. [REPO]

| Archive | Scale | Image (px) | `camera_height_mm` | DPT | Calibration points |
|---|---|---|---|---|---|
| `data/ceiling-2026-10-28` | N | 8064 × 6048 | 1500 | 32.6 | 4 |
| `data/ceiling-2026-10-29` | N | 8064 × 6048 | 1500 | 32.6 | 4 |
| `data/ceiling-2026-10-29b` | N | 8064 × 6048 | 1500 | 32.4 | 4 |
| `data/ceiling-2026-10-29b` (`-t`) | N | 8064 × 6048 | 1500 | 32.5 | 4 |

- DPT is computed with SPEC § Reference points' formula (N gauge 1435/160 mm). G is the DPT,
  about 32.5 px, so 0.25 G is about 8 px. [REPO] [DER]
- Calibration extent: the four corners of the board, 2000 × 1000 mm, two at z 0 and two at
  z 80. In pixels they span 94–96% of the image width and 65–73% of its height. [REPO]
- Camera: iPhone 16 Pro Max, 1x main camera, 24 mm equivalent (DNG Exif
  `FocalLengthIn35mmFormat`), ProRAW. The DNG holds Linear Raw pixels and no `OpcodeList1–3`,
  so it carries no lens-correction step for a reader to apply. Any correction was applied
  before writing; how much distortion is left is not measured here. The 0.5x ultra-wide
  frames were left out of `ceiling-2026-10-29` because "the lens distorts more"
  (`data/ceiling-2026-10-29/README.md`). [REPO]
- Tilt. A pinhole pose fitted to the four points, with focal length 5591 px (24 mm
  equivalent over the diagonal) or 5376 px (over the width), gives tilt 3.5–5.3°, the camera
  at 1490–1550 mm over the middle of the board, and 31–43 px worst reprojection error. With
  the raised points' z left free, the fit puts them at z 0 and the tilt at 0.8–1.6°, with
  26–38 px error. Four points cannot tell tilt from the raised points' height. The 2026-10-28
  README reached the same reading ("camera tilt of about 5° would explain it"). The tilt is
  somewhere in 1–5°. [SIM] [REPO]
- `IMG_2903` shows a helix on the left of the board and a raised level on the right, so the
  layout has grades. [REPO]
- `data/ceiling-2026-10-29b/centerline-crops/curve.jpg` has a measured centerline of eight
  points over a 26° sweep of a curve of about 1090 px (about 300 mm) radius. One circle fits
  it within 1.0 px (0.03 G), inside the 2 px reading error its README states. An arc this
  short does not exercise the effects below. [REPO] [SIM]

## Why each effect bends the circle

Nadir camera, flat curve. A point at height z images at `f·ρ/(h − z)` from the nadir point
(`docs/research/camera-calibration.md` § 1). For fixed z that is a uniform scale, so a circle
stays a circle. [DER]

Tilt δ. In normalized image coordinates (x, y), turning the camera by δ about the x axis maps
the nadir image to approximately `x' = x(1 + δy)`, `y' = y + δ(1 + y²)`. The local scale is
`1 + δy` across and `1 + 2δy` along y, with shear δx: the image is stretched unequally by about
δ times the tangent of the off-axis angle. That is first order in δ, so a circle well off the
optical axis becomes a visible ellipse. The effect grows with tilt, with the curve's radius, and
with its distance from the axis over h, so lower cameras and curves near the frame edge are
worst. At the image centre the stretch is second order (cos δ). The exact image of a flat circle
is a conic, so an ellipse fits it exactly. [DER]

Grade g. Along an arc of radius R the track rises `g·R·θ` over a sweep θ: 61 mm for a 180° N
curve of 19" at 4%. The image scale at height z is `h/(h − z)` about the nadir point, so the
far end of the arc is drawn larger and shifted away from the nadir by `ρ·z/(h − z)`. The arc
becomes a spiral that drifts across the image. A single circle absorbs the average and leaves
the rest. [DER]

Barrel distortion. One radial term, `r' = r(1 − k·(r/r_corner)²)`, with k the shift at the image
corner as a fraction of the radius. A circle off the image centre becomes slightly egg-shaped.
The deviation is close to proportional to k: about 0.12–0.15 G per 1% for a 180° arc at the
worst placement. [SIM]

## Results

Worst placement on the layout, with the median over all placements in brackets, in units of
G. One circle per arc unless stated. HO layout 2400 × 1500 mm, N layout 2000 × 1000 mm. [SIM]

Tilt, flat arc, largest radius (HO 30", N 19"):

| Scale | Tilt | h | 45° | 90° | 180° |
|---|---|---|---|---|---|
| HO | 5° | 1 m | 0.07 (0.02) | 0.43 (0.15) | 1.35 (0.59) |
| HO | 5° | 1.5 m | 0.04 (0.01) | 0.28 (0.10) | 0.86 (0.38) |
| HO | 5° | 3 m | 0.02 (0.01) | 0.14 (0.05) | 0.46 (0.20) |
| HO | 15° | 1 m | 0.19 (0.06) | 1.26 (0.44) | 4.23 (1.68) |
| HO | 15° | 3 m | 0.07 (0.02) | 0.45 (0.16) | 1.59 (0.77) |
| N | 5° | 1 m | 0.06 (0.02) | 0.40 (0.14) | 1.98 (0.62) |
| N | 5° | 1.5 m | 0.04 (0.01) | 0.27 (0.09) | 1.31 (0.42) |
| N | 5° | 3 m | 0.02 (0.01) | 0.14 (0.05) | 0.69 (0.22) |
| N | 15° | 1 m | 0.17 (0.05) | 1.18 (0.40) | 5.90 (1.85) |
| N | 15° | 3 m | 0.07 (0.02) | 0.44 (0.16) | 2.28 (0.88) |

At 15° tilt and 1 m, the smaller radii are no better: 3.3–4.9 G for a 180° arc.

Grade, nadir camera:

| Scale, R | Grade | h | 45° | 90° | 180° |
|---|---|---|---|---|---|
| HO 30" | 2% | 1 m | 0.01 (0.01) | 0.11 (0.05) | 0.61 (0.36) |
| HO 30" | 2% | 3 m | 0.00 (0.00) | 0.04 (0.02) | 0.20 (0.12) |
| HO 30" | 4% | 1 m | 0.03 (0.01) | 0.22 (0.11) | 1.26 (0.73) |
| HO 30" | 4% | 3 m | 0.01 (0.00) | 0.07 (0.03) | 0.40 (0.24) |
| HO 18" | 4% | 1 m | 0.01 (0.00) | 0.12 (0.04) | 0.86 (0.28) |
| N 19" | 2% | 1 m | 0.01 (0.00) | 0.09 (0.04) | 0.69 (0.26) |
| N 19" | 2% | 3 m | 0.00 (0.00) | 0.03 (0.01) | 0.23 (0.09) |
| N 19" | 4% | 1 m | 0.02 (0.01) | 0.19 (0.08) | 1.41 (0.53) |
| N 19" | 4% | 3 m | 0.01 (0.00) | 0.06 (0.03) | 0.46 (0.17) |
| N 9.75" | 4% | 1 m | 0.01 (0.00) | 0.09 (0.03) | 0.66 (0.20) |

Barrel distortion, nadir camera, flat 180° arc. Once the layout fills the frame, h does not
matter:

| Corner distortion | HO 18" | HO 30" | N 9.75" | N 19" |
|---|---|---|---|---|
| 1% | 0.12 (0.02) | 0.12 (0.02) | 0.12 (0.02) | 0.14 (0.03) |
| 3% | 0.36 (0.07) | 0.38 (0.07) | 0.35 (0.07) | 0.43 (0.08) |
| 5% | 0.60 (0.11) | 0.64 (0.11) | 0.59 (0.12) | 0.72 (0.14) |
| 10% | 1.21 (0.23) | 1.33 (0.23) | 1.19 (0.24) | 1.49 (0.28) |

A 180° arc split into equal pieces, each fitted with its own circle:

| Case | 1 piece | 2 pieces | 3 pieces |
|---|---|---|---|
| HO 30", h 1 m, grade 4% | 1.26 (0.73) | 0.15 (0.09) | 0.04 (0.02) |
| HO 30", h 1 m, tilt 15° | 4.23 (1.68) | 0.87 (0.34) | 0.34 (0.12) |
| HO 30", h 1 m, tilt 15°, grade 4%, barrel 3% | 5.83 (1.77) | 1.05 (0.37) | 0.34 (0.13) |
| N 19", h 1 m, grade 4% | 1.41 (0.53) | 0.14 (0.07) | 0.05 (0.02) |
| N 19", h 1 m, tilt 15° | 5.90 (1.85) | 0.83 (0.30) | 0.33 (0.12) |
| N 19", h 1 m, tilt 15°, grade 4%, barrel 3% | 7.34 (1.90) | 0.99 (0.34) | 0.38 (0.13) |
| N 19", h 1.5 m, tilt 5°, grade 4%, barrel 2% (the user's case) | 2.39 (0.48) | 0.25 (0.09) | 0.11 (0.03) |

The user's N layout (2000 × 1000 mm, h 1.5 m), 180°, one circle:

| Tilt | Grade | Barrel | 9.75" | 11" | 15" | 19" |
|---|---|---|---|---|---|---|
| 1.5° | 0% | 0% | 0.22 (0.08) | 0.25 (0.09) | 0.33 (0.11) | 0.39 (0.12) |
| 1.5° | 4% | 2% | 0.81 (0.14) | 0.92 (0.17) | 1.23 (0.25) | 1.52 (0.36) |
| 5° | 0% | 0% | 0.74 (0.27) | 0.84 (0.31) | 1.09 (0.38) | 1.31 (0.42) |
| 5° | 4% | 2% | 1.23 (0.27) | 1.39 (0.31) | 1.89 (0.40) | 2.39 (0.48) |

On the same layout at 5° tilt, 4% grade and 2% barrel, a 19" arc is 0.39 G at 90° and 0.06 G at
45°.

Ellipse arc instead of circle, 180°, largest radius: 0.00 G under tilt 15° at 1 m and tilt 5°
at 1.5 m (flat track); 0.18 G (HO) and 0.20 G (N) on a 4% grade under a nadir camera at 1 m.

## Limits of these numbers

- The pieces are fitted independently, with no shared end point or tangent. A compound curve
  that must stay tangent at the joins will fit a little worse. [INF]
- Click error is not included. The crops' README puts reading error at about 2 px (0.06 G at
  DPT 34). [REPO]
- Worst cases are curves at the edge of the layout, farthest from the optical axis. The median
  is two to five times smaller. The 0.25 G limit is a worst-case limit; the map's working test,
  "looks right on the overlay", is stricter. [SIM] [REPO]
- Distortion is one radial term. Real lenses add higher terms and decentring. The archive
  images' remaining distortion is not measured; the board edges or long straights in a frame
  would measure it. [INF]
- The user's tilt is known only to 1–5°. Measuring it needs either a fifth calibration point
  off the board's two planes or a check that the far edge really is at z 80. [INF]

## Method

Scripts were run with `uv run --with numpy --with scipy` in the session scratchpad and are not
kept in the repo. What they do, so the numbers can be recomputed:

- Camera: pinhole at height h above layout zero, pitched by the tilt toward the layout's long
  side and placed so its axis meets the layout centre. Focal length set so the layout corners
  fill 95% of a 4:3 frame in the tighter direction. Optional one-term barrel distortion as in
  § Why each effect bends the circle.
- Arc: radius R, sweep 45°, 90° or 180°, starting at z 0 and rising at the grade along its
  length, 120 points. Every placement with the arc on the layout: centres on a 100 mm grid,
  start angles every 30°.
- Fit: algebraic circle fit, refined by geometric least squares. Deviation is the largest
  distance of a projected point from the fitted circle, divided by G, the mean image distance
  between the arc and a copy offset by one gauge sideways at the same height.
- Ellipse: geometric least squares on centre, two semi-axes and angle.
- Archive pose: `scipy.optimize.least_squares` on rotation and camera position, principal point
  at the image centre, focal length fixed at the 24 mm equivalent.
