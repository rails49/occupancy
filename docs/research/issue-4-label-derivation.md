# Deriving CNN crops and YOLO annotations from endpoint labels

Written 2026-07-28. Research notes for [issue #4](https://github.com/iot49/rails49/issues/4), under map
[#2](https://github.com/iot49/rails49/issues/2). Spec-only: nothing here changes project code
(map decision 1).

Every number attributed to "the corpus" was measured directly from the six `.r49` archives in
`dataset/r49/` by unzipping `manifest.json` and computing on the marker coordinates. Every
external claim is cited to the document that owns it.

---

## 0. Ground truth measured from the corpus

| Quantity | Value | How measured |
| :-- | :-- | :-- |
| Images / markers | 46 / 1195 | count over all six manifests |
| Marker types | `train` 531, `other` 232, `track` 244, `coupling` 152, `train-end` 36 | count |
| Scale | HO (1:87) in all six archives | `layout.scale` |
| DPT per archive | 19.08 (three `cars*`), 18.53 (`catalog-bg`), 17.96 (`lighting`, `simple`) | `getDPT()` in `lib/r49/src/manifest.schema.ts` |
| `scaleFactor = DPT/20` | 0.898 – 0.954 | all ≥ 1/1.2, so `data_prep.ts` skips no archive |
| Car length | **8.45 track gauges = 169 px @ 20 DPT** (12.1 m prototype, a 40 ft car) | median of 93 consecutive coupler-to-coupler gaps |
| Human labeling stride, `train` | median nearest-neighbour 3.01 gauges ≈ **60 px @ 20 DPT** | NN distance, 531 markers |
| Human labeling stride, `track` | median nearest-neighbour 3.44 gauges ≈ **69 px @ 20 DPT** | NN distance, 244 markers |
| Track orientation | median \|angle\| **32°**; 40 % of local track direction beyond 45° | NN direction vectors, 182 samples |
| Stock orientation | median \|angle\| **4°**; 75 % within 15° of horizontal | NN direction vectors, 468 samples |
| Full track extent per scene | 182 g (`cars 0-10`), 110 g (`cars 17-30`), 134 g (`catalog-bg`), 97 g (`lighting`), 76 g (`simple`) | MST length over track markers of the most completely labeled image |

Per-class constant widths at 20 DPT, from decision 6 (stock 2.8 m prototype, track = gauge):

* **stock**: 2800 mm / 1435 mm = 1.951 gauges → **39 px @ 20 DPT**
* **track**: 1.000 gauges → **20 px @ 20 DPT** (DPT *is* pixels-per-gauge, by definition of `getDPT`)

A 96 px crop at 20 DPT therefore spans **4.8 track gauges ≈ 6.9 m prototype ≈ 0.57 car lengths**.
The crop is *narrower than a car*. That single fact drives most of what follows.

### Two corrections to the repo's own documentation

1. **`CLAUDE.md` says "136×136 crops"; the pipeline cuts 144×144.** `config.yaml` has
   `crop_size_prep: 144`, and `dataset/src/data_prep.ts:19` reads exactly that key. 136 is
   `96·√2` — the old value, sized for lossless rotation. Stale doc.

2. **The shipped model's label vocabulary is `["coupling", "track", "train"]`, not
   `config.yaml`'s `["coupling", "other", "track", "train"]`.** `TRAIN.ipynb` writes
   `"labels": list(dls.vocab)` into `models/config.json`, and `dls.vocab` is built from
   `data.csv`, which `data_prep.ts` fills using `INTERESTED_LABELS = {train, train coupling,
   track}` — `other` is dropped at line 127. Simulating `data_prep.ts` over the corpus confirms
   the vocab is exactly `{coupling: 150, track: 243, train: 716}`. `config.yaml`'s
   `classifier.labels` is dead text that disagrees with what ships.

This also **explains the 963**. `lib/classifier/tests/regression.test.ts:71` keeps a marker only
if `labels.includes(trueLabel)`; with a 3-label vocabulary that admits `coupling` (152) +
`track` (244) + `train` (531) + `train-end`→`train` (36) = **963**, and rejects `other` (232).
1195 − 232 = 963. Note `data_prep` produces **959** crops from the same markers, because it
applies `dataset/exclude.json` (7 ids, 4 of which hit) and the regression test does not.

### The gate is not a held-out measurement

`regression.test.ts` iterates **every** marker in **every** archive. The 80 % that
`getIsValid()` assigned to training are in there. So "99.58 % against a 99.5 % gate" is a
**train-set-inclusive** figure: roughly 770 of the 963 samples were seen during fitting. It is a
*reproducibility* check (does this `.ort` file still behave like the one that was published?),
not a generalisation estimate. Read it that way in everything below.

---

## 1. CNN crop derivation

### 1.1 What must not change

`BaseClassifier.getScalingMath()` (`lib/classifier/src/base.ts:59`) is the inference contract:

```ts
const scaleFactor = img_dpt / this._config.dpt;
const srcSize = cropSize * scaleFactor;
const sx = point.x - srcSize / 2;
const sy = point.y - srcSize / 2;
```

At inference the classifier receives a **query point and nothing else** — no orientation, no
extent. `layout.detectors` (decision 9) are exactly such points. Three consequences bind the
derivation:

* **Crops stay axis-aligned in image space.** Do *not* rotate derived crops to align with the
  span. The model would then be trained on canonical-orientation patches and evaluated on
  arbitrary-orientation ones. Orientation invariance is supplied by augmentation
  (`aug_transforms(max_rotate=80.0, do_flip=True)` in `TRAIN.ipynb`), not by the crop cutter.
* **Crop size stays keyed to DPT alone, not to class width.** Per-class constant width
  (decision 6) affects the YOLO box, not the crop. `crop_size` is 96 for every class, because
  `getScalingMath` has no class to switch on.
* **Crops stay square and centred on the sample point.** Same reason.

So the derivation question reduces to exactly one thing: **where along the span do the centres
go?**

### 1.2 Recommended sampling: fixed stride, endpoint-inclusive, deterministic

For a span with endpoints `p0`, `p1` in image pixels and image resolution `D` DPT:

```
L_img = |p1 - p0|                       # image px
L     = L_img * (20 / D)                # canonical px, at the 20-DPT sample resolution
s     = 48                              # canonical px = crop_size / 2
n     = max(2, ceil(L / s) + 1)         # number of centres
c_i   = p0 + (p1 - p0) * i / (n - 1),   i = 0 .. n-1
```

Four properties, each load-bearing:

* **Fixed stride, not fixed count.** A 40 ft car and a 12-gauge track chord must produce
  proportional sample density, or long spans are under-represented and short ones are
  over-represented. Fixed count breaks that.
* **Stride expressed in canonical (20 DPT) pixels, then converted back through
  `20 / getDPT(manifest)`.** Otherwise archives at 17.96 DPT and 19.08 DPT get different
  physical sampling densities for the same object. This mirrors what `data_prep.ts` already
  does with `scaledCropSize = CROP_SIZE * scaleFactor`.
* **Both endpoints are always sampled** (`i = 0` and `i = n-1`). Endpoints are the informative
  places: a car's endpoint *is* the coupler / train-end, and a track span's endpoint is where
  track meets a car or leaves the frame. The 36 `train-end` markers in the corpus are the
  labeler independently discovering this. `n = max(2, ...)` guarantees it even for a
  degenerate span.
* **No jitter at derivation time.** Derivation is deterministic and reproducible; jitter is
  augmentation. The margin for it already exists — `crop_size_prep = 144` against
  `crop_size = 96` gives ±24 px of translation headroom.

  **Caveat worth knowing:** that headroom is currently *unused*. `TRAIN.ipynb` sets
  `item_tfms = CropPad(CROPPED_SIZE)`, and fastai's `CropPad` is a deterministic **centre**
  crop/pad, not a random one. `config.yaml`'s comment — "1.5 \* CROP_SIZE to support
  translation jitter" — describes an intent the recipe does not implement. If jitter is wanted,
  `RandomCrop(96)` for train / `CenterCrop(96)` for valid is the one-line change; it is out of
  scope for this ticket but should be recorded before anyone concludes that stride and jitter
  are redundant.

**Why `s = crop_size / 2 = 48 px.** Two independent arguments converge:

* *Empirical.* It is within a factor of 1.5 of what the human labeler actually did — 60 px for
  `train`, 69 px for `track`. Decision 3 makes derived crops the replacement for those markers,
  so reproducing their density is the conservative default. 48 is slightly denser, which is the
  safe direction.
* *Coverage.* Stride ≤ half the window is the standard overlap for sliding-window tiling; it
  guarantees every point of the span is within `crop_size/4` of some crop centre, so no part of
  a car is only ever seen at a crop edge. Under-window strides are routine practice in tiled
  detection and patch classification precisely for this edge-continuity reason
  ([SAHI, Akyon et al. 2022](https://arxiv.org/abs/2202.06934)).

`s` should be a new `config.yaml` key under `cnn:` (e.g. `sample_stride: 48`), not a literal —
it is exactly the kind of cross-stage parameter `config.yaml` exists to hold.

### 1.3 Crop labels must come from geometry, not from the generating span

A crop centred 20 px from the end of a track span sits half on track and half on a car. The
span that generated the centre says `track`; the pixels say both. **Derive each crop's label set
from every span whose swept rectangle intersects the crop's field of view**, not from the
generating span alone.

The machinery for this already exists and is already used: the model is
`MultiCategoryBlock` + `BCEWithLogitsLossFlat`, `get_y` is `r["labels"].split(" ")`,
`data_prep.ts` already emits the two-token string `"train coupling"`, and
`BaseClassifier.getLabelsFromResult()` returns *all* labels over 0.5. In today's data
`coupling` never appears alone — all 150 coupling crops are `train coupling`. Multi-label
crops are the existing convention, not a new one.

### 1.4 The `coupling` class is a spec gap, and it is 15.8 % of the gate

Decision 7's class set is `stock`, `stock.loco.steam`, `track`. **There is no `coupling`
class.** But `coupling` is one of the three labels the shipped CNN emits and accounts for
152 / 963 = **15.8 %** of the regression set. Either:

* **(a) Derive it.** A coupling is the junction of two abutting stock spans: an endpoint of span
  A within some tolerance (≈ 1 gauge = 20 canonical px) of an endpoint of span B, both of class
  `stock*`. The corpus supports this — the 93 measured coupler gaps are consecutive-coupler
  spacings along consists, i.e. couplers really are where car spans meet. This is derivation in
  exactly the spirit of decision 3 and needs no schema field. Roughly 0.75 couplers per car in a
  typical consist → ~225 derived coupling crops, up from 152.
* **(b) Drop it**, and accept that the CNN vocabulary changes from 3 labels to 2.

Choose explicitly. Option (b) silently invalidates the 99.58 % figure, because the model no
longer has the same output space. Recommend (a).

`other` (232 markers) is the mirror-image gap: it has no v4 class either, and `data_prep.ts`
already discards it. Decision 8's completeness flag makes something better available for the
first time — with every object in an image labeled, **any** crop centre not intersecting a span
is a verified negative, so true background crops can be sampled instead of hand-marked. That is
an opportunity, but it changes the negative distribution and therefore the gate; treat it as a
separate experiment, not as part of this derivation.

### 1.5 Projected crop counts

Span inventory for the 46 relabeled images:

* **Stock spans.** Estimated **250 – 450, central 300** (≈ 6.5 per image). Two routes: (i) the
  corpus's stock markers form 278 connected components at a 5-gauge link threshold; (ii) the
  visible track in a frame is 76 – 182 gauges = 9 – 21 car-lengths, and images show roughly a
  quarter to a half of it occupied. Both land near 300. Note that decision 8 makes relabeling
  *exhaustive*, so the derived count will exceed anything estimated from today's sparse
  markers.
* **Track spans.** Total track extent is 5562 gauges if every image is labeled to its scene's
  full extent (per-archive extent × image count — legitimate because the camera is fixed within
  an archive; verified below). Subtract the car footprint (300 × 8.45 g) → **≈ 3000 gauges of
  visible track**. A straight chord deviates ≤ 0.5 gauge from a curve of HO radius ~34 gauges
  only up to ~12 gauges of length, so track polylines break into ~12-gauge (240 canonical px)
  spans → **≈ 250 track spans**.

| stride `s` | % of crop | stock crops | track crops | **total** | vs. 963 today |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 32 px | 33 % | 1800 | 2024 | **3824** | ×4.0 |
| **48 px** | **50 %** | **1200** | **1518** | **2718** | **×2.8** |
| 64 px | 67 % | 900 | 1012 | 1912 | ×2.0 |
| 96 px | 100 % | 600 | 759 | 1359 | ×1.4 |

Plus ~225 derived `coupling` crops (§1.4), which overlap the stock crops rather than adding to
them.

**The composition shifts, not just the count.** Today: track 25 %, train 55 %, coupling 16 %.
At `s = 48`: track ~56 %, stock ~44 %. Track roughly **doubles its share**, because decision 8
forces exhaustive track labeling and today's track labeling is drastically incomplete —
`cars 0-10` has 32 track markers on image-0 and **zero** on ten of its eleven images; only 19
of 46 images have any track marker at all. This is the single largest distribution change in
the migration and it is a direct, intended consequence of decision 8.

### 1.6 Does the derived set hold the 99.5 % gate?

**It cannot be known without training. Anyone who says otherwise is guessing.** Four
independent things change at once:

1. **The evaluation set itself no longer exists.** `regression.test.ts` reads `marker.x`,
   `marker.y`, `marker.type` off v3 point markers. Decision 4 deletes those markers. The gate
   must be redefined — presumably over derived crop centres — and 99.58 % vs 99.5 % then
   compares two different measurements on two different populations. **The published number is
   not carried forward.** Re-baseline explicitly; do not let a redefined gate inherit an old
   threshold.
2. **Class balance shifts** (track 25 % → ~56 %).
3. **The vocabulary may change** (`coupling`, §1.4).
4. **Sample count grows ~2.8×**, mostly through overlapping crops off the same span.

There is also a **leakage hazard that will make the new number look better than it is.**
`getIsValid()` (`data_prep.ts:70`) hashes `archive:image:markerId`. Derived crops off one span
at `s = 48` share 50 % of their pixels; if the hash key becomes the *crop* id, sibling crops
straddle the train/val boundary and validation accuracy inflates. Overlapping-window sampling
producing exactly this dependence is a known failure — non-independence between train and test
folds is one of the eight leakage categories catalogued in
[Kapoor & Narayanan, *Leakage and the Reproducibility Crisis in ML-based Science*, Patterns
2023](https://arxiv.org/abs/2207.07048), which found leakage affecting 329 papers across 17
fields.

**Minimum fix:** hash on the **span id**, so every crop off one span lands on one side.
**Honest fix:** block at **archive** level. The camera is fixed within an archive (verified:
`lighting.r49` carries a track marker at (202, 591) in image-0 and (202, 592) in image-1; across
archives, track markers in later images sit a median 16 – 66 px from image-0's — the same order
as the labeling stride, i.e. the *same track curves resampled*, not different scenery). Crops
from image-3 of an archive are near-duplicates of crops from image-0 of that archive. With six
archives, archive-blocked CV is a natural 6-fold. Report both blocked and unblocked; only the
blocked number means anything.

#### The experiments, named

**Experiment 1 — pilot relabel, frozen weights.** Relabel **six images** (one per archive) in
v4. Run the *shipped, unmodified* `model_int8.ort` against crop centres derived at `s = 48`, and
against the v3 markers of the same six images. *Isolates the derivation from everything else:
same weights, same preprocessing, only the centre distribution changes.* Cost: six images of
labeling, zero GPU. **Decision rule:** if accuracy on derived centres falls more than ~1 point
below accuracy on the same images' v3 markers, the derivation has changed the task and the gate
must be re-baselined before the other 40 images are touched.

**Experiment 2 — full derivation and retrain.** Relabel all 46. Derive at `s = 48`. Retrain
`model` and `model_int8` with the unmodified `TRAIN.ipynb` recipe. Report **two** numbers:
(a) 6-fold archive-blocked held-out accuracy — the real one; (b) all-crops accuracy in the
legacy train-set-inclusive style — the one comparable in *kind* to 99.58 %. Pre-register the
new threshold from (a) before looking at (b).

**Experiment 3 — stride sweep.** With the relabeled set frozen, sweep `s ∈ {32, 48, 64, 96}`.
Select on the archive-blocked number, never the unblocked one. A ResNet-18 over ≤ 4 k 96 px
crops is minutes per run, so this is cheap and there is no reason to skip it.

**Standing risk to state plainly:** the int8 model has under one sample of headroom
(99.58 % vs 99.5 % is 4 errors vs 5 out of 963), and quantization is calibrated on the first
256 files of `dataset/data` (`TrackCalibrationDataReader`). Change the dataset and the
calibration set changes with it. Expect the int8/fp32 gap to move, and budget for the
possibility that it moves the wrong way.

---

## 2. YOLO annotation export

### 2.1 Format

Axis-aligned, one `.txt` per image alongside the image, one row per object
([Ultralytics detection dataset format](https://docs.ultralytics.com/datasets/detect/)):

> "The `*.txt` file should be formatted with one row per object in `class x_center y_center
> width height` format." … "Box coordinates must be in **normalized xywh** format (from 0 to
> 1)." … "divide `x_center` and `width` by image width, and `y_center` and `height` by image
> height." … "Class numbers should be zero-indexed (start with 0)."

Oriented, same layout ([Ultralytics OBB dataset format](https://docs.ultralytics.com/datasets/obb/)):

> `class_index x1 y1 x2 y2 x3 y3 x4 y4`, all coordinates "normalized between 0 and 1".

Internally Ultralytics converts the four corners to `xywhr`; per
[`ultralytics.utils.ops`](https://docs.ultralytics.com/reference/utils/ops/),
`xyxyxyxy2xywhr` returns "rotation values … in radians from `[-pi/4, 3pi/4)`" and
`regularize_rboxes` "regularize[s] rotated bounding boxes to range `[0, pi/2)`". The exporter
does not need to care — it writes corners — but a round-trip test should tolerate the
regularisation rather than assert on a specific angle.

### 2.2 Deriving the rectangle from `{p0, p1}` + per-class width

Given `w_class` in **model millimetres** (stock: 2800/87 mm; track: `getGauge(scale)`),
converted to image pixels through `pixelsPerMm = getDPT(manifest) / getGauge(scale)`:

```
d   = (p1 - p0) / |p1 - p0|            # unit along the span
n   = (-d.y, d.x)                      # unit normal
h   = w_class_px / 2
corners = [ p0 + h·n, p1 + h·n, p1 - h·n, p0 - h·n ]     # OBB, in order
```

**OBB output** — normalise each corner by image width/height and clamp to `[0, 1]`.

**AABB output** — `x_min = min(corner.x)`, etc., then

```
x_center = (x_min + x_max) / 2 / img_w      width  = (x_max - x_min) / img_w
y_center = (y_min + y_max) / 2 / img_h      height = (y_max - y_min) / img_h
```

Normalise against the **image's own pixel dimensions**, read from the decoded image, **not**
from `camera.resolution`. They agree at 1920×1080 across this corpus, but `camera.resolution` is
a manifest field about the capture device and nothing enforces that it matches the stored file.
`data_prep.ts` already takes this care, using `sharp` metadata rather than the manifest.

Zero-length spans (`p0 == p1`) must be rejected at export, not silently emitted — `d` is
undefined. A validation pass should also reject spans shorter than ~1 gauge as almost certainly
mis-clicks.

### 2.3 AABB is adequate for stock and bad for track — measured

Fill ratio = OBB area / AABB area, at the measured per-class widths and typical span lengths:

| angle from horizontal | stock (L=169, w=39) | track (L=240, w=20) |
| ---: | ---: | ---: |
| 0° | 1.00 | 1.00 |
| 15° | 0.47 | 0.25 |
| 30° | 0.34 | 0.16 |
| 45° | 0.30 | 0.14 |

And the measured orientation distribution:

* **stock**: median 4°, 75 % within 15° of horizontal → AABB is tolerable most of the time.
* **track**: median **32°**, 40 % beyond 45° → AABB boxes are **14 – 25 % filled**. A diagonal
  track AABB is three-quarters background and will routinely swallow a neighbouring parallel
  track.

**Recommendation to hand to [#3](https://github.com/iot49/rails49/issues/3): the track class
needs an OBB head.** The two-endpoint schema (decision 6) supports both, so this is #3's call —
but it should be made knowing that AABB track boxes in this corpus are mostly not track. This is
the concrete input #4 owes #3.

### 2.4 Class-index mapping from the dotted-string set

Decision 7 puts the valid class set in `config.yaml` and generates the YOLO class list from it.
Ultralytics wants a `names` map of zero-indexed int → string in `data.yaml`.

Rules, in order of importance:

1. **Sorted order, generated, never hand-maintained.** Emit `names` by sorting the
   `config.yaml` set lexicographically and enumerating. Deterministic, reproducible, and it
   makes "adding car types later is data, not a schema change" (decision 7) actually true.
2. **Index assignment is not stable under insertion**, and that is the sharp edge. Adding
   `stock.boxcar` shifts every index after it, silently invalidating every previously exported
   `.txt` file and every previously trained weight file. Therefore: **the generated `names` map
   must be written into the export directory next to the labels and treated as part of the
   dataset artifact**, and the exporter must refuse to append to a directory whose stored map
   differs from the current one. Do not rely on regenerating it at train time.
3. **Dotted strings are used verbatim as `names` values.** `stock.loco.steam` is a legal YAML
   string and a legal directory-free label name. No flattening, no substitution of `.` for `_` —
   the dotted string is the identity (decision 7) and rewriting it creates a second vocabulary
   to keep in sync.
4. **Decide leaf-only vs. hierarchical, and record it.** If both `stock` and `stock.loco.steam`
   are valid classes, a steam loco is an instance of both, and YOLO's flat class space has no
   way to say so. Two workable answers: (a) export leaf classes only and treat ancestors as
   query-time prefix matches over predicted labels; (b) export every level as its own class and
   emit one row per level for each object. **(a) is the right default** — it keeps one row per
   object and one class per row, and prefix matching on a dotted string is trivial. Whichever is
   chosen, the CNN and the detector must agree, which is exactly the open fog item "config.json
   generation when two models with different vocabularies must agree."
5. Under (a), today's corpus exports **two** classes: `stock` (index 0) and `track` (index 1) —
   no subtype data is labeled under this map (map "Out of scope").

### 2.5 Why `labeled_complete` gates the export

Decision 8 is not a nicety. In a detector, every anchor / grid cell / query not matched to a
ground-truth box receives a **negative** target, and that loss is computed over the whole image.
An unlabeled but visible object is therefore not "ignored" — it is **actively taught as
background**:

* "A majority of true objects/instances is unlabeled in the datasets, so these missing-labeled
  areas will be regarded as the background during training."
  — [Zhang et al., *Solving Missing-Annotation Object Detection with Background Recalibration
  Loss*, ICASSP 2020](https://arxiv.org/abs/2002.05274)
* "Training with sparse annotations is known to reduce the performance of object detectors."
  — [Rambhatla et al., *SparseDet: Improving Sparsely Annotated Object Detection with
  Pseudo-positive Mining*, ICCV 2023](https://arxiv.org/abs/2201.04620)
* And from the trainer this project would actually use:
  "**All instances of all classes in all images must be labeled. Partial labeling will not
  work.**" … "No objects should be missing a label."
  — [Ultralytics, *Tips for Best Training
  Results*](https://docs.ultralytics.com/yolov5/tutorials/tips_for_best_training_results/)

The literature's remedies — background recalibration loss, pseudo-positive mining — are
research-grade modifications to the loss. None of them is available in a stock training run, and
adopting one would be a far larger commitment than labeling exhaustively. Decision 8's framing
is correct on the mechanism too: **the loss is shared across classes, so completeness cannot be
scoped per class.** An image with complete stock and incomplete track still teaches "unlabeled
track = background", and that gradient flows through the same shared backbone the stock head
depends on.

The corpus shows exactly this failure already: `cars 0-10.r49` has 32 track markers on image-0
and **zero** on the other ten images; only **19 of 46** images carry any track marker. Exporting
today's corpus as-is would train a detector on 27 images asserting "there is no track here"
about scenes that are ~50 % track. Decision 8 is the fix, and the `labeled_complete` gate is the
enforcement point.

One nuance to keep: Ultralytics recommends "about 0-10 % background images to help reduce FPs."
A genuinely empty, `labeled_complete: true` image with an empty `.txt` is a *legitimate and
valuable* export — the distinction is between "complete and empty" (good) and "incomplete"
(poison). The exporter must therefore write an **empty** label file for a complete image with no
objects, not skip the image.

---

## 3. Track occlusion — does the derivation reintroduce it?

**Verdict: no. Decision 8 holds. No occlusion rule is required by either consumer.** One
adjacent hazard exists; it is a labeling rule, not an occlusion rule, and §1.3 already covers
it.

**YOLO — clean.** Track is per-image. A car sitting mid-run means the labeler draws two track
spans (before and after) instead of one. That is *labeling what is visible*, which needs no
rule, no visibility flag, no `occluded_by` reference, no z-order. Compare the layout-level
alternative the map discarded: a single layout-scoped track polyline would have had to be
clipped per image against every car's footprint, which requires knowing which car occludes which
segment — a genuine occlusion rule, plus per-image derived state on layout-level geometry. The
per-image decision deletes the problem rather than solving it. Overlap between a stock box and a
track box (a car overhangs its rails) is ordinary in detection and needs no arbitration.

**CNN — clean, with one condition.** The hazard: at a car/track boundary, the crop derived from
the track span's last centre and the crop derived from the car span's first centre are nearly
the same pixels. If each inherits only its generating span's class, the dataset contains two
near-identical images with contradictory single labels — concentrated exactly at the boundaries,
which is where the model most needs to be right.

This is **not** occlusion returning. Nothing about it requires knowing what is *behind* the car;
it is entirely about what is *in the crop*. The condition is §1.3: **a crop's label set is the
set of classes whose spans intersect its field of view.** The boundary crop becomes
`{track, stock}` and both derivations agree. The model is already multi-label
(`BCEWithLogitsLossFlat`, `MultiCategoryBlock`, `getLabelsFromResult` thresholding every logit
independently) and today's data already ships two-token labels (`"train coupling"`, 150 rows).
No new field, no new rule, no schema change — the geometry needed to compute the intersection is
`{p0, p1}` plus the per-class width, which decision 6 already stores.

**Where it *would* come back — three things to watch:**

1. **If anyone proposes deriving CNN crops from a layout-level track definition** "so track
   doesn't have to be relabeled per image." That immediately needs to know which segments are
   hidden. Reject it; it is decision 8 being reopened by the back door.
2. **If `labeled_complete` is ever interpreted per class.** "Stock is complete, track isn't"
   makes an image half-exportable, and half-exportable means the exporter needs a rule for what
   the missing half implies about the pixels — an occlusion rule in all but name. Decision 8
   already forecloses this ("this cannot be scoped per class"); keep that sentence in the spec.
3. **If background/negative crops are sampled (§1.4) from images without
   `labeled_complete: true`.** "Not covered by a span" only means "verified background" when
   completeness is asserted. Sampling negatives from an incomplete image manufactures exactly
   the missing-annotation-as-background error, this time in the classifier. Gate negative
   sampling on the same flag the YOLO exporter uses.

**One genuine loss to record:** because track is not drawn under cars, the detector never sees
track *behind* rolling stock, and so cannot be asked "is there track here, under that car?" That
is a real capability the layout-level design would have had. It appears to be fine — decision 9
puts `layout.detectors` at fixed layout-scoped query points, so "is this spot occupied?" is
answered by classifying at the detector point, and the answer at an occupied point is `stock`,
which is the desired answer anyway. Worth a sentence in the spec so it is a known trade, not a
surprise.

---

## 4. Findings that belong to other tickets

* **[#3 (YOLO feasibility)]** — track spans have median orientation 32° with 40 % beyond 45°,
  and AABB fill for track is 14 – 25 %. Recommend an OBB head, at least for track (§2.3).
* **[#8 (v4 schema / class list)]** — decision 7's class set has no `coupling`, but the shipped
  CNN emits it and it is 15.8 % of the regression set (§1.4). Also `config.yaml`'s
  `classifier.labels` disagrees with the vocabulary that actually ships (§0).
* **Data quality, unowned** — the three `cars *` archives carry **byte-identical calibration**
  (`p0 (191,134)`, `p1 (1903,152)`, `size_mm 1480`) but their track markers do not overlap at
  all (0 % within 12 px, disjoint bounding boxes). Either the camera moved and calibration was
  not re-measured, or calibration was copy-pasted between archives. Since DPT drives crop
  scaling for 30 of the 46 images, this should be checked before relabeling.
* **`CLAUDE.md`** — "136×136 crops" is stale; `crop_size_prep` is 144 (§0).

---

## Sources

Primary, first-party:

* [Ultralytics — Object Detection Datasets Overview](https://docs.ultralytics.com/datasets/detect/) — YOLO detect label format, normalisation, zero-indexed classes, `names` map
* [Ultralytics — OBB Dataset Formats](https://docs.ultralytics.com/datasets/obb/) — `class_index x1 y1 … x4 y4`, normalised corners
* [Ultralytics — `utils.ops` reference](https://docs.ultralytics.com/reference/utils/ops/) — `xyxyxyxy2xywhr` `[-π/4, 3π/4)`, `regularize_rboxes` `[0, π/2)`
* [Ultralytics — Tips for Best Training Results](https://docs.ultralytics.com/yolov5/tutorials/tips_for_best_training_results/) — "All instances of all classes in all images must be labeled. Partial labeling will not work."; 0–10 % background images

Peer-reviewed:

* [Zhang, Chen, Shen, Hao, Zhu, Savvides — *Solving Missing-Annotation Object Detection with Background Recalibration Loss*, ICASSP 2020](https://arxiv.org/abs/2002.05274)
* [Rambhatla, Suri et al. — *SparseDet: Improving Sparsely Annotated Object Detection with Pseudo-positive Mining*, ICCV 2023](https://arxiv.org/abs/2201.04620)
* [Kapoor & Narayanan — *Leakage and the Reproducibility Crisis in ML-based Science*, Patterns 2023](https://arxiv.org/abs/2207.07048)
* [Akyon, Altinuc, Temizel — *Slicing Aided Hyper Inference and Fine-tuning for Small Object Detection*, ICIP 2022](https://arxiv.org/abs/2202.06934)

In-repo (read directly):

* `dataset/src/data_prep.ts`, `dataset/exclude.json`, `dataset/r49/*.r49`
* `config.yaml`, `bin/generate_config.py`, `bin/test.sh`
* `lib/r49/src/manifest.schema.ts`, `lib/r49/src/index.ts`
* `lib/classifier/src/base.ts`, `lib/classifier/src/node.ts`, `lib/classifier/tests/regression.test.ts`
* `classifier/resnet/TRAIN.ipynb`
