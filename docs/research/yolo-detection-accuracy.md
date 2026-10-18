# YOLO detection accuracy for track occupancy

Written 2026-08-05. Research note on [issue #115](https://github.com/rails49/occupancy/issues/115): is sufficient detection
accuracy of railroad cars achievable with a detector to virtually avoid crashes — miss rate < 0.1%,
false positives < 1%, areas of 2×1 m or more, overhead camera, model trained on the layout it runs
on? **The current stack (YOLO26n-OBB, ONNX INT8, browser WASM) is treated as one option, not a
constraint** — the question is accuracy, and the note ranks model choices by accuracy alone (§3),
flagging where the max-accuracy answer conflicts with prior architecture decisions rather than
letting those decisions bound the answer.

*Researched 2026-08-05. Sources: Ultralytics official docs and GitHub, SAHI source at `obss/sahi@main`,
ONNX Runtime official docs, arXiv originals (SAHI, Scale Match, Seq-NMS, FGFA, RTMDet, LSKNet,
RT-DETR, Co-DETR, ACPDS), and this repo's own measurements (issues #3, #11, #107;
`detector/export_onnx.py`, `config.yaml`, `SPEC.md`). Performance (latency, training time) is out of
scope per the issue; it is mentioned only where an accuracy technique's cost is the reason it is
usually skipped.*

---

## Final determination: (b) — difficult but likely achievable, **with the error rates defined at the right layer**

Four findings carry the verdict:

1. **The task is not information-limited — the irreducible (Bayes) error is ~0.** A human labels
   the *current, sub-`min_dpt`* fixture images correctly without effort; the corpus ground truth is
   exactly such human labels, authored from these images (`SPEC.md` § Labeling Workflow) **[REPO]**.
   Overhead view, no occlusion between cars, controlled scene: the information needed for a perfect
   answer is fully present in every frame. The entire gap between today's behaviour and < 0.1% is
   therefore **model interpretation, not signal** — and every technique that closes model-vs-human
   gaps (capacity, ensembling, hard-example mining, temporal filtering) has the full distance
   available to it. Contrast the change-detection note
   (`docs/research/image-change-detection.md`), whose verdict was (c) because the failure was
   *structural*; no such wall exists here. **[INF]**
