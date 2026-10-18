# Identifiable camera models from typed correspondences, and the planar fit's error

Written 2026-08-05. Research note on [issue #134](https://github.com/iot49/rails49/issues/134) (part of map #125,
graduated from the non-planarity fog patch #103): what the current equal-`z` planar scale fit
(`getDPT`, `lib/r49/src/manifest.schema.ts`) actually mis-measures under a pinhole camera, which
camera models the hand-typed 3D↔2D calibration points can identify at what point counts and noise
sensitivity, what one authored scalar (camera height or focal length) buys, and where
orthorectification practice puts the correction. This note surfaces facts; the calibration-model
decision is [#135](https://github.com/iot49/rails49/issues/135)'s.

*Researched 2026-08-05. Sources: OpenCV 4.x calib3d documentation (resolves to 4.13.0 — quoted
sentences read from the page text directly); Sturm & Maybank, CVPR 1999 (text extracted from the
[paper PDF](http://robots.stanford.edu/cs223b04/JeanYvesCalib/papers/sturm99.pdf)); Zhang,
MSR-TR-98-71 / TPAMI 2000; Abdel-Aziz & Karara 1971 (the original DLT paper, republished PE&RS
81(2), 2015); the Exif 2.32 specification
([CIPA DC-X008-2019](https://www.cipa.jp/std/documents/e/DC-X008-Translation-2019-E.pdf), tag
definitions quoted verbatim from the spec PDF); the W3C MediaStream Image Capture spec; USGS
orthoimagery definitions; and derivations worked here with every step shown. Numbers use this
repo's constants: HO model gauge 1435/87 ≈ 16.49 mm, `min_dpt` 20,
`max_drift_track_fraction` 0.25 (`config.yaml`).*

---

## Verdict, by sub-question

1. **The planar fit's error has a closed form, and `f` is not in it.** A nadir pinhole at height
   *h* over layout zero images features at height *z* with scale `f/(h−z)`; relative to the fitted
   z=0 plane every length at height *z* reads **`z/(h−z)` too large**, and a point at horizontal
   radius ρ from the nadir maps onto the z=0 plane **displaced outward by `ρ·z/(h−z)`** —
   photogrammetry's *relief displacement*. For the ticket's case (h ≈ 1 m, track z 0–85 mm,
   scenery to 230 mm): **scale +9.3% at track height, +30% at scenery height**, and a corner of a
   2×1 m layout at z = 85 mm is mapped **104 mm (6.3 track gauges, ~126 px at DPT 20) off** — 25×
   the drift gate's whole budget. Focal length cancels from every ratio; camera height is the
   lever (h = 2 m halves everything). The formula usable as a warning threshold is
   `ε(z) = z/(h−z)`, and `getDPTResidual` already fires on mixed-height calibration sets at ~40×
   the click-noise floor. (§1)
2. **From typed points alone, coplanarity is what breaks first — as identifiability, then as
   conditioning.** All points at one height: only a homography (4 points, no 3 collinear) is
   identifiable; the projection matrix's z-column is untouched by the data, and lifting the
   homography to (f, pose) is **singular exactly in this geometry** — "a plane parallel to the
   image plane, allows to estimate the aspect ratio, but no other parameters" (Sturm & Maybank).
   Full DLT needs ≥ 6 **non-coplanar** points (OpenCV; Abdel-Aziz & Karara), and an 85 mm z-spread
   under a 1 m camera is near-coplanar: the depth signal is the 9% differential scale, so errors
   amplify ~10×. With ~1 px clicks the spread *is* usable — via per-plane scale fits with long
   baselines (≥ 500 mm ⇒ h to ~3%), not via raw DLT. Typed-mm error (±1 mm) is negligible against
   click error at those baselines. (§2)
3. **One authored scalar — camera height h — collapses the whole problem; focal length does
   not.** With h known, the current fit generalizes in closed form (`m(z) = m(0)·h/(h−z)`) with
   **zero additional points**, and the correction's own error is `(z/(h−z))·(Δh/h)`: a tape
   measure good to ±20 mm leaves 0.19% residual scale at track height versus 9.3% uncorrected —
   ~50×. h is also *derivable* from points at two heights (h = z·R/(R−1) from the plane-scale
   ratio R), so points alone remain sufficient in principle; the scalar substitutes for the second
   plane and beats it on robustness. Focal length helps only through planar PnP (≥ 4 coplanar
   points, known f ⇒ full pose incl. h), and its provenance is weak: every Exif focal tag is
   **optional**, `FocalLength` is in mm and needs the also-optional focal-plane resolution to
   become pixels, and the live path has no Exif at all — the W3C Image Capture spec exposes zoom
   and focus distance but **no focal length**. (§3)
4. **Prior art corrects at product generation, and a plane warp would not fix the cars.**
   Photogrammetry orthorectifies before anyone measures or annotates: an orthoimage is one "in
   which displacements (distortions) caused by terrain relief and camera tilts have been removed"
   (USGS). But a conventional ortho corrects to a terrain model and elevated objects still lean —
   the true-orthophoto/DSM distinction exists because of it — and correspondingly, warping frames
   to the z=0 plane leaves everything at track height displaced by exactly the relief term. The
   correction that fixes cars is per-height and coordinate-level, not an image warp. Warping a
   training corpus is not toxic per se (a perspective warp is inside detectors' standard
   augmentation family — Ultralytics ships a `perspective` hyperparameter), but it bakes
   irreversible resampling and per-layout geometry into pixels, against this repo's own precedent
   (#130) of keeping authoring in full-frame pixels and doing geometry between capture and
   `occupancy()`. (§4)

---

## Legend

| Tag | Meaning |
|---|---|
| **[DOC]** | Stated in official documentation or a standard (OpenCV, CIPA/Exif, W3C, USGS, Ultralytics). Link given. |
| **[LIT]** | Published, peer-reviewed literature. Quotes read from the paper text itself. |
| **[DER]** | Derived in this note, steps shown. |
| **[REPO]** | Read from this repository. |
| **[INF]** | My inference. Not sourced — argued. |

---

## 1. The planar fit's error under a pinhole camera

### Setup and derivation

Model: pinhole camera, optical center at height *h* above layout zero (z = 0), optical axis
pointing straight down (nadir view — the tilt caveat is at the end of this section). Focal length
*f* in pixels. A world point at height *z* and horizontal radius ρ from the point directly under
the camera sits at depth (h − z) and images at radius

```
r = f · ρ / (h − z)          [DER]
```

**Scale.** The local magnification for features at height z is `m(z) = f/(h−z)` px/mm. The planar
fit calibrates `m(0) = f/h` (when its pairs sit at z = 0), so every length measured at height z
reads

```
m(z)/m(0) = h/(h−z)  ⇒  relative scale error ε(z) = z/(h−z)          [DER]
```

**Position.** Back-projecting an image point onto the z = 0 plane (which is what any planar
mapping does) lands it at ρ′ = r·h/f = ρ·h/(h−z), i.e. displaced radially outward from the nadir
by

```
Δρ = ρ · z/(h−z)   (world mm)        Δr = r · z/h   (image px)          [DER]
```

This is the classical photogrammetric *relief displacement* of a vertical photograph, d = r·Δh/H
(Wolf, Dewitt & Wilson, *Elements of Photogrammetry with Applications in GIS*, 4th ed.) **[LIT]**
— the same expression with H the flying height. It grows linearly from the nadir and is zero only
there.

**What f does and does not affect.** Both error expressions are depth ratios; *f cancels
entirely* **[DER]**. Focal length enters only through coverage: framing a 2×1 m layout
(half-diagonal 1118 mm) from height h needs a semi-diagonal view angle `atan(1118/h)` —

| h | semi-diagonal angle | diagonal FOV | ≈ 35mm-equivalent needed |
|---|---|---|---|
| 1.0 m | 48.2° | 96° | ≤ 19 mm (ultrawide) |
| 1.5 m | 36.7° | 73° | ≤ 30 mm |
| 2.0 m | 29.2° | 58° | ≤ 39 mm (normal phone wide) |

so a low mount forces an ultrawide lens, whose barrel distortion this note's pinhole model does
not even include — height helps twice. **[DER]**

### The concrete case (#103): 2×1 m layout, camera ~1 m up

Scale error `ε(z) = z/(h−z)`:

| | z = 35 mm | z = 85 mm (track max) | z = 230 mm (scenery) |
|---|---|---|---|
| **h = 1.0 m** | +3.6% | **+9.3%** | +29.9% |
| **h = 1.5 m** | +2.4% | +6.0% | +18.1% |
| **h = 2.0 m** | +1.8% | +4.4% | +13.0% |

Relief displacement `Δρ = ρ·z/(h−z)`, camera over the layout center (ρ_max = 1118 mm), expressed
against this repo's units — one HO track gauge = 16.49 mm, drift refusal at 0.25 gauge
(`max_drift_track_fraction`) **[REPO]**:

| position, h = 1 m | z = 85 mm | z = 230 mm |
|---|---|---|
| mid-frame (ρ = 500 mm) | 46 mm = 2.8 gauges | 149 mm = 9.0 gauges |
| corner (ρ = 1118 mm) | **104 mm = 6.3 gauges ≈ 126 px @ DPT 20** | 334 mm = 20.2 gauges |

The radius inside which track-height displacement stays under the drift gate's 0.25-gauge budget
is `ρ ≤ 0.25·gauge·(h−z)/z` = **44 mm** at h = 1 m — effectively nowhere. At h = 2 m the corner
displacement is still 3.0 gauges. **[DER]**

Two readings of these numbers matter for how alarming they are:

* **The scale error is live today.** DPT feeds `carWidthPx`, the drift tolerance in pixels, the
  `min_dpt` gate, and (once #130 lands) the DPT-normalization resample factor — a 9% DPT bias is
  a 9% error in all of them. **[REPO]**
* **The position error is mostly latent.** Sensors, spans and detections all live in the same
  image pixels; nothing currently maps image↔world positions, so the 104 mm is not corrupting a
  running computation — it is the error *any future* px↔mm position mapping inherits from a
  planar model, and the reason a plane warp does not straighten a layout (§4). **[INF]**

### What it does to `getDPT` and what `getDPTResidual` already sees

`equalHeightPairs` admits pairs at *any* equal z, not just z = 0 **[REPO]**. A pair at height z
fits scale `f/(h−z)`: pairs at track height report a DPT 9.3% higher (h = 1 m) than pairs at
layout zero, and a mixed-height set makes the least squares blend scales up to that far apart,
weighted by `Σd_mm²`. The blend is exactly what the residual was built to expose: a 500 mm
baseline pair at z = 85 disagreeing with a z = 0 fit at DPT 20 contributes a residual of
`s·d_mm·ε ≈ 1.21 × 500 × 0.093 ≈ 56 px`, against a click-noise floor of ~√2 px — a 40× margin.
**[DER]** So mixed-height authoring is already loudly visible in the editor's residual; what the
planar fit cannot see is the *uniform* bias of a set authored all at one nonzero height, which is
indistinguishable from a different camera distance (and is, in fact, the same thing).

**Warning-threshold form.** The quantity a warning should bound is `ε = Δz/(h−Δz)` with Δz the
height difference between where calibration was authored and where measurements are consumed
(track height for cars). Since h is unknown to the current format, the honest threshold is stated
in Δz at an assumed h — e.g. at h ≥ 1 m, Δz ≤ 10 mm keeps ε ≤ 1%. Picking the number is #135's
call; the formula and the table above are the inputs. **[DER]**

**Tilt caveat.** All of the above assumes nadir view. A tilt of δ makes scale anisotropic across
the frame at order `tan δ · ρ/h` and moves the zero-displacement point off the image center; the
per-point formulas still hold with (h − z) replaced by depth along the axis. Tilt strictly adds
error to a planar fit — the nadir numbers above are the floor, not the ceiling. **[INF]**

---

## 2. Identifiability from typed points

The authoring reality being modeled: N correspondences, world side hand-typed in mm (exact typed
values, physical measurement error ~±1 mm), image side hand-clicked (~1 px). What can be fit, at
what minimum N, and what breaks:

| Model | Unknowns | Minimum points | Source |
|---|---|---|---|
| Per-plane scale (the current `getDPT`) | 1 per height plane | 2 (one equal-z pair) per plane | **[REPO]** |
| Homography per height plane | 8 | 4 in that plane, no 3 collinear | **[DOC]** OpenCV: RANSAC minimal subsets are "of four pairs each, collinear pairs are discarded" ([findHomography](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html)) |
| Planar PnP, intrinsics known | 6 (pose) | 4 coplanar — "With SOLVEPNP_IPPE input points must be >= 4 and object points must be coplanar. Returns 2 solutions"; ITERATIVE's "Initial solution for planar 'objectPoints' needs at least 4 points" | **[DOC]** [solvePnP](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html) |
| General PnP, intrinsics known | 6 | "The minimum number of points is 4 in the general case"; P3P "need 4 input points to return a unique solution" (3 give up to 4 solutions) | **[DOC]** solvePnP |
| Full DLT (P, 11 dof: pose + intrinsics) | 11 | ≥ 6 **non-coplanar** — "Initial solution for non-planar 'objectPoints' needs at least 6 points and uses the DLT algorithm" | **[DOC]** solvePnP; **[LIT]** Abdel-Aziz & Karara 1971 (republished [PE&RS 81(2), 2015](https://doi.org/10.14358/PERS.81.2.103)) |

### What breaks first: coplanarity, twice

**As identifiability.** If every point sits at one height, write the projection of (x, y, z₀, 1):
only columns 1, 2 and 4 of the 3×4 matrix P are exercised; **column 3 — the z column — appears
nowhere in the equations and is completely unconstrained** **[DER]**. The data determines exactly
the 8-dof homography of that plane and nothing more; this is why OpenCV's `calibrateCamera` can
initialize intrinsics "only … for planar calibration patterns" via homographies and requires "3D
calibration rigs … as long as initial cameraMatrix is provided" **[DOC]**
([calibrateCamera](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html)).

Could the single homography be lifted to (f, pose), Zhang-style? Each view of a plane gives 2
constraints on the intrinsics (Zhang, [MSR-TR-98-71](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr98-71.pdf)
/ TPAMI 2000) **[LIT]**, so one view with principal point assumed could in principle yield f —
"with a single view of a single plane, we might calibrate the aspect ratio and focal length,
provided the principal point is given" (Sturm & Maybank,
[CVPR 1999](http://robots.stanford.edu/cs223b04/JeanYvesCalib/papers/sturm99.pdf)) **[LIT]**. But
their singularity analysis closes the door for precisely this project's geometry: **"A general
observation is that a plane parallel to the image plane, allows to estimate the aspect ratio,
but no other parameters."** **[LIT]** An overhead camera aimed at a horizontal layout is the
fronto-parallel case; near it, the estimate exists formally and blows up in variance. Zhang's
degeneracy analysis says the same from the multi-view side: a second plane parallel to the first
adds no constraints **[LIT]**. *Self-calibrating f from the layout plane itself is not an option;
it fails by singularity exactly in the intended pose.*

**As conditioning.** With points at two heights the z-column becomes observable, but weakly: the
entire depth signal is the differential scale between planes, `z/(h−z)` ≈ 9% at (h = 1 m,
z = 85 mm). A full 11-dof DLT on points whose z-spread is 8.5% of the camera distance is
near-coplanar and correspondingly ill-conditioned (normalization à la Hartley & Zisserman,
*Multiple View Geometry* 2nd ed. §4.4, is necessary hygiene but does not create signal that isn't
there) **[LIT]** **[INF]**.

### Noise sensitivity, quantified on the structure that does work

The robust way to use a two-height point set is two per-plane scale fits — the current
estimator's own structure. The plane-scale ratio R = m(z)/m(0) = h/(h−z) determines
h = z·R/(R−1), with error amplification

```
Δh/h = ΔR · (h−z)²/(z·h)  ≈ 9.9 × ΔR     (h = 1 m, z = 85 mm)          [DER]
```

With ~1 px clicks, a pair's separation error is ~√2 px, so R measured from one pair per plane
with baseline b px carries ΔR ≈ 2/b:

* b = 500 mm ≈ 606 px @ DPT 20 ⇒ ΔR ≈ 0.33% ⇒ **Δh/h ≈ 3.2%** — usable;
* b = 100 mm ≈ 121 px ⇒ Δh/h ≈ 16% — noise-dominated. **[DER]**

Hand-typed world error (±1 mm on a 500 mm baseline = 0.2%; ±1 mm on the 85 mm height = 1.2% of
the correction, i.e. 0.1% of scale) sits below click noise at authoring-realistic baselines; the
`d_mm²` weighting in `fitScale` already favors the long baselines this depends on **[REPO]**
**[DER]**. The residual guards the typed values: a wrong mm entry surfaces in `getDPTResidual` at
the same 40× margin shown in §1.

---

## 3. What one authored scalar buys

### Camera height h: the closed-form fix

With h above layout zero known, the planar fit generalizes without changing shape: normalize each
equal-z pair's pixel separation by (h−z)/h and fit exactly as today, giving `m(0)` from *all*
pairs regardless of height, and

```
m(z) = m(0) · h/(h−z)          [DER]
```

predicts the scale at every height — cars at railhead, sensors on roadbed, scenery — from the
same two clicked points that suffice today. **Required extra points: zero.** The correction's own
sensitivity is second-order small:

```
residual scale error = (z/(h−z)) · (Δh/h)  ≈ 0.093 · Δh/h   at z = 85, h = 1 m          [DER]
```

so a tape measure good to ±20 mm (2%) leaves 0.19% at track height, versus 9.3% uncorrected —
**~50× reduction for one number a user can check by re-measuring**. Position (relief)
correction additionally needs the nadir pixel; under nadir view it is the principal point,
assumable as the image center at the cost of a small fixed offset, or recoverable via PnP if f is
ever known. **[DER]** **[INF]**

Because §2 showed h is derivable from pairs at two heights (~3% with 500 mm baselines), the
scalar is not required by identifiability — the constraint the ticket set ("admit a new authored
scalar only if points alone are unidentifiable or too noise-sensitive") is genuinely on the
boundary here: points alone identify the correction *iff* users author long-baseline pairs at two
distinct heights; the authored h asks for less work and is markedly more robust. Both routes leave v4 untouched except for the one optional scalar (or
nothing). **[INF]**

### Focal length f: weaker effect, weaker provenance

f alone fixes nothing (it cancels from every planar-fit error, §1). Its use is planar PnP: f plus
≥ 4 coplanar clicked points yields the full pose including h **[DOC]** (solvePnP, §2 table) — at
which point the h-correction above applies. But errors in f pass essentially proportionally into
the recovered h (the fronto-parallel observations pin f/h, so h ≈ f/m(0)) **[DER]**, and f's
provenance is the weak link:

* **Exif, stills only.** `FocalLength` (37386): "The actual focal length of the lens, in mm.
  Conversion is not made to the focal length of a 35 mm film camera." — millimetres, so pixels
  require `FocalPlaneXResolution` (41486): "Indicates the number of pixels in the image width (X)
  direction per FocalPlaneResolutionUnit on the camera focal plane." Alternatively
  `FocalLengthIn35mmFilm` (41989): "indicates the equivalent focal length assuming a 35mm film
  camera, in mm. A value of 0 means the focal length is unknown." — then f_px = f₃₅ · W_px/36.
  **All three tags are support-level O (optional) in the spec's tag tables**, and
  `DigitalZoomRatio` silently invalidates the conversion. **[DOC]**
  ([CIPA DC-X008-2019](https://www.cipa.jp/std/documents/e/DC-X008-Translation-2019-E.pdf))
* **The live path has nothing.** Frames from `getUserMedia` carry no Exif, and the
  [W3C MediaStream Image Capture spec](https://w3c.github.io/mediacapture-image/) exposes
  `zoom` (a ratio), `focusDistance`, exposure et al. — **no focal length in any unit** — and
  cautions implementors about Exif in `takePhoto()` output rather than guaranteeing it. Video
  mode also crops the sensor differently from stills, so a still's Exif f does not transfer to
  the stream that the live view classifies. **[DOC]**

**Verdict of the comparison:** h targets the dominant error term directly, costs zero points,
degrades gracefully with measurement error, and is available identically for archives and live
use. f is an indirect route to h with optional-tag provenance and no live-path source at all.
**[INF]**

---

## 4. Prior art on correction

**Where photogrammetry corrects: at product generation, before anyone measures.** The orthoimage
is the deliverable annotation and measurement happen on: "a computer-generated image of an aerial
photograph in which displacements (distortions) caused by terrain relief and camera tilts have
been removed", which "has a uniform scale, so it can be used as a base map" **[DOC]**
([USGS](https://www.usgs.gov/faqs/what-a-digital-orthophoto-quadrangle-doq-or-orthoimage)).
Aerial ML corpora inherit this: annotation is done on already-orthorectified products, so labels
and pixels share one geometry.

**The part that transfers as a warning, not a recipe:** a conventional ortho is rectified to a
terrain model, and objects *above* that surface remain displaced — buildings lean, worse toward
the frame edge; removing that requires a true orthophoto built on a surface model (DSM) of the
objects themselves (Schickler & Thorpe,
[ISPRS Arch. XXXII/4](https://www.isprs.org/proceedings/XXXII/part4/schickler58.pdf)) **[LIT]**.
Translated to this project: **warping frames to the z = 0 calibration plane straightens layout
zero and nothing else** — everything at track height keeps exactly the `ρ·z/(h−z)` relief
displacement of §1, and cars are the thing being detected. A homography warp cannot remove
parallax it has no height information about; the correction that reaches the cars is per-height,
which is a *coordinate* transform (scale by h/(h−z), shift radially) applied where geometry is
consumed, not a pixel warp of the corpus. **[DER]** **[INF]**

**What warping does to a training corpus.** Mechanically, one perspective warp is one resampling
pass — the same cost class as the DPT-normalization resample already decided (#130), and inside
the family detectors already train under: Ultralytics ships a `perspective` augmentation
hyperparameter (range 0.0–0.001, default 0), with the documented guidance that a consistent
deployed viewpoint lets you "likely skip geometric transformations" **[DOC]**
([Ultralytics augmentation guide](https://docs.ultralytics.com/guides/yolo-data-augmentation/)).
The corpus risks are not the pixels but the bookkeeping: a warped corpus bakes per-layout warp
parameters into images irreversibly, splits the world into warped and unwarped provenance, and
moves labels into a frame no authoring surface displays. This repo's own precedent already
resolves where geometry lives: normalization happens between a frame arriving and `occupancy()`
being called, v4 gains no field, and the editor and live view keep drawing in full-frame image
pixels (#130) **[REPO]**. Capture-time correction — mount higher, longer lens, nadir — is the one
stage that removes error instead of modeling it (§1's h-table). **[INF]**

---

## What this means for the decision (#135)

Facts on the table, no decision taken:

* **The error is real, quantified, and one-dimensional.** Everything the planar fit gets wrong is
  the single ratio `z/(h−z)`: ~9% scale at track height for a 1 m camera, shrinking inversely
  with mount height. It lands today in DPT and everything DPT feeds (car-width px, drift
  tolerance, the #130 resample factor); the much larger relief-displacement numbers stay latent
  until something maps px↔mm positions.
* **Points-only is identifiable, on conditions.** The correction is recoverable from the existing
  format iff calibration pairs exist at two heights with long baselines (≥ ~500 mm ⇒ h to ~3%);
  all-one-height sets are structurally blind to it, and no single-view self-calibration can
  rescue them (fronto-parallel singularity). Full DLT/PnP camera models buy position correction
  nothing currently consumes, at the price of near-coplanar conditioning and degeneracy
  management.
* **The cheapest admissible scalar is camera height, not focal length.** One tape-measured h
  gives a closed-form per-height scale correction with zero new points and ~50× error reduction;
  f is optional-tag Exif on stills, absent on the live path, and only reaches h through PnP
  anyway.
* **Guardrails largely exist.** `getDPTResidual` already exposes mixed-height calibration sets at
  ~40× the click floor; a warning threshold can be stated as `Δz/(h−Δz)` against an assumed
  minimum h, in the same warn-don't-block family as `MIN_DPT`.
* **If correction is ever applied, precedent and prior art agree on where:** in coordinates,
  between capture and consumption — not by warping the corpus, which cannot fix track-height
  objects from a z = 0 plane and would bake irreversible geometry into shared pixels.
