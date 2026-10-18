# Model Railroad Track Occupancy Detection with Cameras

## Goals

* Detect presence of trains at specific locations in a layout (**block detection**)
* Detect location, size (length), and orientation of all trains in a layout (**track occupancy detection**)

## Assumption

Humans can reliably control model railroad trains (and real prototype trains) using primarily visual information. **AI should be able to do the same.**

## Classifier

A classifier is used to establish track occupancy. Solutions include:

1. **Image change.** Images taken subsequently differ as trains move. Requires no training and very little compute. The [EX-SensorCAM](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensorcam/) project uses an ESP32 and an inexpensive camera for this. **Investigated and rejected as a primary strategy** — see below.
2. **CNN.** A ResNet or MobileNet recognizing the presence or absence of a train at a specific location. Block detection only. This is what ships today.
3. **Object detector.** A detector such as YOLO that finds the location and orientation of every railroad car on the layout. This gives the most complete information.

**Option 3 is what the live path uses; option 2 is retained but not loaded.** The two are fed from the same labels (see [Location Data](#location-data-cars-and-sensors)), and the CNN answers a genuinely different question — "is this specific point occupied" versus "where is every car" — but [Occupancy Output](#occupancy-output) makes the per-sensor answer a pure geometric consequence of the detector's boxes, which leaves the CNN with no consumer in the live view. So only the detector ships: one model in the bundle, one ORT session, one vocabulary. The classifier package, `TRAIN.ipynb`, and the derived-crop pipeline all survive, so the ResNet stays retrainable and can be revived if the detector disappoints. Proving the detector happens offline through `pnpm --filter dataset online-diagnostics`, not by running both models live. Settled in [issue #7](https://github.com/rails49/occupancy/issues/7).

### Image change is not a candidate for occupancy

**Decision: change detection will not be used as a primary occupancy classifier.** Options 2 and 3 are the strategy. This is settled, not open — see the full analysis in [`docs/research/image-change-detection.md`](docs/research/image-change-detection.md).

The reason is structural rather than a matter of tuning. A change detector must adapt its reference frame to survive illumination drift, and must *not* adapt while a train sits still. The only policy that satisfies both is to gate adaptation on the occupancy decision itself — which is what EX-SensorCAM does — and that makes **both error directions absorbing states**: a false trip freezes the reference and therefore persists, while a missed train is averaged into the reference and becomes permanent background. DCC-EX documents this in its own manual: the sensor can remain permanently "occupied" until manually re-referenced. No threshold trades the two off; it only selects which latch you get.

Supporting findings:

* SensorCAM's metric is per-quadrant colour *ratios*, not pixel differencing — deliberately intensity-invariant, with a decision budget of ~10 counts. Re-implemented and run against this repo's own `lighting.r49`, it false-tripped on **100%** of samples of a patch of bare table that is visually identical across the sequence, and 25.5% between the mildest adjacent image pair. `lighting.r49`'s luminance moves only 7%, but its R/B ratio moves 10.5% — precisely the axis the metric measures.
* No measured accuracy figure is published anywhere by the project; it is self-described Alpha and its own comparison page says it is "not currently suitable for exhibition layouts". SPEC's earlier "gives little information about accuracy" was, if anything, understated.
* In the literature this is CDnet 2014's *Intermittent Object Motion* category, where unsupervised methods score 0.66–0.78 F-measure against ~0.95 on baseline sequences — and every method that closes the gap does so by adding a semantic segmenter or instance detector, i.e. the field's own answer is Option 3.
* Change detection has no notion of "train". `lighting.r49`'s variation was in fact produced by placing a cardboard box in the scene; a change detector reports that as occupancy, as it would a hand, a tool, or a person leaning over the layout.

What the rejection does **not** claim: change detection is cheap, needs no labels, and — at the DPT 3.4–7.6 SensorCAM operates at — is the one option not blocked on the DPT > 20 threshold. Those properties make it genuinely useful for jobs that are not occupancy; see [Secondary uses of change detection](#secondary-uses-of-change-detection).

### The detector is YOLO26n-OBB

Settled in [issue #3](https://github.com/rails49/occupancy/issues/3) (feasibility) and [issue #10](https://github.com/rails49/occupancy/issues/10) (licensing).

| | |
| :--- | :--- |
| Family | Ultralytics **YOLO26n-OBB**, fine-tuned from the pretrained DOTA checkpoint |
| Head | **Oriented** bounding box; NMS-free, exported `end2end: True` |
| Output tensor | `[1, 300, 7]` — a fixed 300-slot buffer every frame |
| Input | one square canvas at constant DPT (see [Input geometry](#input-geometry-is-dpt-normalized)) |
| Quantization | **static INT8** |
| Shipped artifact | `.ort`, **3.30 MiB** measured, against the 25 MiB Cloudflare Pages ceiling |
| Runtime | `onnxruntime-web`, WASM execution provider |

**The OBB head is required, not an optimization.** It costs +2.5% model size and ~+1% FLOPs. An earlier justification rested on track's poor axis-aligned fill (14–25%), which is moot now that track is not a detector class — and cars in the current corpus sit at a median 4° from horizontal, so the fill argument alone would be weak. The real reason is that [the occupancy test](#the-occupancy-test) **is** point-in-oriented-box against the car's own axis: orientation is a required output of the model, not a way to make its boxes tighter.

**Static INT8 is mandatory and dynamic quantization fails loudly.** `ConvInteger` is `NOT_IMPLEMENTED` on the CPU execution provider — dynamic quantization targets RNN and transformer graphs, static targets CNNs. Static requires calibration data; ten frames from the corpus sufficed. FP16 is not a useful intermediate rung on a CPU/WASM target.

**Where the training pipeline lives in the repo is not specified here.** [Issue #3](https://github.com/rails49/occupancy/issues/3) recommends a layout parallel to `classifier/resnet/`; nothing else about it is settled.

#### Input geometry is DPT-normalized

Settled in [issue #130](https://github.com/rails49/occupancy/issues/130). **This is a target, not the current code** — `detector.input: [960, 544]` still ships.

An authored input grid fixes object scale by accident: how many pixels a car spans falls out of the grid and the layout's extent, with nothing holding it constant. That is the pipeline's largest silent accuracy risk, because [issue #112](https://github.com/rails49/occupancy/issues/112) measured the model scale-locking hard — 79% of cars found at 10 model-pixels of car width against 29% at 19.9, same weights, same data. So **scale is normalized instead of inherited**: every image is resampled to a constant DPT, and cars are then at the trained scale by construction, for every layout at every extent.

The geometry that follows:

* **One authored square canvas**, a `config.yaml` constant replacing `detector.input`. **Authored, never derived** as a maximum over the corpus — a derived size lets one contributor's large layout inflate training memory for everyone and change `imgsz` silently between exports, which is the [`classes` failure shape](#parameters-live-in-configyaml): a config that still validates while invalidating every comparison.
* **Square is load-bearing, not cosmetic.** Ultralytics enforces a scalar `imgsz` for training, so without `rect=True` the letterbox pads to `imgsz × imgsz`. A rectangular canvas would train at one padding distribution and deploy at another — the failure [issue #114](https://github.com/rails49/occupancy/issues/114) recorded, where a grid 43% grey in training ran 0.7% grey deployed. A square canvas makes every stage see an identical tensor, so the invariant is held by **shape identity rather than by a flag or a computed agreement**.
* **Images are padded onto the canvas, never resized** — see [YOLO annotations](#yolo-annotations-for-the-detector), where the rule and its reason live.
* **Captures larger than the canvas are tiled** into square crops with overlap exceeding the longest car, which makes "every car appears uncut in at least one tile" arithmetic rather than a hope: with stride `T − O`, a car of length `L` is wholly inside some tile exactly when `L ≤ O`.
* **Tile detections are unioned in full-frame coordinates**, and the union is monotone in the safe direction. [The occupancy test](#the-occupancy-test) reports `occupied` if *any* detection covers the sensor, so adding boxes can only flip `clear → occupied` — **tiling cannot manufacture a false clear**. Its error lands on the phantom rate, which [Accuracy](#accuracy) allows ten times the headroom.
* **Export stays static** at the canvas size. Every tensor the model ever sees is canvas-sized, so nothing is left to be dynamic about; a fixed canvas also turns the `end2end` head's anchor floor and its 300-slot ceiling into known properties rather than runtime surprises. A dynamic ONNX export is a *measured* fallback — it survives the whole INT8 → `.ort` chain at accuracy parity — held in reserve rather than adopted, because taking it would spend the chain's one unmeasured link (in-browser WASM at runtime-varying shapes) on flexibility the canvas already provides.

**The canvas is invisible to users and to the format.** v4 needs no new field: a layout is authored with images at whatever size the camera produces, and both the editor and the live view draw in full-frame image pixels. Normalization and tiling happen between a frame arriving and occupancy being computed, and detections return mapped into the frame's own coordinates. Two things do reach the user, both pre-existing — the `min_dpt` bar at capture, and tile count scaling inference cost.

Its value is not fixed here. It is bounded below by the head's anchor floor (`H·W ≥ ~14,629` px, measured) and above by training memory, which [issue #128](https://github.com/rails49/occupancy/issues/128) exists to establish.

#### Licensing: the project is AGPL-3.0

**Adopting YOLO26n-OBB is why this repository is AGPL-3.0 rather than MIT**, and the project's own trained weights are published under AGPL-3.0 too. The relicense has already landed — root `LICENSE` and `package.json` both say so — but it is recorded here because it is a consequence of the detector choice, not an independent preference, and it would have to be revisited if the detector family ever changed.

The usual escape hatch does not apply. The `ultralytics` package is a training-time dependency that never ships — inference runs on `onnxruntime-web`, which is MIT — so no AGPL *code* reaches a user, and the output of a GPL tool is not normally covered by the tool's licence. But **there are 46 images.** YOLO26 cannot be trained from random initialisation on a corpus that size; it must be fine-tuned from the pretrained DOTA checkpoint, which is itself an AGPL-licensed artifact (the licence is embedded in its ONNX metadata). The result is a derivative of a licensed work, not merely a tool's output. **The encumbrance travels with the weights, and the corpus size is what closes the hatch.**

Relicensing is cheap here for reasons specific to this repo: the earlier move to MIT was about shedding the CLA, not about enabling permissive downstream embedding, and AGPL never required a CLA — so none of that overhead returns, and the no-contributor-gate model is unchanged. There is a sole copyright holder, so the change is unilateral. Dependency licences (MIT, BSD, Apache-2.0) are all one-way compatible into AGPL-3.0.

Accepted costs: the change is **forward-only** — the existing MIT snapshot stays MIT and forkable in perpetuity — and permissive downstream embedding is foreclosed. **Rejected:** keeping the repo MIT and treating the weights as a separately-licensed aggregated artifact. Weights being gitignored and shipped as Release assets gives that surface plausibility, but both halves are served from one site as one product.

*Not legal advice. If this becomes commercial, the Ultralytics Enterprise licence question returns.*

## Accuracy

Extremely high accuracy is required to avoid collisions and other problems.

Classifiers can be trained per layout, so only modest generalization is needed — recognizing trains at layout positions absent from the training data, or rolling stock the model has not seen. On that basis >99.9% should be achievable. (Still not sufficient for prototype trains, where accidents are far more costly.)

> ⚠️ **The currently reported 99.58% is not a generalization estimate.** The regression test iterates every marker in every archive, so roughly 770 of its 963 samples were seen during training. It is a *reproducibility* check — does this `.ort` still behave like the published one — not a held-out measurement. Any >99.9% target needs a held-out evaluation that does not yet exist. See issue #4. *More testing and formal assessment is required with newly trained classifiers or detectors.*
>
> **The regression test is retired at the v4 conversion** ([issue #8](https://github.com/rails49/occupancy/issues/8)), along with the 99.5% gate in `bin/test.sh`, because v4 deletes the point markers it iterates. It guarded an artifact no longer loaded in the live path, using a number that was never a generalization estimate — so the figures above are stale-on-migration rather than targets to preserve. The accepted cost is a window, between the conversion and the first detector, with no automated check that a model rebuild matches the published one.

**Safety:** nothing here may be presented as a safety interlock. The classifier does sometimes miss rolling stock and report phantom trains.

## Occupancy Output

Settled in [issue #7](https://github.com/rails49/occupancy/issues/7). The system reports **two layers and no more**:

| | What it is | Source |
| :--- | :--- | :--- |
| **L0** | Every detected car: pose, class, confidence — exactly as the detector emitted it | the model |
| **L1** | Per-sensor state: `occupied` / `clear` / `unknown` | pure geometry over L0 |

**L1 never calls a second model.** It is a pure function of L0, so it cannot contradict the boxes drawn beside it, it needs no second inference, and it costs the same whether a layout has three sensors or three hundred — the detector runs once per frame regardless. There is consequently no disagreement rule to specify.

Everything above L1 — event and transition semantics (Rocrail's enter/in sensors fire on *transitions*, not per-frame state) and block-span occupancy — is deliberately unspecified. L0 carries full car pose, so those remain computable later from archives recorded today.

### The occupancy test

A sensor is `occupied` when a detection's oriented box **strictly contains** its point. No tolerance epsilon: any value would be unvalidatable, the lateral direction already carries ~1.4 m prototype of slack from the derived width, and at a coupler the two boxes abut on a shared endpoint so a point between coupled cars is already inside one of them. A real gap between uncoupled cars should read `clear`, and an epsilon would manufacture a phantom there.

The box tested is **width-normalized**: centre, orientation and length come from the detector, but the DPT-derived width constant **replaces the predicted width**. Width is not observed data — it is a single constant with no per-label override (see [Location Data](#location-data-cars-and-sensors)), so every training label carries the same width and the model's width output is a fit to a constant. Its deviation is pure error, and directional: at DPT 20 a car is ~42 px wide, so a centreline sensor sits ~21 px inside the boundary; an under-predicted 25 px width cuts that to ~12 px and can flip a covered sensor to `clear`. Substituting the constant only ever widens an under-predicted box, which is the safe direction. **L0 still reports the raw predicted box** — normalization belongs to L1's geometry, not to the detector's output.

> ⚠️ **Known limitation: long cars on tight curves.** The box's long axis is the chord between the car's endpoints, but track bows off that chord by the sagitta `L²/8R`. Once that exceeds the half-width (17.2 mm in HO), a sensor near the car's **midpoint** falls outside the box. The ends still register, so a long car crossing a sensor reads occupied → clear → occupied.
>
> | Car length (prototype) | Fails below radius |
> | :--- | :--- |
> | 40–50 ft freight | ~8.8" — never in practice |
> | 69 ft | ~16.7" |
> | 80 ft | ~22.4" |
> | 85 ft passenger / autorack | **~25.3"** |
>
> Accepted rather than fixed: first tests are short cars on straight track. **The mitigation is a constant, not code** — inflate `layout.standard_width` in `config.yaml`. Covering an 85 ft car on an 18" radius needs a half-width ≥ 24.3 mm, i.e. a model width of ~48.5 mm against 34.5 mm — **`standard_width` 3000 → ~4220 mm, a factor of 1.41**.
>
> All figures above are computed from `standard_width = 3000`; they move if that constant does.
>
> The alternative — projecting onto the track spline and testing arc-length overlap — was rejected. Cost was never the objection (~8,000 distance evaluations, tens of µs against 377,000 µs of inference). It trades this *bounded, quantified* failure for an unbounded one: "nearest spline" is ambiguous exactly where layouts are densest — parallel sidings (~60 px apart at DPT 20), turnouts, yard ladders — and a mis-association reports the **wrong track** occupied, at a rate nothing can bound. (It is also now unbuildable as stated: [issue #13](https://github.com/rails49/occupancy/issues/13) removed track geometry from v4, so there is no spline to project onto.)

### The vocabulary

| State | When |
| :--- | :--- |
| `occupied` | any detection above the threshold covers the point — **including low-confidence ones** |
| `clear` | no detection covers the point |
| `unknown` | the system **cannot answer**: sensor outside the frame, DPT unresolved, model not loaded, or camera drift detected ([issue #12](https://github.com/rails49/occupancy/issues/12)) |

**`unknown` is never a confidence outcome.** It means "I was unable to look", not "I looked and I'm unsure" — which is what keeps it genuinely distinct from `clear`.

**Errors are biased toward `occupied`, deliberately.** A missed car costs a collision; a phantom costs "why do trains never go there". This matches prototype practice: real track circuits are wired so that a failure shows occupied. Every case where the model *did* look and saw something therefore resolves to `occupied`, which is why no "unsure" confidence band exists.

The bias reduces the *consequence* of the worse error. It does not make this a safety interlock; the constraint above stands unchanged.

**Accepted consequence:** a persistent phantom `occupied` is worse than cosmetic. A permanently blocked block is never entered and never cleared, so it can **deadlock a controller's schedule**. Weighed against a collision and accepted.

### Confidence

Every L0 detection carries its confidence, and an `occupied` L1 state carries the confidence of the covering detection (the maximum, where several overlap).

**`clear` carries no confidence — absent, not `0.0` and not `1.0`.** `occupied` is evidenced by a specific detection; `clear` is the *absence* of evidence, and nothing scored it. `0.0` would read as "definitely not occupied" and `1.0` as "definitely clear"; both claim a measurement that was never made. This matters because the system's two error modes are asymmetric in *inspectability*: a phantom arrives with a confidence a consumer can threshold, while **a miss arrives as a confident-looking `clear` with nothing behind it**. Leaving that confidence absent is the only encoding that does not hide the distinction.

A **single** confidence threshold, `detector.confidence_threshold` in `config.yaml`. It replaces the hardcoded `0.5` at `lib/classifier/src/base.ts:101`. Two properties of it:

* **Thresholding is decoding, not filtering.** The detector's export is `end2end: True` with output `[1, 300, 7]` — a fixed 300-slot buffer emitted every frame, mostly padding. There is no version of L0 that skips the threshold.
* **It has a floor above zero.** At 0 you accept 300 phantom cars blanketing the frame, so every sensor reads `occupied` on every frame and the system reports nothing at all. The value must sit low but above the padding noise, and it can only be found by measuring recall against a held-out split — which does not yet exist for either model (see [Accuracy](#accuracy)).

The fail-safe bias lives in **L1**. L0 stays raw, so a consumer wanting a stricter reading can re-threshold the same frame's data without fighting the default.

> ⚠️ **A total miss stays invisible.** No single-model scheme makes it detectable. Two thresholds do not; nor does adding a track class — a missed car with confidently-detected track under it is a *confident false clear*, worse than an unevidenced one, and the two failure modes are correlated so it is not an independent check. Only a genuinely independent second observer would close this: a CNN verifier over the same points, or [change detection](#secondary-uses-of-change-detection). Neither is specified, and neither is worth building before the detector has held-out numbers.

### Output encoding

L0 detections are reported in **`camera.resolution` pixel coordinates**: centre `{x, y}`, length px, width px, orientation in **radians from the +x axis**, plus class and confidence.

That frame is chosen because it is the only stable one. The model's input resolution (960×544) is selected by geometry and changes on re-export; the video's natural size varies per device and camera; normalized 0…1 coordinates sever the link to DPT, which is px/mm. `camera.resolution` is the frame sensors, labels, and calibration are *already* authored in — so the point-in-box test needs no conversion, the SVG viewBox maps 1:1 onto it so boxes draw over the video with no transform, and any length converts to millimetres with one DPT multiply. No millimetre field is stored; it is one multiply away.

**Off-track detections pass through untouched.** A sensor is placed on track by the person who wants an answer there, so a box far from any track contains no sensor and cannot change any L1 verdict — there is nothing to protect. Filtering would need the spline association rejected above — which is now doubly unavailable, since v4 stores no track geometry at all — would make L0 not raw, and would destroy real information: a box around a car sitting in the scenery tells a human something (a false positive, a derailment, a hand over the layout, or a car on unlabeled track) that a suppressed box does not. Confidence, not geometry, is the right filter for junk — a spurious detection is characteristically low-confidence, whereas a genuine car on unlabeled track is confident and should survive.

**Sensor identity: consumers key on `id`; `name` is optional passthrough, absent when unset and never auto-generated.** ids survive edits; names are free text, are not unique, and a controller mapping keyed on one breaks the moment someone renames it. An auto-generated "Sensor 3" is worse than none — indistinguishable from a name a human chose, and it silently stops matching as sensors are added and removed. The optional `name` exists for Rocrail and for humans who cannot remember hex strings; the UI displays the `id` as fallback. No uniqueness is enforced.

**Couplings are not reported.** They are derivable from L0 — two detected box endpoints coinciding — and adding a field or a class for them would restate what the geometry already says.

## Features

The UI provides an interface to create, visualize, and edit `.r49` files via the library in `lib/r49`. The sections below describe the requirements.

### Images

`.r49` files contain a list of images of the model layout taken with an overhead camera. The UI allows acquiring and removing images.

### Calibration

#### Establishes the relation (scale) to the prototype

Supports common track geometries (HO, N, Z, etc).

#### Establishes the relation between image pixels and physical dimensions

To avoid having to recognize objects at different scales, the app uses **DPT** (dots per track width) as the relation between pixel and physical coordinates.

**Example.** Two points in an N-scale layout are 1000 pixels apart in the image and 250 mm apart on the physical layout, giving 1000/250 = **4 dots per millimeter**. Track width in N scale is `STANDARD_GAUGE/160 = 1435/160 ≈ 9 mm` (`STANDARD_GAUGE` is defined in the `.r49` library). Hence **DPT = 4 × 9 = 36** dots per track width for this image.

In practice **DPT > 20** is required: below that, a car is too few pixels across for the detector to localize reliably, and the CNN's crop covers too little of the track to be discriminative. The corpus measured so far sits at DPT 18–19, i.e. marginally under this threshold. The threshold is `layout.min_dpt` in `config.yaml` rather than a number buried in the UI — under `layout` and not `classifier`, because it gates the **editor**.

> **Consequence — UI development and training data are decoupled.** The existing 46 images are below the DPT threshold and need re-shooting, which is not currently possible. They remain perfectly adequate as **UI fixtures**: they exercise every code path in the editor and cost nothing. **Training will use fresh, higher-DPT images captured later.** Do not tune model accuracy against the current corpus, and do not treat its numbers as predictive.

Ideally the layout is perfectly parallel to the camera plane, and at infinite distance from it. Then it suffices to specify the distance in millimeters between two points at the same height to establish DPT.

Neither holds in practice, and **the cost has been measured rather than assumed** ([issue #103](https://github.com/rails49/occupancy/issues/103), resolved under [map #125](https://github.com/rails49/occupancy/issues/125); the derivations and their sources are in `docs/research/camera-calibration.md`). A real layout is not planar — track sits at 0–85 mm and scenery higher — and a real camera hangs a finite 1–1.5 m above it. Under a pinhole camera at height `h`, **every length at height `z` reads `z/(h−z)` too large**: 9.3% at track height under a 1 m camera, 30% at scenery height. That bias lands in DPT and so in everything DPT feeds — car width in pixels, the drift tolerance, the `min_dpt` gate, the [DPT-normalization](#input-geometry-is-dpt-normalized) resample factor.

Two properties of that expression decide the whole design. **Focal length cancels from it** — it is a ratio of depths — so lens choice cannot fix the error and camera *height* is the only lever. And the error is **one-dimensional**: a single measured number removes it, which is why [Camera height](#camera-height-is-what-corrects-the-third-dimension) is the correction rather than a full camera model.

Other errors are ignored: barrel distortion (worst on the ultrawide lens a low mount forces), and camera tilt, which strictly adds to the figures above rather than replacing them.

#### Reference points

Calibration is a **list of points, each carrying both coordinates** — where it is in the image, and where it is on the layout:

```jsonc
calibration: {
  points: [
    { px: { x, y }, world: { x, y, z } },   // px = image pixels, world = mm
    ...
  ]
}
```

`world` is relative to an **arbitrary origin that is the same for every point in the layout**; the orientation of that frame is arbitrary too. A flat layout is implicit and accepted — in practice every point shares one `z`.

A point carries no `id` and no `name`. Nothing references an individual point, so identity buys nothing at the two-to-four points a real calibration has; both are additive later if perspective correction ever wants them. The v3 `size_mm` field is gone — the distance it encoded is implied by the world coordinates.

**DPT is a single least-squares scale, with each pair normalized to the reference plane by the camera height:**

```
s   = Σ(d_px' · d_mm) / Σ(d_mm²)    over all pairs, where d_px' = d_px · (h − z)/h
DPT = s · gauge_mm(scale) · h/(h − z_ref)
```

`h` is the authored camera height above layout zero and `z_ref` the authored reference height — see [Camera height](#camera-height-is-what-corrects-the-third-dimension). **Every pair enters the fit regardless of height**, because the normalization removes the depth term that made mixed heights incomparable.

**Absent `h` the fit restricts to pairs at `z == z_ref`** — "without a camera height I can only speak about the plane you named" — and points off that plane stay stored but **inert**. That is the state every archive is in today, and the fallback is exactly the historical behaviour for an archive calibrated on one plane, which all six fixtures are.

The `d_mm²` weighting favours long baselines automatically, which is the right bias: click error is a fixed number of pixels, so short baselines are proportionally noisier. It matters twice here, because recovering anything from the third dimension needs long baselines (below). When no usable pair exists, DPT is `null` — uncalibrated.

> **This is a target, not the current code.** `getDPT()` fits equal-`z` pairs only, at any height, with no `h`. Note that today's rule admits pairs at *different* equal heights into one fit, silently blending scales up to 9% apart; the fallback above is narrower on purpose, and provably identical on every archive that exists.

A v3 `{p0, p1, size_mm}` imports as two points at `world (0,0,0)` and `(0, size_mm, 0)`. Nothing is lost; a measured distance *is* a pair of positions in a frame you chose.

**Minimum viable calibration is two points with a nonzero separation** — precisely "DPT resolves". Because car width is derived from DPT rather than stored, an uncalibrated archive cannot render a label at all, so the editor opens in calibration mode with the labeling tools **disabled and the reason stated**. The translucent width rectangle is the only feedback that tells a user whether their two clicks actually cover the car; labeling without it produces a corpus nobody can trust. A `DPT` below the threshold warns persistently but **never blocks** — the fixture corpus lives there.

Points are placed with a tool **distinct from the sensor tool** and visually unmistakable from it: click a pixel, then enter the x/y/z millimetre coordinate. A point renders as a crosshair labelled with its world coordinate. With more than two points the editor shows the **fit residual**, so a mis-typed coordinate is visible rather than silently absorbed into the scale.

#### Camera height is what corrects the third dimension

Settled in [issue #135](https://github.com/rails49/occupancy/issues/135). **This is a target, not the current code.**

The layout is not planar and the camera is not at infinity, so scale varies with height by `z/(h−z)`. Two authored numbers remove it:

* **`h` — camera height above layout zero**, optional. It is the *only* scalar that helps. Focal length was rejected outright: it cancels from every error term, all three Exif focal tags are optional in the standard, `DigitalZoomRatio` silently invalidates the conversion, and the live `getUserMedia` path carries no Exif at all — the W3C Image Capture spec exposes zoom and focus distance and **no focal length in any unit**. `h` reaches the correction directly, costs zero additional calibration points, and is available identically for an archive and for a live stream.
* **`z_ref` — the reference height, i.e. railhead above layout zero**, optional, defaulting to 0. It fixes *where DPT is reported*. The argument is the name: **DPT is Dots Per Track**, its unit is a track width, and reporting it on a plane where there is no track is incoherent with what the number claims to be. Every consumer keeps taking one scalar, now the right one; `dptAtHeight(z)` serves anything else. A resample is a single global factor and cannot vary per pixel, so a reference height had to be chosen somewhere — this makes the choice authored and visible instead of implicit and wrong.

**`camera_height_mm` is optional in the schema and required by the editor** ([issue #139](https://github.com/rails49/occupancy/issues/139)). Within one layout and camera the bias largely cancels — the same DPT scales the training images and the inference frames — but **across contributors it does not**, and a ~9% spread between a baseboard-calibrated and a railhead-calibrated archive is exactly the variance [Input geometry](#input-geometry-is-dpt-normalized) exists to remove. The cost is therefore unmeasurable today and *unfixable later*, since nobody recalls where a camera stood months on, while supplying it is one tape measurement per layout. So the editor keeps one declared list of **required layout metadata** — `scale`, layout `name`, `camera_height_mm`, extensible — and the settings dialog opens **undismissable until every one is supplied**, on create and on any open that is missing one. An archive carrying them all opens straight through.

Enforcement is the editor's, never the schema's: a required *field* would fail every archive that predates it, which is the orphan-everything cost of a version bump by another road. This is the [minimum-viable-calibration](#reference-points) gate's principle applied to metadata — open, state the reason, withhold authoring.

**A camera height must exceed the largest authored `z`** — the camera is above the scenery. It costs nothing and catches the decimal or unit slip that the fit residual structurally *cannot* see when every calibration point sits on one plane. The check earned itself before it was built: the six fixtures' height was first recorded as 115 mm, which would demand a **166° diagonal field of view** to cover the 1660–1763 mm each frame spans at DPT 18–19. The measured value is 1150 mm, needing 79–83°.

**Accuracy of the correction is second-order**: the residual scale error is `(z/(h−z))·(Δh/h)`, so a tape measure good to ±20 mm leaves 0.19% at track height against 9.3% uncorrected — a ~50× reduction for one number a user can check by re-measuring.

**`h` is cross-checked by the fit itself, not by a separate estimator.** A wrong `h` normalizes pairs at different heights inconsistently, and that inconsistency is exactly what the existing fit residual measures. Note the residual *refits* rather than scoring against a held scale, so it reports about **half** the raw disagreement between planes. Measured against a ~1.4 px click floor at DPT 20 with 500 mm baselines: a 50% error in `h` shows 8.1 px, 20% shows 4.0 px, 10% shows 2.2 px, and 5% disappears into the floor. Gross errors are unmissable and small ones are not — which is the right shape for a cross-check. The check is **structurally blind when every point sits at one height** — a uniform scale bias is indistinguishable from a different camera distance — so it is a cross-check and never a gate. Where long-baseline pairs at two heights do exist, `h` is also *derivable* (`h = z·R/(R−1)`, ~3% at 500 mm baselines); the editor may **offer** that as a suggested value, but the fit never derives it silently, because a correction that appears and disappears with the shape of the point set is worse than no correction.

**Scale is corrected; position is not.** A point at horizontal radius ρ and height `z` also lands displaced by `ρ·z/(h−z)` — photogrammetry's *relief displacement*, 104 mm ≈ 6.3 track gauges at the corner of a 2×1 m layout under a 1 m camera. It is **latent**: sensors, car spans and detections all live in image pixels, and nothing maps image↔world *positions*, so no running computation is wrong by it. A correction with no caller is not built. It also needs the nadir pixel, which assuming the image centre gets wrong in exactly the tilted case the correction would be for.

**What the system does about what remains — warn, in one place, with no threshold** ([issue #136](https://github.com/rails49/occupancy/issues/136)):

* **The editor's DPT bar reports all three states**: no `h` (scale on the reference plane only, and enter the height to correct it), `h` present (*naming the height it corrected with*), and `h` present with poor geometry (below). The middle case is load-bearing rather than decorative — authoring `h` moves every DPT number by up to 9%, and a bar that spoke only on failure would let that happen with nothing on screen explaining it. This is the [drift reference-row](#image-alignment) precedent, and warn-never-block throughout.
* **Absent `h`, no magnitude is quoted.** `z/(h−z)` is not computable without `h`, and a number printed under an assumed height would sit in the same bar as measured ones with nothing distinguishing them. `getDPT()` already sets the rule: `null` means "I cannot answer", not "zero".
* **The live view says nothing and never refuses.** Refusal must mean *the mapping you authored is no longer valid* — true of drift, false here: perspective error is a **static** property, equally present when the images were shot, the sensors placed, and the labels drawn. The detector trains and infers in the same distorted frame, so nothing is invalidated. Refusing would reject every archive in existence for a condition already true when its labels were drawn. (An operator who re-mounts the camera at a height other than the authored `h` *is* a change from the authored pose — that is [drift](#image-alignment)'s domain.)
* **The capture advisory reports obliquity and the lever, with no constant.** With `h` and the calibration points' own world extent, worst-case obliquity is `atan(ρ_max/h)` and the worst-case apparent-width inflation is `1 + (c/w)·tan θ`, where `c/w ≈ 1.43` is a prototype car's height over its width — **scale-independent**, since both divide by the same ratio, so one formula serves HO, N and Z. An HO car at the corner of a 2×1 m layout presents **2.6× its nadir width under a 1 m camera**, 1.8× at 2 m, 1.5× at 3 m. The bar states the number *and the lever*: height is the only control and it works twice, on obliquity and on the ultrawide lens a low mount forces (~19 mm equivalent at 1 m, ~39 mm at 2 m). **No `max_obliquity` constant is set** — the curve has no natural breakpoint and nothing has yet measured what obliquity costs *accuracy*, so a number picked now would be the substitute gate [Accuracy](#accuracy) warns against.

#### Image Alignment

For pixel data to map to the same layout location, the camera position must not change across images or during classification. **This is no longer assumed silently: drift is detected and classification refused** ([issue #12](https://github.com/rails49/occupancy/issues/12), built under [map #89](https://github.com/rails49/occupancy/issues/89)). Nothing records the camera pose, and nothing needs to: **the archive is the pose record**, and a reference is derived from it at load time rather than stored. `@occupancy/drift` compares the structural content of a frame against that reference (block-wise phase correlation, which reads geometry and discards illumination) and reports a displacement in `camera.resolution` pixels; past `layout.max_drift_track_fraction` of a track width the live view withholds every sensor as `unknown` with reason `drift` — with a visible override — and the editor warns without blocking.

**The reference is one image: the first in `images`, which is the first thumbnail in the editor's strip** ([issue #118](https://github.com/rails49/occupancy/issues/118)). The original design took *every* image as a reference and scored the minimum over them, on the premise that every image in an archive was shot from the canonical position by construction. **That premise does not survive authoring.** The editor warns about a drifted image and never blocks it, so a labeler may keep one — and under a minimum-over-all rule that image then defined an acceptable pose, making the drifted camera score zero and silencing the refusal permanently. One accepted warning widened the envelope for good.

Designating position 0 fixes it without a format change, and the ordering control is what keeps the designation honest rather than hidden: the editor shows **every** image's drift against the reference, so dragging a thumbnail to the front re-points the comparison and visibly re-measures everything. Image order therefore carries meaning it did not before — it is no longer purely presentational.

The tolerance is **geometric, not a pixel count**, because the failure is: occupancy breaks when a sensor stops sitting on the car it is meant to read, either falling outside the box or sliding onto a neighbouring track's car, and both boundaries sit near one whole track width. DPT is pixels per track gauge, so a quarter of a track width is a ~4x margin on that failure at any scale and camera distance, where a fixed pixel count would mean five times as much misalignment at DPT 18 as at DPT 90. It is a **tolerance and not a detection floor**: the check resolves displacements far smaller than this accepts, and refusing on a drift too small to move a sensor off its track would be refusing on nothing.

The response is asymmetric on purpose. Occupancy output is machine-consumable, so a banner does not reach the consumer and only refusal is honest; in the editor a human is present and can judge, which is the `min_dpt` precedent. **Correction is expressly not part of this**: aligning images on structural details, homography re-alignment and fiducial markers stay out of scope — detection converts the silent failure into a loud one, which is most of the safety value for a fraction of the effort. Validation is still **entirely synthetic** (the fixture corpus was shot on a tripod, so `tools/drift-bench` warps it), which is why the override exists.

> Measured: within an archive the camera *is* static. `lighting.r49` has a track marker at (202, 591) in image-0 and (202, 592) in image-1. Calibration is also **shared verbatim across archives** — the three `cars *` archives carry byte-identical calibration — which may be a data-entry error rather than a genuinely identical rig. [Issue #6](https://github.com/rails49/occupancy/issues/6) closed this as **not worth provisioning against**: those archives are disposable UI fixtures, so v4 records no calibration provenance (no authoring-image reference, no per-point names, no content fingerprints). The general case — a stale calibration failing silently — is camera drift, and belongs to [issue #12](https://github.com/rails49/occupancy/issues/12).

### Location Data: Cars and Sensors

The `.r49` format and UI editor store and edit **two** distinct kinds of geometry in pixel coordinates. They differ in scope and in whether the model ever sees them:

| | Geometry | Scope | Trained on? | Provenance? |
|---|---|---|---|---|
| **Cars** | Two points along the car's centerline | Per **image** | **Yes** — the detector's only class | **Yes** |
| **Sensors** | Single point | Per **layout** | **No** — an output specification | No |

1. **Cars.** Cars are straight and of standard width, so a car is fully described by **two points** along its centerline; width is derived rather than stored. The constant is `layout.standard_width` = **3000 mm prototype**, chosen as the **widest real prototype** (SBB RAm TEE I) rather than a typical one: width is what makes a sensor register, so an over-wide box biases toward `occupied`, which is the direction [Occupancy Output](#occupancy-output) deliberately errs in. Because width in pixels is `DPT × standard_width / standard_gauge`, the scale ratio cancels — **a car is 2.09 track-widths wide in every scale**, and no scale lookup is needed. Trains are sequences of cars where the end of one coincides with the start of the next — so **couplings need not be labeled or detected**, they are derivable from abutting car endpoints. Each car carries [provenance](#provenance-is-required-not-optional).

2. **Sensors** (block detectors). Points where occupancy must be reported when running trains. These are an *output specification*, not training data: they say where the deployed system must answer, and they never enter a loss function. What they answer *with* is [Occupancy Output](#occupancy-output). They remain **points**, not spans: a span would match a prototype block more closely, but L0 carries full car pose so block semantics stay derivable later, whereas authoring intervals is real UI for a consumer not yet observable. Sensors carry **no** provenance — no model can propose where a human wants an answer, so the field would be permanently `human` and therefore noise.

#### Track is not stored, and that is a deliberate deferral

**There was a third geometry — track, as per-layout splines — and it is not in v4.** Settled in [issue #13](https://github.com/rails49/occupancy/issues/13).

Track turned out to have **no live-path consumer**. It is not a detector class and never enters a loss; [Occupancy Output](#occupancy-output) tests a point against the detector's oriented boxes and explicitly rejects associating detections with a spline; and its remaining use — generating empty-track CNN crops — is dormant because only the detector ships. That left one live use, snapping cars to the centerline while authoring.

Decisively, **track is fully retrofittable**: it is layout-scoped, the camera is fixed within an archive, and the images persist, so splines can be authored into an existing archive at any later date **without invalidating a single car label**. That is the exact inverse of provenance, which cannot be recovered after the fact — and it is why one is deferred and the other is provisioned now.

So cars are authored as two free clicks on the visible car ends. Dropping the snap may even *help* label quality: the user can see the actual car in the photograph, whereas a snap projects onto a spline that may itself be slightly off, and the detector's orientation output comes from the car's true axis.

**What this costs, stated plainly:** the derived empty-track training crops described in [issue #4](https://github.com/rails49/occupancy/issues/4) are unobtainable while track is deferred. That is owed back only if the ResNet is revived.

Track authoring returns as a **fresh effort**, not a resumption — see the closed [issue #14](https://github.com/rails49/occupancy/issues/14), which records the questions (spline creation, control-point editing, Catmull-Rom versus Bezier, turnouts, whether track carries topology) that remain genuinely open.

#### Labeling completeness

Every image used for detector training must have **all** of its cars labeled. An object present but unlabeled is treated as background by the loss, so partial labeling actively teaches the detector that cars are background. This cannot be scoped per class — the loss is shared across a whole image.

Each image therefore carries a **completeness flag**, `labeled_complete`; only complete images are exported for training. Incomplete images remain useful for authoring and review. That per-image geometry does get skipped in practice is already on record: `cars 0-10.r49` has 32 track markers on image-0 and **zero** on its other ten images.

**`labeled_complete` means exactly one thing: a human asserts that no car in this image is unlabeled.** It is an assertion about *absence*, which is why it cannot be replaced by anything per-label — see [Provenance](#provenance-is-required-not-optional). **Accepting model proposals never sets it**, however many are accepted; marking an image complete stays a separate deliberate act. Scanning for what the model **missed** is a different act from judging what it proposed, and only the first can back this flag.

An image marked complete with **zero** car labels is legitimate, not a gap — it is an all-background sample.

**Deleting a car clears the flag.** [Issue #36](https://github.com/rails49/occupancy/issues/36) settles the question [Undo and redo](#undo-and-redo) left open, and settles it on the asymmetry of what a wrong answer costs rather than on what the user probably meant. A delete removes coverage, and nothing in the manifest can distinguish a label deleted because it covered nothing from a label deleted off a car that is still in the photograph — they are the same edit. If the flag survives the second case, the image is exported and teaches the detector that cars are background, which is the exact failure the flag exists to prevent and the one nothing downstream detects. If the flag is cleared in the first case, the cost is one click, paid in front of a thumbnail bar that shows which images carry it.

This does not weaken **nothing else may ever set it** — that rule has a direction. *Setting* is the claim only a human can make, and no default, conversion, or accept-all may make it on their behalf. *Clearing* withdraws the claim and asks for it again, which is the same discipline read the other way round.

The scope is deletion and nothing else. Adding a car only increases coverage. Dragging an end moves a label rather than removing one, under the live width rectangle that is the feedback for whether it still covers its car. Reclassifying changes what a car is called, not whether it is covered. Clearing also costs the history nothing: a car delete already targets that image's record and `labeled_complete` lives in the same snapshot, so one entry carries both and one undo restores both — which is equally true had the decision gone the other way.

The flag is authored by **one deliberate control per image** and read across the whole set at a glance: the editor carries a labeled-complete control for the image on screen, and the thumbnail bar marks every image that carries the flag, because scanning a set for what is left to do is the actual workflow and it must not require selecting each image in turn. Toggling it is one history entry targeting that image.

### Labeling Workflow

The editor guides a specific order, because the order is what keeps a training set honest:

1. **Calibrate** — two points minimum.
2. **Label all cars** — per image.

Sensors can be placed at any time.

> The workflow was three stages until [issue #13](https://github.com/rails49/occupancy/issues/13) removed track from v4. Stage 2 was *label all track*, and it is gone along with the snap that depended on it.

**Stages are gated on existence, never on completion.** Calibration gates car labeling, because car width is derived from DPT and the width rectangle is the only feedback that a label actually covers what it claims. Every stage stays re-enterable, and nothing can verify that *all* cars have been labeled, so nothing pretends to — the flow is encouraged by ordering, and the one honest claim of exhaustiveness is the human's, recorded as `labeled_complete`.

A **car-free image** is no longer a required convention. It was worth having on three grounds — track was authored on it, it was the cleanest source of empty-track CNN crops, and it is a valid complete image with zero cars. The first is gone with track and the second is dormant, so only the third survives: a car-free image makes a useful all-background sample, and nothing more is claimed for it.

#### Authoring cars, and the trains they form

A car is **two free clicks on the visible car ends** — the straight chord between them, along the car's own centerline. There is no snapping, because there is no stored track to snap to.

A train is authored as a **chain of clicks**: the first click starts a car, and every click after it is simultaneously the end of the current car and the start of the next. **Right-click ends the chain**, and the next click starts a new train. Nothing about the train is stored — it stays derived from coincident endpoints. Chaining simply guarantees that the coincidence is exact.

Because a coupling is where two endpoints coincide, it renders as **one shared handle**: dragging it moves both cars' endpoints together, so a train survives editing. Deleting a single car remains possible as an error-correction path — deleting the middle car of three leaves two derived trains, with no residue.

Dragging edits everything: car endpoints, coupler joints, calibration points, and sensors.

#### Right-click is state-dependent

| State | Right-click |
| :-- | :-- |
| Chaining a train | Ends the chain |
| Idle | Context menu on the object under the cursor |

The context menu carries **delete** and **reclassify**, and it is the reason the editor needs no delete mode at all. It is also where a dotted class taxonomy belongs: `stock › loco › steam` nests as a submenu rather than requiring a persistent picker. A newly created car is `stock`; refinement happens through the menu.

One gesture meaning two things depending on state is a real cost, accepted here because the two states differ by whether a chain is in progress — which is already loudly visible as a rubber band.

#### No copy-forward

Labels are not carried between images. Copying cars across a set where nothing moves was considered and rejected: hand-labeling every image is what keeps provenance and the completeness flag unambiguous.

#### Undo and redo

Settled in [issue #25](https://github.com/rails49/occupancy/issues/25).

**The editor has an undo history, and it is a prerequisite of the editor spec rather than a polish item layered on afterwards.** The corpus is 46 images awaiting hand-relabeling, [No copy-forward](#no-copy-forward) refuses to amortize that, and the editor's gestures are destructive by design — a context-menu delete, a coupler drag that moves two cars, right-click meaning *end chain* one state away from meaning *delete*. Worse, the costly mis-click is silent: dragging a coupling moves a second car that may be off-screen, so "save often" cannot recover what the user never noticed. Retrofitting a history onto in-place mutation is the expensive version, which is the same argument [Provenance](#provenance-is-required-not-optional) makes for provisioning early.

**One linear stack per opened archive, spanning images.** Per-image stacks leave the layout-scoped edits — sensors, calibration, `layout.scale` — with no stack to belong to, and split "the last thing I did" into two candidates. The stack carries one invariant: **undo must make its own effect visible.** An entry targeting another image selects that image *first*, then applies, then highlights what changed. Undo may move the user; it may never change something they cannot see. That matters most for `labeled_complete`, which an off-screen undo could otherwise leave asserting completeness over an image a car just vanished from.

**What is in the history is exactly what mutates the manifest** — car edits, sensors, calibration, `labeled_complete`, layout metadata, `layout.scale`, and image add/remove/reorder. View state — selection, zoom, view mode, an uncommitted chain — is not. Deleting an image **retains its bytes** rather than being excluded as too expensive: a history with holes is worse than no history, because the binding teaches the user to trust it, and a Cmd+Z that skips the accidental deletion and reverses the label before it is a wrong action presented as the right one.

**One entry is one gesture.** A drag is captured at pointer-down and committed at pointer-up, never per motion; a coupler drag is one entry covering both cars; a drag returned to its origin records nothing. Text fields commit on blur, not per keystroke. No-ops are suppressed by value comparison. A chained train records **one entry per car**, not one for the train: a mis-click on the last coupler of a twelve-car consist must not cost the consist, and nothing about a train is stored anyway — it stays derived from coincident endpoints, so undo does not invent an aggregate the format refuses to have.

**Undo is state-dependent, exactly as right-click is.** While a chain is live it is intercepted by the chain: remove the last car, move the anchor back. At a chain's start — anchor placed, no car yet — it clears the anchor and drops to idle. **A live chain is a wall undo cannot cross**, so the reflexive "wrong place, undo" at the start of a train can never reach back and delete the last car of the previous one. The next press proceeds into real history normally. This is the cost [Right-click is state-dependent](#right-click-is-state-dependent) already accepted, carried by the same rubber-band signal.

**Entries are scoped snapshots, not inverse commands** — `before` and `after` clones of the one subtree touched, so undo and redo are a single operation with the fields swapped. There is no per-command inverse to author and therefore none to author wrongly, which matters because a wrong inverse does not throw: it writes a subtly wrong manifest discovered a training run later. The corollary is a constraint on the editor: **key on label `id`, never on object identity**, since applying a snapshot replaces objects wholesale. Retention is bounded by a **byte budget rather than an entry count**, because entries range from a kilobyte to a whole JPEG; eviction truncates the oldest end and never removes a middle entry. In a labeling session with no image deletions the budget is effectively unbounded, so undo reaches back to the state the archive was opened in. Redo is **linear**: a new edit discards the abandoned branch. An undo tree was rejected — retained history nobody can browse is memory spent on nothing.

**The history is not persisted.** It does not survive a reload and **is never written into the `.r49`** — a history inside the format would be a second source of truth about labels, in a format that declines to retain even the original of a `corrected` proposal. New and Open replace the archive and take the stack with them; Save records a marker instead of clearing, since bytes already on disk are unaffected by anything undone afterwards. That marker yields a **dirty flag**, and with it a gate on all three acts undo structurally cannot cover: a confirm before New and Open, and a `beforeunload` guard on **closing or reloading the tab** ([issue #49](https://github.com/rails49/occupancy/issues/49)). The third is settled on the same cost asymmetry as [Labeling completeness](#labeling-completeness), because its dialog is the browser's generic "Leave site?" and cannot be worded: the guard costs one extra click on a deliberate close, paid by someone who knows what they meant, while its absence costs an entire hand-labeling session — nothing is autosaved, the history does not survive the reload that would discard it, and [No copy-forward](#no-copy-forward) refuses to amortize the corpus. An unwordable dialog is a real defect, but only in something seen at the moment work is about to be lost. Close and reload are indistinguishable to that guard; both were wanted.

One adjacent question remains open: whether an accept-all of model proposals is one entry or many rides with [the proposal interaction](#in-scope-still-unresolved). The other — whether deleting a car should clear `labeled_complete` — was decided in the editor spec and is recorded with its reasoning under [Labeling completeness](#labeling-completeness): it clears.

### Assisted Labeling

Hand-labeling every car in every image is the dominant cost of building a training set. Once a detector exists, the UI should **propose** car labels, which the user then edits, corrects, or rejects. The human remains the author; the model supplies a first draft.

**One model, not two.** An earlier draft anticipated a second, separate model for authoring, because a proposal model would also need to detect **track** in order to suggest the spline layout. Track is no longer stored ([issue #13](https://github.com/rails49/occupancy/issues/13)), so that reason is gone: the authoring aid is the production detector itself, same class set and same weights. **Bootstrapping dissolves with it** — the circularity was that a track-proposing model needs track labels to train on, which is what it was meant to produce. Nothing about proposing cars is circular: hand-label enough images, train, then propose.

The provenance and completeness rules below are what keep the aid from quietly degrading the corpus, and they hold regardless of which model does the proposing.

#### Provenance is required, not optional

Accepted proposals that later become training data create a feedback loop: the model trains on its own output and amplifies its own errors, including systematic ones a user is unlikely to catch — a plausible proposal is easy to accept without scrutiny.

Each **car** label therefore records how it came to exist, plus which model proposed it:

| Field | Value |
|---|---|
| `provenance` | `human` — drawn by hand |
| | `proposed` — model-proposed, accepted without modification |
| | `corrected` — model-proposed, then edited by the user |
| `proposed_by` | the proposing model's version string (`v1.0.0`-style); **absent** when `provenance` is `human` |

This makes the difference measurable: unedited proposals can be excluded or down-weighted when building a training set, and acceptance rate becomes a quality signal. **Provenance cannot be retrofitted** once a corpus is labeled, which is why it is provisioned before the feature that needs it exists.

Three details that were decided against, and why:

* **`corrected` records no magnitude**, and the original proposal is not retained. Correction data would be **censored**: residuals exist only where the user chose to edit, `proposed` labels have zero residual by construction, and errors nobody noticed leave no residual at all. It would measure "how far the user moved what they moved" while looking exactly like model error. Model error belongs to a held-out evaluation — see [Accuracy](#accuracy).
* **`proposed_by` is per-label, not per-image.** Re-proposing an image with a newer model leaves the previous run's `corrected` labels in place, so an image-scoped field would be false about some of its own labels — and retraining is precisely the workflow that creates that case.
* **`corrected` stays distinct from `human`.** A corrected label was *anchored* by a proposal, and anchoring bias is real: a user who nudges is not a user who drew.

#### Provenance cannot cover the error that matters most

Provenance is **per-label**, so there is one thing it structurally cannot express: a car that was **never labeled at all**. A proposal model that misses a car yields an image where every present label is impeccable and a car is silently taught as background — the exact poisoning [Labeling completeness](#labeling-completeness) exists to prevent.

That risk lives in `labeled_complete` and nowhere else, because completeness is an assertion about *absence*. It is also **not computable** from provenance: an image whose labels are all `proposed` is byte-identical whether the user inspected every one and agreed, or clicked accept-all blind. This is why accepting proposals must never set the flag.

### Testing and Demo

Beyond scaling and labeling layouts, the UI also interacts with the classifier:

1. Run the classifier on a still image or video stream from the camera. Testing and demo only; throughput is not critical.
2. Highlight classification errors and high-loss samples (training or test set) for diagnosis.
3. Real-time classification, e.g. on a mobile device, uploading results via MQTT to a model railroad controller such as [Rocrail](https://www.rocrail.online/). **Measured and viable** — see the runtime contract below.

#### Live-view runtime contract

Measured in [issue #11](https://github.com/rails49/occupancy/issues/11) against the static-INT8 `.ort` under ORT-web 1.26.0 (WASM EP); rig on branch `prototype/yolo-bench` (`ui/bench/`). Median steady-state `session.run()`, 20 timed passes after 3 warmups:

| Device | Threads | 960×544 | 640×384 |
| :--- | ---: | ---: | ---: |
| iPhone (iOS 26.5.2, Safari) | 4 | **120.1 ms** | 86.0 ms |
| iPhone | 1 | 191.3 ms | 103.8 ms |
| iPad (iOS 26.5.2, Chrome) | 8 | 444.9 ms | 277.9 ms |
| MacBook i7-7820HQ (Chrome) | 1 | 297.7 ms | 138.5 ms |

Four things an implementer must take from this:

* **The phone is the fastest device measured, not the weakest.** It beats the 2017 laptop by 2.5×. Mobile was the suspected risk and is not one.
* **"The phone" is not one number — plan against ~450 ms.** The spread across two current iOS devices is **3.7×**. The iPad was slowest despite reporting 8 cores, plausibly thread oversubscription on big.LITTLE.
* **Create the ORT session once at view mount, never per frame, and tolerate a slow start.** Time to first result is 1.0–4.5 s; session creation alone ranged from **32 ms to 3637 ms** across runs. The 3.4 MB model fetch is minor at 22–574 ms. The loading state must survive several seconds.
* **Threading is worth ~1.2–1.6×, not the 2–3× once claimed.** That figure came from *native* ORT CPU threading, which scales better than WASM. It requires cross-origin isolation, which `ui/public/_headers` now grants the app's whole origin ([issue #15](https://github.com/rails49/occupancy/issues/15)); iOS supports the path (`crossOriginIsolated` and `SharedArrayBuffer` both confirmed on iPhone and iPad), which is what made the fix worth taking on mobile rather than desktop only. **The isolation is a standing constraint, not a one-time fix:** `require-corp` rejects every cross-origin subresource the app loads, so a CDN added later takes the threading back out silently — nothing fails loudly, ORT just drops to one thread. Anything the app fetches has to come from origin, which is why the ORT runtime does.

The remaining lever is **change-detection frame gating** ([below](#secondary-uses-of-change-detection)). **ROI or tiled inference is not one:** tiling into N regions costs the same convolution work plus N× fixed overhead, and cropping to the model's fixed input merely upsamples the region for no saving — that is SAHI, an accuracy technique for low-DPT imagery that multiplies latency by tile count. Cropping only saves time by genuinely discarding layout.

> These figures measure `session.run()` alone — no camera capture, no pre- or post-processing. Input was random; the NMS-free head emits a constant 300 slots regardless of content, so latency is content-independent. Quote medians, not p95: spread is dominated by scheduler and thermal noise on every device.

### Secondary uses of change detection

Rejecting change detection as an occupancy classifier does not reject the technique. Its liabilities are all consequences of having to answer "is a train here?" — a question it cannot latch onto correctly. For jobs where the wrong answer costs a warning or a wasted frame rather than a collision, it is cheap and appropriate. Three such uses, in descending order of value:

1. **Camera-drift detection. ✓ Built** ([map #89](https://github.com/rails49/occupancy/issues/89)). Compare the structural content of the current frame against the archive's own images and *refuse to classify* when they disagree. This is occupancy-agnostic, so it has no latch problem, and it converts [Image Alignment](#image-alignment)'s formerly silent failure into a loud one. It was the strongest use and it is the one that landed — as block-wise phase correlation rather than frame differencing, because whitening the cross-power spectrum discards magnitude, which is where illumination lives: the two pixel-differencing baselines this rejection predicted would struggle top out at AUC 0.915 on `tools/drift-bench`, and the structural check reaches 1.000 with every legitimate case scoring exactly zero.

2. **Re-classification gating.** In live view, skip inference on frames where nothing changed. Purely a compute optimisation — a false negative costs a stale frame, never a wrong occupancy report. Relevant to [Testing and Demo](#testing-and-demo) item 3, where mobile hardware is the constraint.

3. **Change proposes, CNN disposes.** Use change detection to nominate candidate regions and the CNN to decide each one. This is sound, and is the architecture the background-subtraction literature converged on — but it is **Option 2 or 3 with a cheap front end, not Option 1**: it still requires the CNN, and it does not lift the DPT > 20 requirement, because the CNN is still what decides.

Item 1 is done. Item 2 is not scheduled work and should be raised as its own request against the live view; it may reuse item 1's primitive, but "has the frame changed at all" and "has the camera moved" are different questions and the second does not answer the first. Item 3 is a possible future optimisation of Options 2/3 and is not specified here.

> **Licensing, should EX-SensorCAM code ever be reused.** EX-SensorCAM is **GPL-3.0**, not AGPL-3.0. GPLv3 §13 explicitly permits combination with an AGPLv3 work, so incorporating it into rails49 is permitted — but it is a distinct licence and must be recorded as one.

### Description

The `.r49` file carries additional information — layout title, owner, camera model (automatically detected?), scale. The UI provides means to view and edit it.

## Format

The `.r49` manifest is versioned. The current shipped version is 3; the model described above requires **version 4**, a breaking change: point markers are replaced by the two geometries above, and no automated migration is possible — a point carries neither extent nor orientation. Settled in [issue #8](https://github.com/rails49/occupancy/issues/8).

### The v4 manifest

```jsonc
{
  "version": 4,
  "id": "<snowflake>",                                      // optional — see below
  "layout": {
    "name": "…", "description": "…", "contact": "…",      // all optional
    "scale": "HO",
    "calibration": { "points": [ { "px":    { "x": 0, "y": 0 },
                                   "world": { "x": 0, "y": 0, "z": 0 } } ],    // mm
                     "camera_height_mm": 1050,        // optional — target, not yet built
                     "reference_height_mm": 85 },     // optional, defaults to 0
    "sensors": [ { "id": "<snowflake>", "x": 0, "y": 0, "name": "…" } ]        // name optional
  },
  "camera": { "resolution": { "width": 0, "height": 0 }, "model": "…" },
  "images": [
    {
      "filename": "…",
      "labeled_complete": false,
      "labels": [
        { "id": "<snowflake>", "class": "stock",
          "p0": { "x": 0, "y": 0 }, "p1": { "x": 0, "y": 0 },
          "provenance": "human" },
        { "id": "<snowflake>", "class": "stock.loco.steam",
          "p0": { "x": 0, "y": 0 }, "p1": { "x": 0, "y": 0 },
          "provenance": "corrected", "proposed_by": "v1.0.0" }
      ]
    }
  ]
}
```

Encoding rules, each with its reason:

* **Collections are arrays of self-describing objects carrying `id`**, not records keyed by id. v3 keys the label dict by identity, so a marker is *anonymous* once it leaves its collection — but [Occupancy Output](#occupancy-output) makes `id` the thing consumers key on, and the training exporter, the provenance audit, and any "which label produced this crop" trace all pass single labels around. Uniqueness costs one validation per collection, which is the price of that. `id` is a `make_id` snowflake; sensor ids and label ids are separate namespaces and are never compared.
* **`provenance` is a discriminated union, with no default.** `proposed_by` is required on `proposed`/`corrected` and forbidden on `human`, enforced by the type rather than a runtime check. A default of `human` is specifically rejected: a forgotten field would launder model output as human authorship, which is the exact feedback loop [Provenance](#provenance-is-required-not-optional) exists to make measurable. `proposed_by` is a free-form non-empty string — no semver pattern, since it identifies a model and a future detector may be versioned differently.
* **`class` is a plain string at the format layer**, *not* validated against the vocabulary at parse time. Conformance is a visible warning in the editor and a **fatal error in the training exporter**, which is where a mis-mapped class silently corrupts a model. A format that refuses to open files because someone pruned the vocabulary would punish vocabulary edits.
* **`calibration` is always present, with `points` defaulting to `[]`.** "Uncalibrated" is a real state the editor handles, and an empty list expresses it without every consumer null-checking the parent. `getDPT()` returns `null` when no equal-`z` pair exists, covering the empty and single-point cases with one rule.
* **`camera_height_mm` and `reference_height_mm` are `.optional()`, and both are targets** — see [Camera height](#camera-height-is-what-corrects-the-third-dimension). They are the *only* two fields the non-planarity work adds: nothing about the camera model, the nadir pixel, or focal length is stored, because none of it is used. **Neither takes a zod `.default()`**, which would have the parser populate it and so inject the key on the *first save of any archive*, including one the user only opened to look at — damage done at save time and invisible afterwards, which is exactly what the strictness rule below exists to prevent. Absent means absent: the fit falls back to the reference plane, and `reference_height_mm` reads as 0 at the one place that consumes it.
* **They add no version.** Settled in [issue #139](https://github.com/rails49/occupancy/issues/139). The version number marks changes that make an old file **misread** or a new file **lose data**; an additive optional field is neither — an old archive loads unchanged, and a new archive is *refused* rather than misread, which is the loud failure strictness was written to produce. A bump would do the opposite of what it looks like: with `version` a literal and no compatibility shim by decision, v5 makes **every existing v4 archive fail to load**, sacrificing the backward compatibility [the frozen fixture](#migration-is-a-one-time-conversion-not-a-feature) exists to hold in order to reword a forward-compatibility refusal. Because a stale reader's raw `Unrecognized key(s)` message is useless to the model railroader who meets it, strict-key failures are reworded **once, at the archive-load boundary**, to say the archive may come from a newer build and the app should be reloaded.
* **`labeled_complete` defaults to `false`**, always. "A human asserts no car is unlabeled" is a claim no default and no conversion can make on a human's behalf.
* **Unknown keys are rejected, not stripped.** Every object in the schema is strict, so a manifest carrying a field this build does not know fails to parse instead of loading shorter than it arrived. Silently deleting what a newer build wrote is the same failure class as a defaulted `scale` or a defaulted `provenance`: the damage is done at *save* time, to someone else's file, and nothing in the pipeline looks wrong afterwards. The cost is that adding a field is a coordinated change — which is what a version number is for.
* **The archive-level `id` is identity, and it is optional here.** `R49Archive` mints one on write when it is absent and **never** overwrites one that exists, so a file lacks an `id` only until its first save. It is required by the [corpus repo](https://github.com/rails49/occupancy/issues/54), never by the editor or the detector — the format stays loadable for a hand-built manifest, and every archive written before the field existed keeps working. It is not derived from the file's name or path: an archive can be renamed or moved without becoming a different archive, which is precisely what a per-contributor corpus path forces. Whether a *fork* — someone else's archive, edited and resubmitted under the same `id` — needs archive-level provenance is deliberately unresolved; v4 models provenance for labels only.

### Migration is a one-time conversion, not a feature

**No v3 code exists in v4.** `ManifestDataSchema` is `version: 4` only, and loading anything else fails on the version number alone. The six archives this repo used to carry were converted **once** by a throwaway script, which then went away; they now live in [`rails49/r49`](https://github.com/rails49/r49)'s `fixtures/` tree (#63).

This is safe because all six are tracked binaries: the originals stay recoverable from git history indefinitely, so converting in place is not a one-way door. The conversion keeps images, `camera`, `layout.scale`/`name`/`description`/`contact`, and calibration (v3's `{p0, p1, size_mm}` becomes two points at `world (0,0,0)` and `(0, size_mm, 0)`). It drops all 1195 point markers and sets `labeled_complete: false` on all 46 images, leaving six valid v4 archives with zero labels, ready for hand-relabeling.

`camera.resolution` is retained because [Output encoding](#output-encoding) defines L0 coordinates in that frame.

### Parameters live in `config.yaml`

```yaml
layout:
  standard_width: 3000.0      # prototype mm — widest real stock (SBB RAm TEE I)
  min_dpt: 20                 # warns persistently, never blocks

detector:
  input: [960, 544]           # superseded — see below
  confidence_threshold: 0.25  # placeholder — needs held-out recall
  classes: ["stock"]          # YOLO class index order — append-only
```

The format's own constants are not this project's and do not live here ([ADR 0018](docs/adr/0018-the-r49-format-is-defined-in-rails49-r49.md), #181). They sit in `lib/r49/r49.json`, which `@occupancy/r49` reads and the config generator takes them from:

```json
{
  "standard_gauge": 1435.0,
  "scale_to_ratio": { "G": 25, "O": 48, "S": 64, "HO": 87, "T": 120, "N": 160, "Z": 220 },
  "vocabulary": {
    "stock": {
      "loco": { "steam": {}, "diesel": {}, "electric": {} },
      "passenger": {},
      "freight": {}
    }
  }
}
```

`vocabulary` is the authoring taxonomy — what the context menu offers and what a label's `class` must match. A nested mapping is a subtype; anything else (`width_mm`) is a property of the class above it. `classes` **is** the YOLO class list, verbatim and index-ordered, and every entry must name a class in the vocabulary — the generator fails, naming the class, when one does not. A label maps to the longest entry of `classes` that is a segment-prefix of its class, so `stock` matches `stock.loco.steam` but never `stockyard`; the same rule resolves an overriding `width_mm`. Adding a subtype to `classes` therefore re-maps every already-labeled car of that subtype with **no relabeling**.

> ⚠️ **`classes` is append-only.** A list position *is* a YOLO class index, so reordering or deleting an entry invalidates trained weights while the file still validates. It is the one config edit that can break a model with nothing noticing.

**`detector.input` is superseded** by [issue #130](https://github.com/rails49/occupancy/issues/130) and shown above only because it is what the code still reads. It becomes a **single square canvas side** plus the target DPT — an authored `[w, h]` pair is the wrong *shape* of parameter once image size falls out of layout extent × DPT rather than being chosen. See [Input geometry](#input-geometry-is-dpt-normalized) for why square, why authored rather than derived, and what bounds its value.

The `stock.` root is required rather than cosmetic: a new car is `stock` and refinements must roll up to it, so an unrooted class would match no entry and be dropped from the export — the unlabeled-car-as-background failure [Labeling completeness](#labeling-completeness) exists to prevent. The root never appears in the UI; the context menu renders its children.

**`config.yaml` is authored; every other representation is generated and verified.** Exports assert against it and abort on mismatch, and nothing writes a vocabulary back — which is why `classifier.labels` was deleted rather than corrected, being a key nothing could check. TypeScript reaches these values through a **generated, committed** `lib/config` package emitted by `pnpm config:generate`, with a staleness check in `bin/test.sh`; `lib/r49` derives `STANDARD_GAUGE`, `Scale2Number`, and its scale enum from it instead of hardcoding all three. Python keeps reading `config.yaml` directly.

The detector runs entirely in the browser via ONNX Runtime; the application is fully client-side with no backend.

## Deriving Training Data

Settled in [issue #4](https://github.com/rails49/occupancy/issues/4); full working in `docs/research/issue-4-label-derivation.md` on branch `research/label-derivation`.

**Endpoint labels are the single source of truth.** Every model input is *derived* from them by deterministic rule — nothing is hand-authored twice, and no second annotation format is maintained by hand. A relabel therefore regenerates every downstream artifact.

### YOLO annotations, for the detector

* **Only `labeled_complete` images are exported.** This is the one hard gate. An image containing an unlabeled car teaches the detector that cars are background, and the loss is shared across the whole image so it cannot be scoped per class. Ultralytics states the same requirement directly — *"All instances of all classes in all images must be labeled. Partial labeling will not work."* — and two peer-reviewed studies of sparse-annotation degradation agree.
* **Class index** is the position in `detector.classes` of the longest entry that is a segment-prefix of the label's `class`, as described under [Parameters](#parameters-live-in-configyaml). A label matching no entry is a **fatal export error**, never a silent drop — a dropped car is exactly the unlabeled-car-as-background failure above.
* **Geometry** is the oriented box: centre and orientation from the `p0`–`p1` chord, length from its magnitude, width from `DPT × standard_width / standard_gauge`. Normalisation into the detector's input frame is generated, not stored.
* **Images are resampled to the target DPT, then padded — never resized — onto the canvas.** The padding is not a formatting choice: Ultralytics' loader rescales every image's long side to `imgsz` before any letterbox or augmentation, in training and validation alike, so a corpus normalized only at capture time is **silently un-normalized by the dataloader**. Padding to exactly the canvas side makes that rescale a no-op, which is the whole mechanism by which [DPT normalization](#input-geometry-is-dpt-normalized) survives to the model.
* **A capture larger than the canvas is tiled**, with overlap exceeding the longest car. **A car cut by a tile boundary is clipped and labeled, not dropped.** Dropping it would teach *partial car is not a car* — self-consistent under tiling, since the car is whole in some other tile, but it would blind the model to a car half-outside the **camera's** frame, which is a real and permanent case no overlap rule can fix.

### CNN crops, for the classifier

Retained because the ResNet stays retrainable, though nothing loads it today.

* **Fixed stride along the span**, in canonical 20-DPT pixels, endpoint-inclusive and deterministic: `s = crop_size / 2 = 48`.
* **Crops stay axis-aligned** regardless of span orientation. At inference the classifier only ever receives a query point — a `layout.sensors` entry — never an orientation, so a rotated training crop would not match what it is asked at runtime.
* **Crop labels come from every span intersecting the crop**, not from the span that generated it. This proviso is load-bearing rather than an aside: it is the mechanism by which no occlusion rule is needed anywhere in the format.
* Projects **~2718 crops** against 959 today.

### v4 cannot produce a trainable CNN dataset, and that is known

Established in [issue #8](https://github.com/rails49/occupancy/issues/8). v4 stores **only car spans**, so every derivable crop centre lies on a car and every crop earns the same tag. The vocabulary does not shrink from three tags to two — it collapses to **one, degenerate, with no negatives at all**. This is why `classifier.labels` was deleted from `config.yaml` rather than corrected.

The route back is **sampling background crops as verified negatives**: `labeled_complete` asserts no car is unlabeled, which makes any crop centre not intersecting a span a *verified* negative rather than a presumed one. That changes the negative distribution and therefore invalidates any gate built on the old one, so it is an experiment to run rather than a schema question to answer — and it stays dormant while the ResNet does. Until it happens, the CNN derivation above is a specification with no corpus to run on.

## Out of Scope, and Known Gaps

Two different things, kept apart deliberately: the first list is **ruled out** and will not be built here; the second is **in scope but unresolved**, and an implementer will meet it.

### Ruled out

| | Why |
| :--- | :--- |
| **The autoalign transform** — homography estimation and re-alignment triggers | The calibration *data model* is specified; the algorithm is a separate effort. Points off the reference plane are stored but inert, which provisions it without implementing it. Drift **detection** has since split off and shipped ([map #89](https://github.com/rails49/occupancy/issues/89)) — see [Image Alignment](#image-alignment); *correction* is what stays ruled out. |
| **Track geometry, and the spline authoring it implies** | No live-path consumer, and **fully retrofittable** without invalidating a single car label. See [Track is not stored](#track-is-not-stored-and-that-is-a-deliberate-deferral) and the closed [issue #14](https://github.com/rails49/occupancy/issues/14). |
| **Populating car subtypes** — `stock.loco.steam` and friends | The mechanism is provisioned and additive by design; no subtype is labeled here. Adding one is a `config.yaml` line plus a retrain, with **zero relabeling**. |
| **Calibration provenance** — authoring-image references, per-point names, content fingerprints | The general case is camera drift, already [issue #12](https://github.com/rails49/occupancy/issues/12). Settled in [issue #6](https://github.com/rails49/occupancy/issues/6). |
| **Coupling as a class or a field** | Derivable from L0 as two box endpoints coinciding. A 96 px crop cannot see the relationship between two cars that defines a coupler, which is why hand-placed coupling markers never worked. |
| **A second model in the live path** | One detector, one ORT session, one vocabulary. The CNN stays retrainable and unloaded. |
| **Warping images to correct perspective** | Ruled out in [issue #136](https://github.com/rails49/occupancy/issues/136). A warp to the z=0 plane straightens layout zero and leaves everything at track height displaced by exactly the relief term — the true-orthophoto/DSM distinction — so it misses the objects being detected. It also bakes irreversible per-layout geometry into shared pixels, splits the corpus into warped and unwarped provenance, and contradicts [Input geometry](#input-geometry-is-dpt-normalized), which bought its simplicity by settling that authoring stays in full-frame pixels. A contributor who warps their **own** photos before submitting produces a self-consistent archive indistinguishable from one shot with different optics: the system neither performs nor detects warping, and needs no check for it. |
| **Position (relief) correction** | Specified and deliberately not built — see [Camera height](#camera-height-is-what-corrects-the-third-dimension). Nothing maps image↔world positions, so it would be a correction with no caller. Returns as a fresh decision if such a consumer ever appears. |

### In scope, still unresolved

* **How any accuracy claim gets measured.** There is no held-out protocol for either model, and the [v4 conversion retires](#accuracy) the only automated gate there is. The detector's `confidence_threshold` cannot be set without held-out recall, so its config value is a placeholder. A real protocol waits on the fresh higher-DPT corpus.
* **An independent second observer.** [A total miss stays invisible](#confidence) to any single-model scheme. The candidates — a CNN verifier over the same points, or change detection — are neither specified nor worth building before the detector has numbers.
* **The proposal interaction.** [Assisted Labeling](#assisted-labeling) settles provenance and completeness but not the UX: whether proposing is per-image or per-archive, whether proposals hold a distinct *pending* visual state, whether an accept-all affordance should exist at all given that it must never set `labeled_complete`, and how a wrong proposal is rejected without residue. Fully retrofittable, and designing it against unknown accuracy is what the format's own restraint principle warns against.
* **L2: event and transition semantics.** Rocrail-style enter/in sensors fire on *transitions*; L1 is per-frame state. Converting one to the other needs debouncing and hysteresis, which is exactly where a phantom becomes a spurious "train entered block" a controller acts on. Deferred until a real controller is in the loop.
* **Block-span occupancy.** Retrofittable for free from L0, but a named interval on track presupposes track — so it would have to bring spline authoring back with it.
* **Whether the live view renders L0 boxes, L1 sensor states, or both by default.** Both are available, and [the output frame](#output-encoding) means boxes draw with no transform. A presentation choice, not an architectural one.
* **What obliquity costs accuracy, and whether it earns a threshold.** The geometry is quantified — an HO car presents 2.6× its nadir width at the corner of a 2×1 m layout under a 1 m camera — but its effect on detection is unmeasured, so no constant is set. Two consequences wait on that measurement: whether the capture advisory gains a bar, and whether `spanToPolygon`'s constant car width needs an obliquity term ([issue #138](https://github.com/rails49/occupancy/issues/138)), since a nadir-assumed box under-covers a corner car by up to 2.6× and *wrong labels* hurt training in a way distortion alone does not.

---

*Design decisions, open questions, and the research behind them are tracked on the wayfinder maps. The format and labeling decisions above came from [#2](https://github.com/rails49/occupancy/issues/2); the accuracy campaign and the input geometry are [#125](https://github.com/rails49/occupancy/issues/125), which is open.*
