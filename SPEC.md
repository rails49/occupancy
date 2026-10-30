# Model Railroad Track Occupancy Detection with Cameras

This file holds the requirements. Terms are defined in [`GLOSSARY.md`](GLOSSARY.md) and decisions are recorded in [`docs/adr/`](docs/adr/) ([ADR 0001](docs/adr/0001-glossary-and-adrs-alongside-the-spec.md)). The detector's own requirements are in rails49/detector's [`SPEC.md`](https://github.com/rails49/detector/blob/main/SPEC.md) ([ADR 0019](docs/adr/0019-detection-and-training-move-to-rails49-detector.md)). It describes the target. Parts of it are not built yet, and each such part says so.

## Goals

* Detect the presence of trains at specific locations in a layout (block detection).
* Detect the location, length and orientation of all trains in a layout (track occupancy detection).

## Assumption

Humans can control model railroad trains, and prototype trains, using mostly visual information. AI should be able to do the same.

## Classifier

Three ways to establish occupancy were considered:

1. Image change. Successive images differ as trains move. It needs no training and little compute. The [EX-SensorCAM](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensorcam/) project uses an ESP32 and an inexpensive camera for this. Rejected for occupancy; see below.
2. CNN. A ResNet or MobileNet that judges whether a train is present at one point. Block detection only.
3. Object detector. A detector such as YOLO that finds the location and orientation of every car on the layout.

The live path loads option 3 only ([ADR 0004](docs/adr/0004-one-model-in-the-live-path.md)). Option 2 is kept retrainable and nothing loads it. The detector is evaluated offline in the UI's archive diagnostics view ([#87](https://github.com/rails49/occupancy/issues/87)), not by running both models live. The detector itself is specified in rails49/detector's [SPEC § The detector is YOLO26n-OBB](https://github.com/rails49/detector/blob/main/SPEC.md#the-detector-is-yolo26n-obb).

### Image change is not a candidate for occupancy

Change detection does not decide occupancy ([ADR 0016](docs/adr/0016-image-change-does-not-decide-occupancy.md)). The analysis, including the re-implementation of EX-SensorCAM's metric against `lighting.r49`, is in [`docs/research/image-change-detection.md`](docs/research/image-change-detection.md).

It is cheap, needs no labels, and works below the minimum DPT. It is used for jobs where an error costs a warning rather than a collision; see [Secondary uses of change detection](#secondary-uses-of-change-detection).

## Occupancy Output

Occupancy is reported as L0 and L1 ([glossary](GLOSSARY.md#occupancy)) and nothing more. L1 is computed from L0 by geometry and calls no second model ([ADR 0005](docs/adr/0005-l1-is-geometry-over-l0-biased-toward-occupied.md), [issue #7](https://github.com/rails49/occupancy/issues/7)). The detector runs once per frame however many sensors a layout has.

Everything above L1 is unspecified: event and transition semantics (Rocrail's enter and in sensors fire on transitions, not on per-frame state) and block-span occupancy. L0 carries full car pose, so both can be computed later from archives recorded today.

### The occupancy test

A sensor is occupied when the box tested strictly contains its point. That box is the detection's oriented one, lengthened by the [margin](GLOSSARY.md#occupancy) at each end along its long axis: 2 G, because a miss costs a collision, and because one definition of how close counts lets the detector and the classifier be combined and scored against the same ground truth ([ADR 0023](docs/adr/0023-occupied-has-a-two-gauge-margin.md)). The margin is a distance on the layout rather than a pixel count — 1 G is `dpt` pixels, so the box tested is `length + 4·dpt` long — and it runs along the track only, leaving the half-width across the axis alone so that it never reaches a sensor on the next track.

Beyond the margin there is no tolerance. The lateral direction already has about 1.4 m prototype of slack from the car width. At a coupling the two boxes share an endpoint, so a point between coupled cars is inside one of them, and with the margin it is inside both. A gap between uncoupled cars wider than two margins — over 4 G — reads clear, and a tolerance epsilon on top of the margin would put a phantom just past that. The margin is a stated distance with a reason behind it; an epsilon would be an unvalidatable fudge at whatever boundary it was added to.

The box tested keeps the detector's centre and orientation and takes the car width in place of the predicted width ([ADR 0005](docs/adr/0005-l1-is-geometry-over-l0-biased-toward-occupied.md)). Every training label has the same width, so the model's width output only fits a constant. L0 still reports the raw predicted box, at its raw length, and that raw detection is the one an occupied state carries.

> ⚠️ Known limitation: long cars on tight curves. The box's long axis is the chord between the car's ends, but the track bows off that chord by the sagitta `L²/8R`. Once that exceeds the half-width (17.2 mm in HO), a sensor near the car's midpoint falls outside the box. The ends still register, so a long car crossing a sensor reads occupied → clear → occupied.
>
> | Car length (prototype) | Fails below radius |
> | :--- | :--- |
> | 40–50 ft freight | ~8.8" (never in practice) |
> | 69 ft | ~16.7" |
> | 80 ft | ~22.4" |
> | 85 ft passenger / autorack | ~25.3" |
>
> Accepted, because first tests are short cars on straight track. The mitigation is a constant: raise `layout.standard_width` in rails49/detector's [`config.yaml`](https://github.com/rails49/detector/blob/main/config.yaml). Covering an 85 ft car on an 18" radius needs a half-width of at least 24.3 mm, a model width of ~48.5 mm against 34.5 mm: `standard_width` from 3000 to ~4220 mm, a factor of 1.41.
>
> All figures above assume `standard_width = 3000`.
>
> Projecting detections onto a track spline and testing overlap along it was rejected. Nearest-spline association is ambiguous where layouts are densest (parallel sidings ~60 px apart at DPT 20, turnouts, yard ladders), and a wrong association reports the wrong track occupied at a rate nothing bounds. Storing [centerlines](#track-centerlines-are-stored) ([ADR 0021](docs/adr/0021-track-centerlines-are-stored.md)) makes it buildable and does not revive it: [ADR 0023](docs/adr/0023-occupied-has-a-two-gauge-margin.md) leaves a detection unmatched to any centerline for exactly the ambiguity above. The classifier's training labels do match cars to centerlines, because those come from hand-made spans a person can check.

> ⚠️ Known limitation: a sensor on track the camera cannot see, such as inside a tunnel, reads clear whatever is there. Sensors go on visible track. Making such a sensor unknown would need a per-sensor field, which is a format change. It is not planned.

### The vocabulary

L1 states are occupied, clear and unknown, as [`GLOSSARY.md`](GLOSSARY.md#occupancy) defines them. A detection above the confidence threshold counts when it covers the sensor, including a low-confidence one. Errors lean toward occupied, and a persistent phantom can deadlock a controller's schedule; both are accepted in [ADR 0005](docs/adr/0005-l1-is-geometry-over-l0-biased-toward-occupied.md). Camera drift as a reason for unknown comes from [issue #12](https://github.com/rails49/occupancy/issues/12).

The bias reduces the consequence of the worse error. It does not make this a safety interlock.

### Confidence

Every L0 detection carries its confidence. An occupied L1 state carries the confidence of the covering detection, the maximum where several overlap.

Clear carries no confidence: the field is absent, not `0.0` and not `1.0`. Nothing scored a clear. A phantom arrives with a confidence a consumer can threshold; a miss arrives as a clear with nothing behind it, and an absent field keeps that visible.

There is a single threshold, `@rails49/detector`'s `CONFIDENCE_THRESHOLD` ([rails49/detector SPEC § Parameters](https://github.com/rails49/detector/blob/main/SPEC.md#parameters-live-in-configyaml)).

* Thresholding is part of decoding. The `end2end` export emits 300 slots every frame, mostly padding, so there is no L0 without a threshold.
* It has a floor above zero. At zero, 300 phantom boxes cover the frame and every sensor reads occupied. The value must sit low but above the padding noise, and only recall measured on a held-out split can set it. No such split exists yet (see [rails49/detector SPEC § Accuracy](https://github.com/rails49/detector/blob/main/SPEC.md#accuracy)), so the current value is a placeholder.

The bias toward occupied lives in L1. L0 stays raw, so a consumer that wants a stricter reading can re-threshold the same frame.

> ⚠️ A total miss stays invisible. No single-model scheme makes it detectable. Two thresholds do not. Neither does a track class: a missed car on confidently detected track is a confident false clear, and the two failures are correlated. Only an independent second observer would close this: a CNN verifier over the same points, or [change detection](#secondary-uses-of-change-detection). Neither is specified, and neither is worth building before the detector has held-out numbers.

### Output encoding

L0 detections are reported in `camera.resolution` pixel coordinates. Their fields are `@rails49/detector`'s: see rails49/detector's [SPEC § The runtime reports detections in the caller's frame](https://github.com/rails49/detector/blob/main/SPEC.md#the-runtime-reports-detections-in-the-callers-frame).

That frame is the only stable one. The model's input size changes on re-export. The video's natural size varies per device. Normalized 0…1 coordinates lose the link to DPT. Sensors, labels and calibration are already authored in `camera.resolution`, so the point-in-box test needs no conversion, the SVG viewBox maps 1:1 onto it, and any length converts to millimetres with one DPT multiply. No millimetre field is stored.

Off-track detections pass through unchanged. A box far from any track contains no sensor and cannot change L1. Filtering would need the spline association rejected above, would make L0 not raw, and would hide real information: a box around a car in the scenery may be a false positive, a derailment, a hand over the layout, or a car on unlabeled track. Confidence is the filter for junk.

Consumers key sensors on `id`. `name` is optional passthrough, absent when unset and never generated. Names are free text and not unique, and a controller mapping keyed on one breaks when someone renames it. A generated "Sensor 3" cannot be told apart from a name a person chose. The UI shows the `id` when there is no name. Uniqueness is not enforced.

Couplings are not reported. They can be derived from L0 as two box endpoints that coincide.

## Features

The UI creates, displays and edits `.r49` files through `@rails49/r49`. The sections below are its requirements.

The detector runs entirely in the browser via ONNX Runtime; the application is fully client-side with no backend.

### Images

An archive holds a list of images of the layout taken with an overhead camera. The UI adds and removes images. While nothing in the archive is positioned in pixels (no image, calibration point or sensor), adding an image sets `camera.resolution` to its size ([#254](https://github.com/rails49/occupancy/issues/254)).

**Images are stored landscape, with no orientation applied, and a portrait image is refused** ([#255](https://github.com/rails49/occupancy/issues/255)). A browser applies a JPEG's EXIF orientation tag when it decodes; the readers that train and export the detector hand back the stored array and ignore it, so a tagged photograph would be labeled in one frame and detected in another. On every image add — the file picker and Capture from Camera both — the UI sets the tag to 1 in the stored bytes, rewriting that value alone and re-encoding nothing. It then refuses an image whose stored array is portrait, recording nothing and naming the file: a camera-native photograph is landscape whichever way the phone was held, so a portrait array is software having rotated the pixels, and rotating them back in the browser would re-encode the photograph.

**An added image is the size `camera.resolution` declares** ([#260](https://github.com/rails49/occupancy/issues/260)). Once anything in the archive is positioned in those pixels, the UI refuses an added image whose stored array differs in width or in height, recording nothing and naming the file and both sizes; while nothing is positioned the image sets the resolution, as above. The detector's export normalizes every label against `camera.resolution` and sizes its tiles from it, so an image of another size carries labels read in a frame that is not the one they were authored in — and the editor draws an image of the same shape at another pixel count scaled to fit, so nothing on screen would say so. Undo and redo restore bytes the archive already accepted and are not checked. An archive that already holds an image of another size opens as before and keeps its frame-mismatch warning.

**One pick adds several images, under the names they came with** ([#262](https://github.com/rails49/occupancy/issues/262)). The file picker takes any number of JPEG or PNG files and adds them in filename order, as one undo entry: a camera names its files in the order it took them, so filename order is capture order, and a user who picks a session's worth of photographs and then thinks better of it presses undo once. Each image is stored under its own filename — the corpus is indexed by those names outside this program, as `dataset/holdout.json` in rails49/detector is — and a name the archive already holds, or an earlier image of the same pick took, falls back to a generated one that keeps the extension ([#256](https://github.com/rails49/occupancy/issues/256)), because storing it twice would leave one photograph carrying the other's labels. The two rules above are applied per file: what they refuse is left out, the rest of the pick is added, and one notice names everything refused. In an archive where nothing is positioned, the first file of the pick sets `camera.resolution` and the rest are held to it.

### Calibration

#### Establishes the relation (scale) to the prototype

Supports the common scales (HO, N, Z, and so on).

#### Establishes the relation between image pixels and physical dimensions

The relation between image and layout is expressed as [DPT](GLOSSARY.md#calibration), so the detector sees cars at one size.

Example. Two points in an N-scale layout are 1000 pixels apart in the image and 250 mm apart on the layout: 4 pixels per millimetre. Track gauge in N is `STANDARD_GAUGE/160 = 1435/160 ≈ 9 mm` (`STANDARD_GAUGE` is defined in the `.r49` library). DPT is 4 × 9 = 36.

The editor warns below `@rails49/detector`'s `MIN_DPT` and never blocks. The value and the reason for it are in rails49/detector's [SPEC § Minimum DPT](https://github.com/rails49/detector/blob/main/SPEC.md#minimum-dpt).

The [fixtures](GLOSSARY.md#layout-and-archive) sit at DPT 18–19. They exercise every code path in the editor, but they are not training data. Training will use new, higher-DPT images. Do not tune model accuracy against the fixtures or treat their numbers as predictive.

Layouts are not planar and cameras are not at infinity, so scale varies with height. Camera height corrects it ([ADR 0015](docs/adr/0015-camera-height-corrects-scale.md)); see [Camera height](#camera-height-is-what-corrects-the-third-dimension). The derivations are in [`docs/research/camera-calibration.md`](docs/research/camera-calibration.md). Barrel distortion and camera tilt are ignored. Tilt adds to the height error rather than replacing it.

#### Reference points

Calibration is a list of [reference points](GLOSSARY.md#calibration):

```jsonc
calibration: {
  points: [
    { px: { x, y }, world: { x, y, z } },   // px = image pixels, world = mm
    ...
  ]
}
```

`world` is relative to an origin shared by every point in the layout. The orientation of that frame is arbitrary. A point carries no `id` and no `name`, because nothing refers to an individual point.

DPT is one least-squares scale. Each pair is normalized to layout zero by the camera height:

```
s   = Σ(d_px' · d_mm) / Σ(d_mm²)    over all pairs, where d_px' = d_px · (h − z)/h
DPT = s · gauge_mm(scale) · h/(h − z_ref)
```

`h` is the camera height above layout zero and `z_ref` the reference height. A pair enters the fit only when its two points share a `z`. With `h`, that `z` may be any height below the camera. Without `h`, it must equal `z_ref`, and points at other heights are stored but unused. When no usable pair exists, DPT is `null`: uncalibrated.

The `d_mm²` weighting favours long baselines. Click error is a fixed number of pixels, so short baselines are noisier.

The minimum calibration is two points at different positions, which is what resolves DPT. Car width is derived from DPT, so an uncalibrated archive cannot draw a label. The editor opens in calibration mode with the labeling tools disabled and the reason stated.

Points are placed with their own tool, distinct from the sensor tool and drawn differently: click a pixel, then enter the x, y and z coordinate in millimetres. A point draws as a crosshair labeled with its world coordinate. With more than two points the editor shows the fit [residual](GLOSSARY.md#calibration), so a mistyped coordinate shows instead of being absorbed into the scale.

#### Camera height is what corrects the third dimension

Decided in [ADR 0015](docs/adr/0015-camera-height-corrects-scale.md) ([issues #135](https://github.com/rails49/occupancy/issues/135), [#136](https://github.com/rails49/occupancy/issues/136), [#139](https://github.com/rails49/occupancy/issues/139)). Built in [#143](https://github.com/rails49/occupancy/pull/143) and [#144](https://github.com/rails49/occupancy/pull/144): the two fields, the fit above, the required-metadata dialog and the height check. Not built: `dptAtHeight(z)`, the DPT bar's height states, the capture advisory and the suggested height, all below.

Two optional fields:

* `camera_height_mm`, the [camera height](GLOSSARY.md#calibration) `h`.
* `reference_height_mm`, the [reference height](GLOSSARY.md#calibration) `z_ref`, defaulting to 0. DPT is reported there. `dptAtHeight(z)` serves any other height. The editor does not edit it yet.

The editor keeps one declared list of required layout metadata: layout `name` and `camera_height_mm` (`ui/src/requiredMetadata.ts`). `scale` is required by the schema, so it is never missing. The settings dialog stays open until every item is supplied, on New and on any Open that lacks one. An archive that carries them all opens straight through.

A camera height must exceed the largest authored `z`. The fit residual cannot catch a unit slip when every point sits on one plane, and this check does. The six fixtures' height was first recorded as 115 mm; covering the 1660–1763 mm each image spans would then need a 166° diagonal field of view. The measured value is 1150 mm, needing 79–83°.

The correction's own error is small. The remaining scale error is `(z/(h−z))·(Δh/h)`, so a tape measure good to ±20 mm leaves 0.19% at track height under a 1 m camera, against 9.3% uncorrected.

The fit residual cross-checks `h`. A wrong `h` normalizes pairs at different heights inconsistently, and the residual measures that. It refits rather than scoring against a held scale, so it reports about half the raw disagreement between planes. Against a ~1.4 px click floor at DPT 20 with 500 mm baselines, a 50% error in `h` shows 8.1 px, 20% shows 4.0 px, 10% shows 2.2 px, and 5% is lost in the floor. When every point sits at one height the check sees nothing, so it is a cross-check and never a gate. Where long pairs at two heights exist, `h` can be derived (`h = z·R/(R−1)`, ~3% at 500 mm baselines). The editor may offer that as a suggested value. The fit never derives it on its own.

Remaining perspective error gets a warning in the editor and nothing else:

* The editor's DPT bar reports three states: no `h` (scale on the reference plane only; enter the height to correct it), `h` present (naming the height it corrected with), and `h` present with poor geometry. The middle state is required because entering `h` moves every DPT number by up to 9%, and the bar must say why. Not built.
* Without `h`, no magnitude is quoted. A number computed under an assumed height would sit beside measured ones with nothing to tell them apart.
* The live view says nothing and never refuses on it. A camera remounted at a height other than the authored `h` is a change of pose, and that is [drift](#image-alignment).
* The capture advisory reports obliquity and how to reduce it, with no threshold. From `h` and the calibration points' world extent, worst-case obliquity is `atan(ρ_max/h)` and the worst-case apparent-width inflation is `1 + (c/w)·tan θ`, where `c/w ≈ 1.43` is a prototype car's height over its width. The ratio does not depend on scale. An HO car at the corner of a 2×1 m layout appears 2.6× its overhead width under a 1 m camera, 1.8× at 2 m and 1.5× at 3 m. Raising the camera is the only control, and it also allows a less extreme wide-angle lens (~19 mm equivalent at 1 m, ~39 mm at 2 m). No `max_obliquity` constant is set: nothing has measured what obliquity costs accuracy. The corpus validator in `rails49/r49` reports the obliquity; the editor does not yet.

#### Image Alignment

Camera [drift](GLOSSARY.md#drift) is detected, and classification is refused past the [drift tolerance](GLOSSARY.md#drift) ([ADR 0020](docs/adr/0020-only-the-live-view-measures-drift.md); built under [map #89](https://github.com/rails49/occupancy/issues/89)).

* Nothing records the camera pose. The archive's images are the pose record, and the reference is derived from them at load time.
* `@occupancy/drift` compares the structure of a frame against the [reference image](GLOSSARY.md#drift) by block-wise phase correlation, which ignores illumination, and reports a displacement in `camera.resolution` pixels.
* The tolerance is `MAX_DRIFT_TRACK_FRACTION` in `ui/src/driftSession.ts`, a fraction of a track width. It is a tolerance, not a detection floor: the check resolves much smaller displacements.
* Past the tolerance the live view reports every sensor as unknown with reason `drift`, with a visible override.
* The editor does not measure drift ([ADR 0020](docs/adr/0020-only-the-live-view-measures-drift.md)). Moving a thumbnail to the front changes the reference image the live view measures against.
* Correction is out of scope.

Validation is synthetic: the fixtures were shot on a tripod, so `tools/drift-bench` warps them. That is why the override exists.

> Measured: within an archive the camera is static. `lighting.r49` has a track marker at (202, 591) in image-0 and (202, 592) in image-1. The three `cars *` archives carry byte-identical calibration, which may be a data-entry error. [Issue #6](https://github.com/rails49/occupancy/issues/6) closed this as not worth provisioning against, so v4 records no calibration provenance. A stale calibration failing silently is camera drift, [issue #12](https://github.com/rails49/occupancy/issues/12).

### Location Data: Cars, Sensors and Centerlines

The format and the editor store three kinds of geometry, in pixel coordinates:

| | Geometry | Scope | Trained on? | Provenance? |
|---|---|---|---|---|
| Cars | A [span](GLOSSARY.md#cars-and-labels): two points along the car's centerline | Per image | Yes, the detector's only class | Yes |
| Sensors | A single point | Per layout | No, an output specification | No |
| [Centerlines](GLOSSARY.md#cars-and-labels) | A polyline along the middle of one run of track | Per archive | No, the classifier's input geometry | No |

1. Cars. Width is not stored; every car is drawn at the [car width](GLOSSARY.md#cars-and-labels) (rails49/detector's [SPEC § Car width](https://github.com/rails49/detector/blob/main/SPEC.md#car-width-is-derived-from-dpt-never-stored)). [Trains and couplings](GLOSSARY.md#cars-and-labels) are derived from coincident ends and never labeled. Each car carries [provenance](#provenance-is-required-not-optional).

2. [Sensors](GLOSSARY.md#occupancy) are where the deployed system must answer, and they never enter a loss. What they answer with is [Occupancy Output](#occupancy-output). They stay points, not spans: L0 carries full car pose, so block semantics can be derived later, and authoring intervals is UI for a consumer that does not exist yet. Sensors carry no provenance, since no model proposes where a person wants an answer.

#### Track centerlines are stored

Each archive stores its track [centerlines](GLOSSARY.md#cars-and-labels): polylines along the middle of each run of track, in the same image pixels every other coordinate uses ([ADR 0021](docs/adr/0021-track-centerlines-are-stored.md), superseding [ADR 0010](docs/adr/0010-track-is-not-stored.md); decided in [#272](https://github.com/rails49/occupancy/issues/272), built under [#275](https://github.com/rails49/occupancy/issues/275)).

They are the [classifier](GLOSSARY.md#occupancy)'s input geometry and nothing else's. A [patch](GLOSSARY.md#occupancy) is centred on a sensor and turned to the direction of the centerline under it, and the classifier's training labels come from where cars stand along that centerline — a car belongs to the one nearest its span midpoint, which keeps a car on the next track from reading as occupied. The **detector**'s output is not matched to a centerline; see [The occupancy test](#the-occupancy-test).

* **Per archive, not per image.** An archive's images share one pose, the same assumption [Image Alignment](#image-alignment) rests on, so one tracing serves all of them. Each stretch is traced on whichever image has that track free, and the person may switch images part-way through a run. Between them, an archive's images must show every piece of track with no car on it.
* **Polylines only.** No splines and no branching: every outside reader of the format would have to implement the curve, and snapping to the rails takes away the tedium splines were for. Points sit one gauge apart and are not thinned — they are the measurement, and a thinning rule would be a second opinion about where the track is.
* **Traced by snapping, not by drawing.** Rough clicks along a visible run; the editor moves each click to the middle of the track and fills the stretch between two clicks a gauge at a time. The snap is **mirror symmetry**: the middle of the track is the offset, within three quarters of a gauge of the click, whose cross-section about three gauges wide most nearly equals its own reflection. Rails, ties and roadbed are all symmetric about the centerline, so no rail detector is involved. The first click has no direction and stays unsnapped until the second gives it one.
* **The snap refuses rather than guesses**, and what it refuses is marked on the photograph for the rest of the edit session, not stored. It refuses at a turnout, a crossing, clutter, an occluded rail and the frame edge. A click there is kept unsnapped, so the person can carry on past it.
* **Turnouts and crossings are not traced.** Their rails confuse the snap, and a sensor with no centerline under it reads [unknown](GLOSSARY.md#occupancy). That is an accepted limitation, not a deferral.
* **Track under a car is not traced.** A car's area is its label's span, one car width across and half a gauge longer at each end. A click there is refused and stepping stops before it: the rails under a car are not visible, so the snap would read the car's own symmetry. The person traces that stretch on another image.
* **A run of fewer than two points is not stored.** One point is not a run and carries no direction, so no patch can be turned to it.
* **Each sensor carries two marks against the centerlines**, drawn in the editor and never as toasts: *no track* when it is more than half a gauge from every centerline, and a *warning* when a second centerline comes within half the patch width plus half a car width — a car on that track could reach into the patch, so the classifier would be judging two tracks at once. Neither mark moves the sensor and neither moves its patch onto the line.

The patch size is a placeholder, 3 gauges across by 5 along, in one named place until [rails49/classifier#4](https://github.com/rails49/classifier/issues/4) picks it from what the model needs.

> The gap today is the **field**, and only the field. The tool, the snap, the tracing, the editing, the undo entries and everything drawn above are built ([#275](https://github.com/rails49/occupancy/issues/275)); centerlines are an additive `.r49` field and so arrive with a release of `@rails49/r49` ([rails49/r49#52](https://github.com/rails49/r49/issues/52)) and a bump here — the pinned version refuses `layout.centerlines` as `manifest/unknown-key`, so an archive saved with one would not reopen. Until the bump a tracing lives for the edit session: it undoes and redoes as described, and it is not saved. The mirror-symmetry threshold also waits on a person trying it against the layout's own photographs.

> The empty-track training crops described in [issue #4](https://github.com/rails49/occupancy/issues/4) become derivable again with centerlines stored, which is most of why [ADR 0021](docs/adr/0021-track-centerlines-are-stored.md) reversed [ADR 0010](docs/adr/0010-track-is-not-stored.md). The spline questions recorded on the closed [issue #14](https://github.com/rails49/occupancy/issues/14) — Catmull-Rom against Bezier, control-point editing, whether track carries topology — are answered by not having splines.

#### Labeling completeness

Every image used for detector training must have all its cars labeled. An unlabeled car is treated as background by the loss, which is shared across the whole image, so this cannot be scoped per class.

Each image carries `labeled_complete` ([labeled complete](GLOSSARY.md#cars-and-labels)). Only complete images are exported for training. Incomplete images stay useful for authoring and review. Per-image labeling does get skipped: `cars 0-10.r49` had 32 track markers on image-0 and none on its other ten images.

* Only a person sets it. Accepting proposals never sets it, however many are accepted ([ADR 0011](docs/adr/0011-deleting-a-car-clears-labeled-complete.md)).
* An image marked complete with zero cars is valid. It is an all-background sample.
* Deleting a car clears it, in the same history entry ([ADR 0011](docs/adr/0011-deleting-a-car-clears-labeled-complete.md), [issue #36](https://github.com/rails49/occupancy/issues/36)). Only deletion clears it. Adding a car, dragging an end and reclassifying do not.
* The editor has one control for the image on screen. The thumbnail bar marks every image that carries the flag, so the remaining work can be scanned without selecting each image. Toggling is one history entry on that image.

### Labeling Workflow

The editor guides an order:

1. Calibrate: two points minimum.
2. Label all cars, per image.
3. Trace the [centerlines](#track-centerlines-are-stored), on images already labeled complete.

Sensors can be placed at any time.

> The workflow had three stages until [issue #13](https://github.com/rails49/occupancy/issues/13) removed track from v4, and has three again now that [ADR 0021](docs/adr/0021-track-centerlines-are-stored.md) stores centerlines — but the returning stage is the last rather than the first, and it is tracing rather than labeling.

Tracing comes after labeling rather than before it, which is the one place the order is a gate on *completion* rather than on existence: the trace needs every car on the image it is tracing to be labeled, since a car's labeled span is how it knows which track it may not read. So the centerline tool is offered only on an image marked `labeled_complete`, and only once DPT resolves, since the snap is measured in gauges.

Stages are gated on existence, never on completion. Calibration gates car labeling, because car width is derived from DPT and the width rectangle is the only feedback that a label covers its car. Every stage can be re-entered. Nothing can verify that all cars are labeled, so the only claim of completeness is the person's, recorded as `labeled_complete`.

A car-free image is no longer required. It is a useful all-background sample and nothing more.

#### Authoring cars, and the trains they form

A car is two clicks on the visible car ends, with no snapping.

A span covers the part of a car the camera sees, whatever hides the rest. A car half inside a tunnel is labeled from its visible end to the portal. A car with something across its middle, such as a road bridge, gets one span per visible piece. A car fully hidden is not labeled. There is no minimum length: every piece the person can identify as a car gets a span, and a piece left unlabeled on a `labeled_complete` image is taught as background. [rails49/r49 FORMAT § Car label](https://github.com/rails49/r49/blob/main/FORMAT.md#car-label) owns the definition.

A train is authored as a chain of clicks. The first click starts a car, and every click after it ends the current car and starts the next. Right-click ends the chain, and the next click starts a new train. Nothing about the train is stored; chaining makes the coincidence of ends exact.

A coupling draws as one shared handle. Dragging it moves both cars' ends together, so a train survives editing. A single car can still be deleted: deleting the middle car of three leaves two trains.

Dragging edits everything: car ends, couplings, calibration points and sensors.

#### Right-click is state-dependent

| State | Right-click |
| :-- | :-- |
| Chaining a train | Ends the chain |
| Idle | Context menu on the object under the cursor |

The context menu carries delete and reclassify, so the editor needs no delete mode. A dotted class nests there as a submenu (`stock › loco › steam`). A new car is `stock`; refinement goes through the menu.

One gesture meaning two things is a cost. It is accepted because a chain in progress shows as a rubber band.

#### No copy-forward

Labels are not carried between images. Hand-labeling every image keeps provenance and the completeness flag unambiguous.

#### Undo and redo

The editor has undo and redo ([ADR 0012](docs/adr/0012-undo-is-scoped-snapshots.md), [issue #25](https://github.com/rails49/occupancy/issues/25)).

* The history holds every change to the manifest and nothing else: car edits, sensors, calibration, `labeled_complete`, layout metadata, `layout.scale`, and adding, removing and reordering images. View state is not in it: selection, zoom, view mode, an uncommitted chain. Deleting an image keeps its bytes, so the deletion can be undone.
* One entry is one gesture. A drag is captured at pointer-down and committed at pointer-up; a coupling drag is one entry covering both cars; a drag returned to its origin records nothing. Text fields commit on blur. Edits that change nothing are not recorded. A chained train records one entry per car.
* An undo or redo on another image selects that image first, then applies, then highlights what changed.
* While a chain is live, undo removes the chain's last car and moves the anchor back. At the chain's start it clears the anchor. It cannot reach past the chain's start.
* Code finds labels by `id`, never by object identity.
* The stack is bounded by bytes. Eviction removes the oldest entries only. Redo is linear: a new edit discards what was undone.
* The history is never persisted or written into the `.r49`. New and Open replace it. Save records a marker, which gives a dirty flag. A dirty archive asks before New and Open, and a `beforeunload` guard asks before closing or reloading the tab ([issue #49](https://github.com/rails49/occupancy/issues/49)).

Open: whether an accept-all of proposals is one entry or many, which waits on [the proposal interaction](#in-scope-still-unresolved).

### Assisted Labeling

Hand-labeling every car in every image is the main cost of building a training set. The UI should propose car labels, from the production detector, which the user accepts, corrects or rejects. The person remains the author.

The rules below keep proposals from degrading the corpus, whichever model proposes.

#### Provenance is required, not optional

Accepted proposals that become training data form a loop: the model trains on its own output and amplifies its errors, including ones a user is unlikely to catch.

Each car label therefore records its [provenance](GLOSSARY.md#cars-and-labels), and `proposed_by`, the proposing model's version string, which is absent when provenance is `human`. Unedited proposals can then be excluded or down-weighted, and acceptance rate becomes a quality signal. Provenance cannot be added to a corpus after it is labeled, which is why it exists before the feature that needs it.

Three details decided against:

* `corrected` records no magnitude, and the original proposal is not kept. Correction data would be censored: residuals exist only where the user chose to edit, and unnoticed errors leave none. Model error belongs to a held-out evaluation; see [rails49/detector SPEC § Accuracy](https://github.com/rails49/detector/blob/main/SPEC.md#accuracy).
* `proposed_by` is per label, not per image. Re-proposing an image with a newer model leaves the earlier `corrected` labels in place.
* `corrected` stays distinct from `human`. A corrected label was anchored by a proposal.

#### Provenance cannot cover the error that matters most

Provenance is per label, so it cannot express a car that was never labeled. A proposal model that misses a car yields an image where every label is correct and a car is taught as background. That risk is covered only by `labeled_complete`. An image whose labels are all `proposed` is identical whether the user checked each one or accepted all blind, which is why accepting proposals never sets the flag.

### Testing and Demo

The UI also runs the detector:

1. On a live camera stream: the live view draws L0 boxes and reports L1 per sensor ([#85](https://github.com/rails49/occupancy/issues/85)). Testing and demo only; throughput is not critical. Built.
2. Highlight detection errors and high-loss samples (training or test set) for diagnosis. Partly built: archive diagnostics ([#87](https://github.com/rails49/occupancy/issues/87)) scores the detector against one archive's labels. Nothing yet reviews the training and test splits.
3. Real-time occupancy, for example on a phone, sent over MQTT to a controller such as [Rocrail](https://www.rocrail.online/). Measured and viable; see rails49/detector's [SPEC § Inference cost](https://github.com/rails49/detector/blob/main/SPEC.md#inference-cost) and the runtime contract below. Not built.

#### Live-view runtime contract

The detector's measured cost is in rails49/detector's [SPEC § Inference cost](https://github.com/rails49/detector/blob/main/SPEC.md#inference-cost). What the live view takes from it:

* Plan the frame loop against the slowest device measured, not the phone.
* Create the ORT session once at view mount, never per frame. The loading state must last several seconds.
* Threading needs cross-origin isolation, so everything the app fetches comes from origin ([ADR 0006](docs/adr/0006-the-onnx-runtime-ships-from-origin.md)).

The remaining speed-up is [change-detection frame gating](#secondary-uses-of-change-detection).

### Secondary uses of change detection

Change detection is used where a wrong answer costs a warning or a wasted frame:

1. Camera-drift detection. Built ([map #89](https://github.com/rails49/occupancy/issues/89)); see [Image Alignment](#image-alignment). It uses block-wise phase correlation rather than frame differencing. On `tools/drift-bench` two pixel-differencing baselines reach AUC 0.915, and the structural check reaches 1.000 with every legitimate case scoring zero.
2. Re-classification gating. In the live view, skip inference on frames where nothing changed. A false negative costs a stale frame, never a wrong occupancy report. Relevant to [Testing and Demo](#testing-and-demo) item 3. Not scheduled; raise it as its own request. "Has the frame changed" and "has the camera moved" are different questions, so item 1 does not answer it.
3. Change proposes, a model decides. Change detection nominates regions and the CNN or detector decides each one. That is option 2 or 3 with a cheap front end, so it still needs DPT above the detector's [minimum](https://github.com/rails49/detector/blob/main/SPEC.md#minimum-dpt). A possible future optimisation, not specified here.

> Licensing, should EX-SensorCAM code ever be reused: EX-SensorCAM is GPL-3.0, and reusing its code here would make the combined work GPL-3.0 rather than MIT. That is a deliberate choice, and must be recorded as one.

### Description

The `.r49` file also carries the layout's name, description, contact and scale, and the camera model. The settings dialog edits all of them except the camera model.

## Format

The `.r49` format is defined in rails49/r49's [FORMAT.md](https://github.com/rails49/r49/blob/main/FORMAT.md) (org [ADR-0022](https://github.com/rails49/.github/blob/main/docs/adr/0022-the-r49-format-is-r49s-and-each-consumer-pins-it.md)). This repository reads and writes it through `@rails49/r49`, pinned in `pnpm-workspace.yaml`. The detector comes the same way, as `@rails49/detector` ([ADR 0019](docs/adr/0019-detection-and-training-move-to-rails49-detector.md)).

## Out of Scope, and Known Gaps

The first list is ruled out and will not be built here. The second is in scope but unresolved, and an implementer will meet it.

### Ruled out

| | Why |
| :--- | :--- |
| Drift correction: homography estimation, re-alignment, fiducials | Out of scope by [ADR 0020](docs/adr/0020-only-the-live-view-measures-drift.md). Drift detection is built; see [Image Alignment](#image-alignment). |
| Track splines, branching polylines, and track topology | [ADR 0021](docs/adr/0021-track-centerlines-are-stored.md) stores track as plain polylines per archive, one run at a time. See [Track centerlines are stored](#track-centerlines-are-stored) and the closed [issue #14](https://github.com/rails49/occupancy/issues/14), whose spline questions that answers by not having splines. |
| Tracing track through a turnout or a crossing, and snapping a sensor onto a centerline | [ADR 0021](docs/adr/0021-track-centerlines-are-stored.md). A sensor there reads [unknown](GLOSSARY.md#occupancy), and a sensor is where its author wants an answer. |
| Populating car subtypes such as `stock.loco.steam` | The mechanism exists; no subtype is labeled here. Adding one is a vocabulary entry in a `@rails49/r49` release, a `detector.classes` entry and a retrain in rails49/detector, and a version bump of each package here, with no relabeling ([rails49/detector ADR 0009](https://github.com/rails49/detector/blob/main/docs/adr/0009-config-yaml-is-authored-and-classes-is-append-only.md)). |
| Calibration provenance: authoring-image references, per-point names, content fingerprints | Settled in [issue #6](https://github.com/rails49/occupancy/issues/6). The general case is camera drift. |
| Coupling as a class or a field | Derivable from L0 as two box endpoints coinciding. A 96 px crop cannot see the relation between two cars that defines a coupler, which is why hand-placed coupling markers never worked. |
| A second model in the live path | [ADR 0004](docs/adr/0004-one-model-in-the-live-path.md). |
| Warping images to correct perspective | [ADR 0015](docs/adr/0015-camera-height-corrects-scale.md), [issue #136](https://github.com/rails49/occupancy/issues/136). A contributor who warps their own photos before submitting produces a consistent archive; the system neither performs nor detects warping. |
| Position (relief) correction | [ADR 0015](docs/adr/0015-camera-height-corrects-scale.md). Nothing maps image positions to layout positions. Returns as a new decision if such a consumer appears. |

### In scope, still unresolved

* How any accuracy claim gets measured. There is no held-out protocol for either model ([rails49/detector ADR 0007](https://github.com/rails49/detector/blob/main/docs/adr/0007-no-automated-model-gate.md)). The detector's `CONFIDENCE_THRESHOLD` cannot be set without held-out recall, so its value is a placeholder. A real protocol waits on the higher-DPT corpus.
* An independent second observer. [A total miss stays invisible](#confidence) to any single-model scheme. The candidates, a CNN verifier over the same points or change detection, are not specified and not worth building before the detector has numbers.
* The proposal interaction. [Assisted Labeling](#assisted-labeling) settles provenance and completeness but not the UX: whether proposing is per image or per archive, whether proposals have a distinct pending look, whether an accept-all should exist given that it must never set `labeled_complete`, and how a wrong proposal is rejected without residue. It can be added later without changing the format.
* L2: event and transition semantics. Rocrail-style enter and in sensors fire on transitions; L1 is per-frame state. Converting one to the other needs debouncing and hysteresis, which is where a phantom becomes a "train entered block" event a controller acts on. Deferred until a real controller is connected.
* Block-span occupancy. Derivable from L0, but a named interval on track presupposes track, so it would bring spline authoring back with it.
* What obliquity costs accuracy, and whether it earns a threshold. An HO car appears 2.6× its overhead width at the corner of a 2×1 m layout under a 1 m camera, but the effect on detection is unmeasured, so no constant is set. Two questions wait on that measurement: whether the capture advisory gains a threshold, and whether `spanToPolygon`'s constant car width needs an obliquity term ([issue #138](https://github.com/rails49/occupancy/issues/138)). A box that assumes an overhead view under-covers a corner car by up to 2.6×, and wrong labels hurt training in a way that distortion alone does not.

---

*Design decisions, open questions and the research behind them are tracked on the wayfinder maps. The format and labeling decisions came from [#2](https://github.com/rails49/occupancy/issues/2); the accuracy campaign and the input geometry are [rails49/detector#2](https://github.com/rails49/detector/issues/2), which is open.*