2. **The raw per-frame detector will still not be *demonstrated* at 99.9% recall, and nothing in
   the literature claims it.** Fixed-scene deep-learning systems on the closest published analog —
   per-space parking occupancy, same camera, trained on the deployment scene — report 98–99%
   accuracy, not 99.9%
   ([Amato et al.](https://www.sciencedirect.com/science/article/abs/pii/S095741741630598X),
   [ACPDS](https://arxiv.org/abs/2107.12207)). No primary source publishes a per-frame miss rate at
   the 10⁻³ level for any detector deployment; the benchmarks (mAP) do not even expose that
   operating point.
3. **The system does not consume raw per-frame output — it consumes L1 sensor state on a live
   stream, and that is where the budget closes.** Per-frame errors on video are of two kinds:
   *transient* (flicker on a moving car, a marginal score crossing the threshold) and *systematic*
   (a pose/lighting combination the model reliably misses). Temporal filtering — k-consecutive-frame
   hysteresis before a sensor may report `clear` — drives the transient kind down geometrically and
   is standard practice in video object detection
   ([Seq-NMS](https://arxiv.org/abs/1602.08465), [FGFA](https://arxiv.org/abs/1703.10025)).
   The systematic kind is what finding 1 says is fully closable in principle, and what
   scene-training plus a hard-example loop attacks in practice: on a fixed scene, a systematic miss
   is a specific, findable, fixable training gap rather than an open-world generalization problem.
4. **The requirement's own asymmetry is the tractable direction.** Missed cars < 0.1% with false
   positives < 1% is a 10:1 budget in favor of recall, and every knob — confidence threshold, L1
   width normalization, occupied-biased debounce — trades FP for recall. The repo already errs this
   way by design (`SPEC.md` § The vocabulary: "Errors are biased toward `occupied`, deliberately").

The Bayes-error finding **raises confidence in (b) but does not upgrade to (a)**: "easy" would mean
an off-the-shelf fine-tune hits the bar without a measurement campaign, and §1's arithmetic says the
demonstration alone is a ~3000-placement campaign, with an iteration loop behind it that today lacks
both its diagnostics (#87) and its held-out protocol (#4). Zero irreducible error makes the summit
reachable; it does not shorten the climb.

What (b) does **not** claim: that any per-frame number below 0.1% will ever be demonstrated, that
the achievable statistical rate constitutes a guarantee, or that the goal is reachable without the
held-out measurement protocol that does not yet exist. Per the project's own standing constraint,
the detector "does sometimes miss rolling stock and report phantom trains" and **nothing here may be
presented as a safety interlock** — the verdict is about a statistical error rate, not a guarantee,
and would be (b) even if the measured rate came in at 0.01%.

---

## Legend

| Tag | Meaning |
|---|---|
| **[DOC]** | Stated in official documentation (Ultralytics, ONNX Runtime, SAHI). Link given. |
| **[SRC]** | Read directly from source code. File cited. |
| **[LIT]** | Published paper — arXiv original or peer-reviewed venue. |
| **[REPO]** | Measured in or read from this repository (issues #3, #11, #107; `detector/export_onnx.py`). |
| **[INF]** | My inference or arithmetic. Not sourced — argued. |

---

## 1. The bar, made precise

"< 0.1% missed car" is meaningless until the unit is fixed. Three candidate units **[INF]**:

- **Per car per frame.** At ~5 fps (iPhone measured 120 ms/frame, issue #11 **[REPO]**), a 0.1%
  per-frame miss rate on a stationary car means a flicker to `clear` every ~3 minutes per car — and
  a *correlated* miss (the model simply does not see that car in that pose) means a **permanent**
  false clear. Per-frame is both too strict for transients and too weak for systematics.
- **Per sensor-state transition.** What a controller actually consumes (Rocrail's enter/in fire on
  transitions — `SPEC.md` § Occupancy Output). This is the right unit: "of every 1000 occasions a
  car covered a sensor, the system reported `clear` during fewer than 1".
- **Per demonstration.** To *show* < 0.1% with 95% confidence needs zero misses over ~3000
  independent car-placements (the "rule of three": zero failures in n trials bounds the rate at
  ~3/n — Hanley & Lippman-Hand, *JAMA* 249(13):1743, 1983 **[LIT]**). Video frames are not
  independent trials; distinct placements are. ~3000 placements is a large but not absurd labeling
  campaign for a fixed layout — it is the same order as the corpus SPEC already calls for.

The verdict assumes the transition/temporally-filtered unit. Against a raw per-frame unit the
verdict would degrade toward (c) for the systematic-miss reason in §2. **[INF]**

## 2. What fixed-scene detectors actually achieve

**The published evidence tops out around 98–99%, but the setting is materially harder than this
one.** The closest published analog to "camera bolted over a fixed scene, decide occupancy of known
spots" is image-based parking occupancy:

- Amato et al., *Deep learning for decentralized parking lot occupancy detection* (Expert Systems
  with Applications 72, 2017; CNRPark-EXT/PKLot): their mAlexNet reaches **98.1% accuracy in the
  single-camera scenario**, ~90.7% across cameras
  ([ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S095741741630598X))
  **[LIT]**.
- The ACPDS baseline reports **~98% accuracy on entirely unseen parking lots**
  ([arXiv:2107.12207](https://arxiv.org/abs/2107.12207)) **[LIT]**.

Those numbers are 20–100× short of a 10⁻³ miss rate. But the gap between that setting and this one
is large and every difference favors this one **[INF]**: parking datasets fight outdoor weather, sun
glare, rain, inter-car occlusion from oblique views, and (in ACPDS) deliberate cross-scene
generalization. An indoor layout with controlled lighting, a near-nadir camera (no occlusion between
cars), a **single class** (`detector.classes: ["stock"]` — no class-confusion error mode at all
**[SRC]** `config.yaml`), objects of near-constant size (§5), and explicit permission to train on
the deployment scene is close to a best case for a detector — and per the Bayes-error finding, the
residual 1–2% in those papers includes genuinely ambiguous outdoor frames this task does not have.

mAP benchmarks say nothing about this task except relative model strength (used in §3). mAP
averages over the precision-recall curve; it does not expose "recall at the low-threshold operating
point with a 1% FP budget", which is the only number that matters here. **That number can only come
from a held-out protocol on the deployment layout — which is precisely what `SPEC.md` § Accuracy
says does not yet exist.** **[INF]**

**Conclusion for (a):** < 0.1% per-frame missed detections is not supported by any published
measurement and should not be claimed. < 0.1% per *transition* after temporal filtering, on a
scene-trained single-class detector, is plausible but currently undemonstrated — it is a
measurement campaign away, not a research breakthrough away. **[INF]**

## 3. Model choice, ranked by accuracy alone

The current stack was chosen under deployment constraints (25 MiB Cloudflare ceiling, in-browser
WASM, no backend). Ranked purely by accuracy, ignoring all of that:

The relevant benchmark evidence, oriented boxes first (DOTA-v1.0, mAP50 unless noted):

| Model | DOTA-v1.0 mAP50 | mAP50-95 | Source |
|---|---|---|---|
| **LSKNet** | **81.85** (claimed SOTA) | — | [arXiv:2303.09030](https://arxiv.org/abs/2303.09030) **[LIT]** |
| **RTMDet-R** | SOTA-class rotated detection (paper's claim) | — | [arXiv:2212.07784](https://arxiv.org/abs/2212.07784) **[LIT]** |
| YOLO26x-obb | 81.7 | 56.7 | [Ultralytics OBB docs](https://docs.ultralytics.com/tasks/obb/) **[DOC]** |
| YOLO26l-obb | 81.6 | 56.2 | ibid. |
| YOLO26m-obb | 81.0 | 55.3 | ibid. |
| YOLO26s-obb | 80.9 | 54.8 | ibid. |
| **YOLO26n-obb (current)** | **78.9** | **52.4** | ibid. |

And axis-aligned, for the DETR family's ceiling: Co-DETR reaches **66.0 AP on COCO test-dev**
(ViT-L backbone) — the strongest published detector result on the standard benchmark
([arXiv:2211.12860](https://arxiv.org/abs/2211.12860)) **[LIT]** — and RT-DETR-R50/R101 reach
53.1/54.3 AP, outperforming YOLO variants of comparable scale, NMS-free by construction
([arXiv:2304.08069](https://arxiv.org/abs/2304.08069)) **[LIT]**.

The accuracy ranking that falls out **[INF]**:

1. **Ensemble of diverse large oriented detectors + TTA, fp32, server-side.** E.g. YOLO26x-obb and
   an MMRotate-family model (RTMDet-R or an LSKNet-backboned oriented detector) with cross-model box
   fusion. Architecturally diverse ensembles decorrelate exactly the systematic per-pose misses that
   dominate the tail here; this is the ceiling configuration when nothing but accuracy counts.
2. **A single large oriented detector, fp32.** LSKNet (81.85) and YOLO26x-obb (81.7) are within
   noise of each other on DOTA; either is a valid pick. RTMDet is released through MMDetection
   (the paper states code/models under CC BY 4.0 **[LIT]**) — note that leaving the Ultralytics
   family would also reopen the AGPL question `SPEC.md` § Licensing settled *for* Ultralytics
   weights, in the permissive direction; diligence required either way.
3. **A larger Ultralytics variant in the existing pipeline: YOLO26l/x-obb.** +2.7–2.8 mAP50 and
   +3.8–4.3 mAP50-95 over the current nano *for a config-line change* — same OBB label format, same
   `train.py`, same export path. This is the highest accuracy-per-effort move available.
4. **DETR family.** The highest known ceiling on axis-aligned detection (Co-DETR), and RT-DETR
   beats same-scale YOLOs — but oriented-box DETR variants are research-grade, and the occupancy
   test *requires* oriented output (`SPEC.md` § The detector is YOLO26n-OBB). Relevant only if OBB
   were abandoned or an oriented DETR port matured; not the pragmatic max-accuracy path today.
5. **The current YOLO26n-obb / INT8 / WASM stack.** The baseline: −2.8 mAP50 on DOTA against its
   own x-variant before quantization is even considered.

Two honest caveats on the ranking **[INF]**: DOTA deltas measure 15-class aerial generalization at
wildly varying scales — a single-class fixed-scene task saturates differently, and 2–3 benchmark
points do not translate 1:1. But capacity buys exactly what this task's bar is made of: the *tail*
(rare poses, marginal lighting), because in the rule-of-three regime the tail is everything. And
the top of the ranking is incompatible with the current architecture — fp32 large models and
ensembles do not fit a 25 MiB in-browser bundle, so options 1–2 imply inference off-device, which
`ui/CLAUDE.md` says not to reintroduce "without discussion". That is a consequence to weigh
explicitly, not a reason to rank differently: **if the accuracy bar of issue #115 binds, the
deployment architecture is what should bend, and this ranking is the menu for that discussion.**

**Recommendation: take option 3 immediately (l or x variant, fp32 until measurement says
otherwise), build the held-out protocol, and escalate to options 2→1 only if the measured tail
demands it.**

## 4. Large areas: corrected arithmetic, native input vs. tiling vs. multiple cameras

### The arithmetic first — DPT is dots per *track gauge*, which is scale-dependent

Per `SPEC.md` § Calibration, DPT counts pixels across the track gauge: 16.5 mm in HO, **9 mm in N**
(1435/160 ≈ 9 mm; SPEC's own example: "DPT = 4 × 9 = 36"). At the project's floor of DPT 20
(`layout.min_dpt` **[SRC]** `config.yaml`) that is **1.21 px/mm in HO but 2.22 px/mm in N** — the
same physical layout needs more pixels in a smaller scale. For a 2×1 m area at DPT 20 **[INF]**:

| Scale | px/mm | 2×1 m in pixels | Mpx | × the current 960×544 input |
|---|---|---|---|---|
| HO (1:87) | 1.21 | ~2430 × 1210 | ~2.9 | ~5.6× |
| N (1:160) | 2.22 | **~4444 × 2222** | **~9.9** | **~19×** |

The N-scale row is not hypothetical: `detector/export_onnx.py` already names "the intended capture
geometry (~4440×2130, aspect 2.08:1)" (issue #100) **[REPO]** — which is exactly this arithmetic.
The current 960×544 input covers 0.79 × 0.45 m in HO but only **0.43 × 0.24 m in N**.

Car dimensions in pixels, by contrast, are **scale-independent** (px = DPT × prototype mm / 1435,
so the scale ratio cancels — the same cancellation `config.yaml` documents for width): every car is
~42 px wide at DPT 20, a 40 ft freight car ~170 px long, an 85 ft passenger car **~360 px**. That
constant is load-bearing twice: cars are *medium-to-large* objects by detection standards in every
scale (COCO "small" is < 32² px — the tiny-object literature, SAHI/STAL/ProgLoss, mostly does not
bind here), and every overlap rule below is a fixed ~360 px regardless of scale. **[INF]**

### Option 1 — native single pass: viable at HO size, out of practice at N size

Ultralytics accepts arbitrary `imgsz` (multiples of the 32-px stride), its DOTA-pretrained OBB
models run at 1024 ([OBB docs](https://docs.ultralytics.com/tasks/obb/)) **[DOC]**, and this repo
already exports a non-square 960×544 graph **[SRC]**. A ~2432×1216 export (HO, ~3 Mpx) is
unusual-but-plausible; a single pass has no boundaries — no cut cars, no merging, no per-tile
context loss — and remains the accuracy-preferred shape *where it is trainable*.

At the N-scale figure it stops being credible **[INF]**: ~4448×2240 is ~10 Mpx, ~24× the activation
footprint of a standard 640² input, forcing batch size toward 1 on even large GPUs and landing far
outside documented YOLO practice. The decisive evidence is Ultralytics' own handling of DOTA —
source images "from 800×800 to 20,000×20,000 pixels", exactly this size class — which is **never
trained native**: the official recipe splits everything into overlapping 1024×1024 crops with
`gap=500` (i.e. ~50% overlap), multi-scale rates [0.5, 1.0, 1.5]
([DOTA dataset docs, `split_dota`](https://docs.ultralytics.com/datasets/obb/dota-v2/)) **[DOC]**.
**At 2×1 m in N scale, tiling or multiple cameras is the real answer, not a fallback.**

### Option 2 — tiling (SAHI-style), and what boundaries cost

SAHI slices the image into overlapping windows, detects per window, and merges
([Akyon et al., arXiv:2202.06934](https://arxiv.org/abs/2202.06934)) **[LIT]**. Its defaults, from
source (`sahi/predict.py` at `obss/sahi@main`) **[SRC]**:

- `overlap_height_ratio` / `overlap_width_ratio` = **0.2**;
- merge step `postprocess_type="GREEDYNMM"` with `postprocess_match_metric="IOS"` (intersection over
  *smaller* area) at threshold 0.5 — IOS rather than IoU is precisely the cut-object case: a
  fragment box has small IoU but near-1.0 IOS against the full box seen by the neighbouring tile, so
  the fragment is merged into it rather than surviving as a duplicate.

Reported gains (+6.8/+5.1/+5.3 AP for FCOS/VFNet/TOOD on VisDrone/xView, up to +14.5 with sliced
fine-tuning **[LIT]**) belong to the tiny-object regime and do not transfer here; for this task
tiling is coverage, not an accuracy upgrade, and the seams are its failure surface **[INF]**:

- The clean guarantee is **overlap greater than the longest car's pixel extent — ~360 px in every
  scale**. With 1024×1024 tiles and 400 px overlap, every car lies whole in at least one tile and
  IOS merging exists only to eliminate fragments, never to reconstruct geometry from them. (An OBB
  reconstructed from partial boxes has unreliable length and angle, and L1's point-in-oriented-box
  test consumes exactly those.)
- Tile counts at that overlap: 2×1 m needs **~8 tiles in HO** (2430×1210) and **~21 tiles in N**
  (4444×2222) — ~32 if Ultralytics' more conservative `gap=500` convention is kept. Note the DOTA
  convention's 500 px gap already exceeds the 360 px car-length requirement **[DOC]** **[INF]**.
- Train the same way the inference runs (sliced fine-tuning, per SAHI and per the DOTA recipe), so
  the model sees truncated cars at tile edges during training too.

### Option 3 — multiple cameras (required beyond some size, and cleanly compatible)

Capture is the easy half: a 4K sensor (3840×2160) covers 1.73 × 0.97 m at N-scale DPT 20, so 2×1 m
in N needs **two 4K cameras** (or one ≥ 4444-px-wide sensor); in HO one 4K camera covers it with
room to spare. **[INF]** The architecture makes multi-camera clean because **L1 is per-sensor and
needs no global stitched view**:

- **Detect per camera; never stitch pixels.** Stitching assumes a planar scene; car roofs stand
  above the table (a 4.6 m prototype boxcar is ~29 mm tall in N, ~53 mm in HO), so any off-nadir
  pair of cameras disagrees about roof positions at the seam (parallax), and a stitched image puts
  exactly the hardest artifacts where cars get cut. Per-camera detection avoids the artifact class
  entirely.
- **Assign each sensor to exactly one camera**, chosen so the sensor sits at least one maximum car
  length (~360 px ≈ 16 cm in N, 30 cm in HO) inside that camera's field of view. A car covering the
  sensor then lies wholly inside the frame, so the covering detection cannot be truncated. This is
  the same "overlap > car length" rule as tiling, applied at the rig level; adjacent cameras
  overlap by ~2× max car length between sensor territories.
- Each camera's frame is then itself tiled per Option 2 if it exceeds the model input. A merged L0
  map across cameras (for display) can reuse the detector's existing rotated-IoU suppression
  (`lib/detector/src/overlap.ts` **[SRC]**) in the overlap zones; L1 never needs it.

## 5. Is fixed-DPT normalization a good strategy for YOLO? Yes.

The CNN's resample-to-fixed-DPT strategy transfers to YOLO essentially unchanged, for three
reasons:

1. **Scale-distribution match between training and deployment is a known win.** Scale Match
   ([Yu et al., arXiv:1912.10664](https://arxiv.org/abs/1912.10664), WACV 2020) shows that
   *mismatched object-scale distributions* between the data a network learned from and the data it
   runs on measurably degrade detection, and aligning them recovers it **[LIT]**. Fixed DPT is the
   strongest possible form of alignment: the deployed size distribution is a spike, and training
   data is normalized onto the same spike — and because car pixel size is scale-independent at
   fixed DPT (§4), one normalized corpus serves every scale.
2. **Anchor-free does not mean scale-free.** YOLO26 is anchor-free with an end-to-end head
   ([Ultralytics YOLO26 docs](https://docs.ultralytics.com/models/yolo26/)) **[DOC]**, but the head
   still predicts from feature-pyramid levels at fixed strides and still learns the size priors
   present in its data. A narrow size distribution concentrates all supervision on the one pyramid
   level that fires at deployment, instead of spreading it across scales the deployment never
   shows. **[INF]**
3. **Ultralytics' own augmentation guidance for fixed scenes agrees.** The official augmentation
   guide advises disabling scale augmentation "for fixed-scene tasks where object scales remain
   constant and camera distance doesn't vary"
   ([data-augmentation guide](https://docs.ultralytics.com/guides/yolo-data-augmentation/))
   **[DOC]** — i.e. the framework's documented best practice for exactly this deployment is to
   *trust* a constant object size, which only exists if DPT is normalized.

Two caveats **[INF]**: downsampling only (as the issue assumes) is the right constraint — upsampling
manufactures no information and un-matches the noise statistics; and the DOTA checkpoint was
pretrained at its own ground-sample distances, so the fine-tune is also a scale re-match — one more
reason the fine-tune must see deployment-DPT data rather than shipping close to the checkpoint.

## 6. Accuracy-maximizing steps, in order of expected value

1. **Train on the deployment scene, exhaustively — including its negatives.** The issue permits it,
   and it converts the open-world generalization problem into pose interpolation on a known
   background. The corpus should systematically cover: every track section, both car orientations
   per section, coupled consists, lighting states, and **negative frames** — empty layout, and the
   FP sources the SPEC's bias makes expensive (hands, tools, a person leaning in; compare
   `docs/research/image-change-detection.md` §4c). A single-class detector fires on "objectness"; a
   hand it never saw is an FP candidate, and a persistent phantom deadlocks a schedule
   (`SPEC.md` § The vocabulary). **[INF]**
2. **Model capacity (§3).** The l/x OBB variants are +2.7–2.8 DOTA mAP50 over the current nano for
   a config-line change; escalate toward the §3 ranking's ensemble only if the measured tail
   demands it.
3. **Rotation augmentation — currently off.** Ultralytics defaults `degrees=0`
   ([data-augmentation guide](https://docs.ultralytics.com/guides/yolo-data-augmentation/))
   **[DOC]**, and `detector/train.py` deliberately leaves defaults untouched **[SRC]**. For an
   overhead OBB task where cars appear at every orientation but training captures show a median 4°
   from horizontal (`SPEC.md` § The detector is YOLO26n-OBB), full-range rotation is the single
   cheapest way to cover unseen orientations — the guide names exactly this case ("aerial/drone
   imagery where vehicles can face any direction"). Keep `scale` low/off (fixed DPT, per §5); flips
   are free and valid overhead; keep mosaic with `close_mosaic` per the guide.
4. **Threshold asymmetry, then temporal hysteresis at L1.** Run the confidence threshold low —
   recall is bought at the threshold, and the 1% FP budget is 10× looser than the miss budget. The
   current 0.25 is an uncalibrated placeholder (`config.yaml` **[SRC]**); the real value falls out
   of the held-out PR curve at the FP budget. Then debounce **asymmetrically** in time: report
   `occupied` on the first covering detection, but require k consecutive clear frames before
   `clear`. Transient misses with any independence decay ~pᵏ; at 5 fps, k=3 costs ~0.6 s of
   clear-latency — comparable to the ~0.5 s the EX-SensorCAM ecosystem already accepts. Temporal
   aggregation as an accuracy source is established in the video-detection literature
   ([Seq-NMS](https://arxiv.org/abs/1602.08465), which rescores weak detections from high-scoring
   neighbours in adjacent frames; [FGFA](https://arxiv.org/abs/1703.10025), feature-level
   aggregation, "significant improvements upon strong single-frame baselines") **[LIT]**. The L1
   layer (`occupancy()` in `lib/detector`) is the natural home — it is already the place where the
   occupied bias lives. **Honesty clause: hysteresis does nothing against correlated misses** — a
   stationary car the model cannot see in that pose is missed in every frame. Those are attacked by
   steps 1, 2 and 7, not by filtering. **[INF]**
5. **If staying with a YOLO end2end export: consider `end2end=False` + explicit NMS.** Ultralytics'
   own guide states the one-to-many head with NMS is the accuracy-maximal configuration ("If
   maximum accuracy is your top priority, you can always fall back to the one-to-many head using
   `end2end=False`", ~0.5 mAP difference)
   ([end-to-end guide](https://docs.ultralytics.com/guides/end2end-detection)) **[DOC]**; §8 has
   the duplicate evidence. DETR-family options (§3) are NMS-free by construction. **[INF]**
6. **Test-time augmentation and ensembling — real but small per step.** Ultralytics measures TTA at
   +1.2 mAP points (0.504 → 0.516) for ~2–3× inference cost on COCO
   ([TTA tutorial](https://docs.ultralytics.com/yolov5/tutorials/test_time_augmentation/))
   **[DOC]**; model ensembling is the same lever with more diversity
   ([ensembling tutorial](https://docs.ultralytics.com/yolov5/tutorials/model_ensembling/))
   **[DOC]**, and cross-architecture ensembling (§3 option 1) is its strong form. On a fixed scene,
   most of what TTA buys should instead be bought once, in training, with step 3 — reach for these
   when the held-out numbers stall just short of the bar. **[INF]**
7. **A hard-example loop, which needs the missing diagnostics (#87).** On a fixed layout, every miss
   in a held-out run is a specific reproducible image to relabel and retrain on. Given ~zero Bayes
   error (verdict, finding 1), this loop has no floor above the target to stall at; it is the
   mechanism by which a scene-trained detector approaches very low systematic-miss rates. Blocked
   today on archive diagnostics in the UI (issue #87) and a held-out protocol (issue #4). **[INF]**
8. **Keep the existing L1 safety geometry.** Width normalization (substituting the derived constant
   for predicted width, widening only) and the strict-containment test already bias the remaining
   geometry errors toward `occupied` (`SPEC.md` § The occupancy test) **[REPO]** — as does the
   camera-drift refusal (issue #12) that turns "camera moved" from silent misses into `unknown`.

## 7. INT8 quantization — relevant only if the in-browser stack is retained

INT8 is a deployment optimization, not an accuracy technique: the max-accuracy paths in §3 run fp32
off-device and skip this section entirely. For the current stack it is close to free, with one
loud-once-you-look failure mode. ONNX Runtime's docs are plain that "quantization is not a
loss-less transformation", recommend static (not dynamic) quantization for CNNs, calibration on
representative data, per-channel quantization when accuracy suffers, and per-op exclusion via the
QDQ debugging path
([ORT quantization docs](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html))
**[DOC]**. This repo has already walked that whole path (`detector/export_onnx.py` **[SRC]**,
issue #107 **[REPO]**):

- Quantizing **Conv only**, per-channel, statically calibrated on real letterboxed frames, costs
  ~0.5 px of centre agreement against fp32 — negligible against a 42-px car width.
- Detection *counts* match across precision: fp32 found 130 boxes over 87 vehicles, INT8 139 over
  89 on the same corpus — quantization moved scores slightly; it did not eat recall.
- The known catastrophic mode — quantizing the head's output `Concat`, which collapses every score
  to zero — is structural, loud once you compare against fp32, and permanently guarded by the
  export script's fp32-vs-INT8 detection-count check.

**Conclusion for (e): if the browser stack is kept, INT8 is not where the accuracy budget goes**,
provided the current Conv-only/static/calibrated recipe and the fp32 comparison check are kept.
**[INF]**

## 8. The YOLO end2end head: trust the measurement, not the marketing

*(Applies to the Ultralytics end2end option only; one-to-many + NMS, and the DETR family, are
outside this failure mode by construction.)*

Ultralytics' end-to-end guide claims the one-to-one head learns "clean, non-overlapping
predictions" with "no external filtering required"
([end-to-end guide](https://docs.ultralytics.com/guides/end2end-detection)) **[DOC]**. The evidence
says otherwise:

- **This repo measured it false** (issue #107 **[REPO]**): the exported `end2end` graph's `TopK`
  selects 300 slots and suppresses nothing — up to four boxes per car, at fp32 and INT8 alike
  (130 boxes / 87 vehicles fp32), now suppressed browser-side by rotated-IoU NMS at
  `detector.nms_iou: 0.5` (`lib/detector/src/decode.ts`, `overlap.ts` **[SRC]**).
- **Upstream users report the same**: duplicate detections at ~100% overlap with `end2end=true`,
  gone with `end2end=false, nms=true`
  ([ultralytics#23685](https://github.com/ultralytics/ultralytics/issues/23685), closed stale
  without a fix) **[DOC]**.

For an *accuracy* question this matters twice **[INF]**: unsuppressed duplicates are pure FP
pressure against the 1% budget (already handled here), and a one-to-one assignment that emits four
boxes for one car is a head that has not fully learned its dedup job on this data — mild evidence
that the accuracy-maximal configuration for a small custom corpus is the one-to-many head + NMS
(§6.5), exactly as Ultralytics' own guide concedes. Either way: **never run this head without
explicit suppression somewhere**, which the repo already enforces.

## 9. What the verdict depends on, explicitly

**(b) — difficult but likely achievable** stands on all of the following; remove any one and it
moves:

1. **Error rates defined per sensor transition after temporal hysteresis**, not per raw frame. Per
   raw frame, < 0.1% is unsupported by any published number and likely unfalsifiable to demonstrate
   → toward (c).
2. **Training on the deployment layout at deployment DPT**, with systematic pose coverage, rotation
   augmentation, negative frames, and a hard-example retraining loop. Today's tracer model — 46
   fixture images below `min_dpt`, missing 23 of 92 *training* cars (`detector/train.py` docstring
   **[REPO]**) — predicts nothing; it was never meant to.
3. **A held-out measurement protocol on ~3000 independent car-placements** (issues #4, #87). The
   claim "< 0.1%" is empty until something can measure it; the rule-of-three arithmetic in §1 sizes
   the campaign.
4. **The FP budget spent deliberately**: low confidence threshold, phantom persistence handled at
   L1, hands/tools in the negative set.
5. **Willingness to bend the deployment architecture if measurement demands it.** The §3 ranking's
   upper options (large fp32 models, ensembles) do not fit the 25 MiB in-browser constraint. If the
   nano-in-WASM stack measures short of the bar, the accuracy goal outranks the stack — and at
   N-scale areas the input-geometry arithmetic (§4) already forces tiling or multi-camera
   regardless of model.
6. **"Virtually avoid crashes" read statistically — with the Bayes-error framing cutting both
   ways.** Because a human answers perfectly from the same pixels, the irreducible error is ~0 and
   nothing *in principle* caps the achievable rate — that is what holds the verdict at (b) with
   confidence rather than (b) with a shrug. But the residual model-vs-human gap closes by
   iteration, not by argument; correlated failures (lighting change, camera bump, an unseen car
   type) arrive in bunches; and per `SPEC.md` § Accuracy nothing in this project may be presented
   as a safety interlock. A crash-avoidance *guarantee* is (c) — hopeless — for any camera-and-CNN
   system; a very low statistical rate is (b), and that is what the issue's own "virtually" asks
   for.

---

## What I could not determine

- **Any published per-frame false-negative rate at the 10⁻³ level for a deployed detector.** The
  literature reports mAP/F1 on benchmarks; operating-point recall at a fixed FP budget on a fixed
  scene appears in no primary source I found. The §2 parking numbers are the nearest published
  analog, and they measure classification per space, not detection.
- **Oriented-box DOTA numbers for the DETR family comparable to the LSKNet/RTMDet/YOLO26 table.**
  Oriented DETR variants exist in the literature but I found no primary result placing one clearly
  above LSKNet's 81.85 on DOTA-v1.0; the §3 ranking therefore rests the DETR case on axis-aligned
  evidence (Co-DETR, RT-DETR) plus the caveat that OBB support is research-grade.
- **YOLO26's duplicate-suppression training details beyond the docs.** The end-to-end guide and
  release notes describe the one-to-one assignment qualitatively; issue #23685 was closed stale
  without a maintainer root-cause. The repo's own #107 measurement is the strongest evidence in
  hand.
- **Quantified accuracy cost of tile-boundary truncation for OBB specifically.** SAHI's gains are
  measured on axis-aligned tiny-object benchmarks; I found no primary measurement of oriented-box
  quality reconstructed from cut fragments. The §4 recommendation (overlap > max car length ≈
  360 px, matching Ultralytics' own DOTA gap=500 convention) is engineered to make the question
  moot rather than to answer it.

---

## Sources

**Official documentation:**
- Ultralytics YOLO26 — <https://docs.ultralytics.com/models/yolo26/>
- Ultralytics end-to-end (NMS-free) detection guide — <https://docs.ultralytics.com/guides/end2end-detection>
- Ultralytics OBB task (DOTA mAP tables for n/s/m/l/x, imgsz 1024) — <https://docs.ultralytics.com/tasks/obb/>
- Ultralytics DOTA dataset / `split_dota` (1024 crops, gap 500, multi-scale) — <https://docs.ultralytics.com/datasets/obb/dota-v2/>
- Ultralytics data augmentation guide — <https://docs.ultralytics.com/guides/yolo-data-augmentation/>
- Ultralytics SAHI tiled-inference guide — <https://docs.ultralytics.com/guides/sahi-tiled-inference/>
- Ultralytics test-time augmentation — <https://docs.ultralytics.com/yolov5/tutorials/test_time_augmentation/>
- Ultralytics model ensembling — <https://docs.ultralytics.com/yolov5/tutorials/model_ensembling/>
- ONNX Runtime quantization — <https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html>

**Source code:**
- SAHI defaults (overlap 0.2, GREEDYNMM, IOS 0.5) — `sahi/predict.py` at <https://github.com/obss/sahi>
- Ultralytics duplicate-detection report — <https://github.com/ultralytics/ultralytics/issues/23685>
- This repo: `detector/train.py`, `detector/export_onnx.py`, `config.yaml`,
  `lib/detector/src/decode.ts`, `overlap.ts`

**Literature (arXiv originals / peer-reviewed):**
- Akyon, Altinuc, Temizel, *Slicing Aided Hyper Inference (SAHI)*, ICIP 2022 — <https://arxiv.org/abs/2202.06934>
- Yu et al., *Scale Match for Tiny Person Detection*, WACV 2020 — <https://arxiv.org/abs/1912.10664>
- Han et al., *Seq-NMS for Video Object Detection* — <https://arxiv.org/abs/1602.08465>
- Zhu et al., *Flow-Guided Feature Aggregation for Video Object Detection*, ICCV 2017 — <https://arxiv.org/abs/1703.10025>
- Lyu et al., *RTMDet: An Empirical Study of Designing Real-Time Object Detectors* — <https://arxiv.org/abs/2212.07784>
- Li et al., *Large Selective Kernel Network for Remote Sensing Object Detection* (LSKNet), ICCV 2023 — <https://arxiv.org/abs/2303.09030>
- Zhao et al., *DETRs Beat YOLOs on Real-time Object Detection* (RT-DETR), CVPR 2024 — <https://arxiv.org/abs/2304.08069>
- Zong et al., *DETRs with Collaborative Hybrid Assignments Training* (Co-DETR), ICCV 2023 — <https://arxiv.org/abs/2211.12860>
- Amato et al., *Deep learning for decentralized parking lot occupancy detection*, Expert Systems
  with Applications 72 (2017) — <https://www.sciencedirect.com/science/article/abs/pii/S095741741630598X>
- Marek, *Image-Based Parking Space Occupancy Classification: Dataset and Baseline* (ACPDS) — <https://arxiv.org/abs/2107.12207>
- Hanley, Lippman-Hand, *If nothing goes wrong, is everything all right?*, JAMA 249(13):1743 (1983)
  — the "rule of three" for zero-failure confidence bounds

**This repo:** `SPEC.md` (§ Accuracy, § Occupancy Output, § Calibration, § The detector is
YOLO26n-OBB, § Live-view runtime contract), `CLAUDE.md`, issues #3, #4, #11, #12, #87, #100, #107,
`docs/research/image-change-detection.md`.
