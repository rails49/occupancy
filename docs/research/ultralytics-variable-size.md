# Ultralytics support for DPT-normalized variable-size training and export

Written 2026-08-05. Research note on [issue #127](https://github.com/iot49/rails49/issues/127): the DPT-normalized
design resamples every image to a constant DPT, pads up to a multiple of 32, and lets input size
fall out of layout extent × DPT — so it differs per layout. The network itself doesn't care
(fully convolutional, strides 8/16/32 — established in #115's groundwork); this note answers what
the **framework and export chain** support: `imgsz`/`rect`/mosaic at rectangular sizes for OBB,
val/predict at native sizes, `dynamic=True` export through the ONNX → INT8 → `.ort` chain, and
the documented fixed-scene guidance.

*Researched 2026-08-05. Sources: Ultralytics official docs and the Ultralytics source at the
exact pinned version this repo trains with (`ultralytics==8.4.115`, read from the installed
package and spot-checked line-for-line against the `v8.4.115` tag on GitHub), ONNX Runtime
official docs and the pinned `onnxruntime==1.23.2` tools source, plus measurements run for this
ticket on the pinned toolchain (torch 2.2.2, CPU) using the real `tracer-long` weights. All
source line numbers below are `v8.4.115` / `onnxruntime 1.23.2`.*

---

## Verdict, by sub-question

1. **Rectangular/variable-size OBB training is supported, but only through `rect=True`, and
   `rect` is per-batch, not per-image.** Train `imgsz` is forced to a single scalar (a `[h,w]`
   list is coerced to `max(imgsz)` with a warning). `rect=True` sorts the dataset by aspect
   ratio, groups it into batches, and gives each *batch* one shape derived from `imgsz` and the
   batch's extreme aspect ratio, rounded up to stride multiples. It hard-disables mosaic, mixup
   and cutmix, and (usually) dataloader shuffle. Nothing is OBB-specific: the OBB task uses the
   same dataset, batching and augmentation pipeline. **The trap for DPT normalization:** the
   image loader always rescales every image's long side to `imgsz` — `rect` controls batch
   padding, not object scale — so pre-normalized DPT survives only if every training image's
   long side already equals `imgsz`. The dataset export must pad (not resize) all images to one
   corpus-wide long side. (§1, §2)
2. **Val and predict can run near-native, with caveats.** Predict accepts `[h,w]` `imgsz` and,
   for PyTorch weights or a `dynamic` export, letterboxes each call to the minimal stride-padded
   rectangle. Val is scalar-`imgsz`, rect-batched (per-batch shapes again, effectively per-image
   at `batch=1`) — but the long-side-to-`imgsz` rescale applies there too, and **Ultralytics val
   cannot run on a rectangular static export at all**: the exporter itself warns "non-PyTorch
   val requires square images", and the validator forces `rect=False` and a square input from
   export metadata for fixed-shape formats. Accuracy numbers for a rectangular pipeline come
   from PyTorch val or from this repo's own diagnostics, not from Ultralytics val on the
   exported artifact. (§3)
3. **`dynamic=True` export works through the entire existing chain — measured, not argued.**
   It marks batch/height/width as dynamic ONNX axes and makes the head recompute anchors per
   forward. Measured on the real tracer weights: the dynamic YOLO26n-OBB end2end graph exports,
   survives static INT8 (Conv-only QDQ) and `convert_onnx_models_to_ort --optimization_style
   Fixed`, and the resulting `.ort` runs at 352×640, 544×960 and 1088×1920 with the same
   `[1, 300, 7]` output, at parity with fp32 on real frames. `--optimization_style Fixed` refers
   to *when optimizations are applied*, not to shapes — the ORT format itself is
   shape-agnostic. Two real constraints: inputs must supply ≥ 300 anchors (H·W ≥ ~14,629 px, a
   cliff only at absurdly small sizes), and the in-browser WASM runtime is the one place the
   chain has not been exercised (no test environment here can). So **per-layout fixed-size
   export is not forced** — a single dynamic artifact is viable; fixed export remains the
   conservative fallback and is what NNAPI/CoreML-class providers and ORT-web's
   graph-capture/free-dimension optimizations prefer. (§4, §5)
4. **Fixed-scene guidance exists but is thinner than folklore says.** The augmentation guide's
   actual sentence: "If the camera's point of view is consistent and won't change once the model
   is deployed, you can likely skip geometric transformations such as `rotation`,
   `translation`, `scale`, `shear`, or `perspective`." Under DPT normalization, `scale=0` is the
   one to pin (the guide's blanket "skip geometric" over-reaches for this task — cars appear at
   every orientation, so rotation stays, per the prior note's §5). Mosaic: "use … only if having
   partially occluded objects or multiple objects per image is acceptable" — and it is moot
   under `rect=True`, which zeroes it anyway. No documented pitfalls of the end2end head at
   non-square sizes exist in the docs; the pitfalls are in the source: the TopK anchor floor,
   `max_det` baked at export-time `imgsz`, the square-val limitation, and the exporter's own
   admission that static activation quantization collapses the end2end head (it disables
   end2end for LiteRT INT8 for exactly the failure this repo measured in #107). (§6)

---

## Legend

| Tag | Meaning |
|---|---|
| **[DOC]** | Stated in official documentation (Ultralytics, ONNX Runtime). Link given. |
| **[SRC]** | Read directly from pinned source code (`ultralytics v8.4.115`, `onnxruntime 1.23.2`). File and line cited; line-anchored GitHub URLs are against the `v8.4.115` tag, verified identical to the installed package. |
| **[MEAS]** | Measured for this ticket, on this repo's pinned toolchain and real tracer weights. Method stated inline. |
| **[REPO]** | Read from or previously measured in this repository. |
| **[INF]** | My inference or arithmetic. Not sourced — argued. |

---

## 1. The framework's size model: one scalar, applied at image load

**Train and val `imgsz` is a scalar, by enforcement.** `check_imgsz` is called with `max_dim=1`
from both the trainer
([`engine/trainer.py` L381](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/trainer.py#L381))
and the validator
([`engine/validator.py` L140](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/validator.py#L140));
a `[h,w]` list is coerced to `max(imgsz)` with the warning "'train' and 'val' imgsz must be an
integer, while 'predict' and 'export' imgsz may be a [h, w] list"
([`utils/checks.py` L148–L205](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/utils/checks.py#L148-L205))
**[SRC]**. The docs agree: "train/val use int (square); predict/export may use [h,w]"
([`cfg/default.yaml` L16](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/cfg/default.yaml#L16))
**[SRC]**. So there is no such thing as passing the deployed `(960, 544)` — or any per-layout
rectangle — to `model.train()` directly; rectangles enter training only via `rect=True` (§2).

**The scalar is applied at image load, as a long-side resize — this is the finding that shapes
the whole design.** `BaseDataset.load_image` with `rect_mode=True` (the default) resizes every
image so its **long side equals `imgsz`**, up *or* down (`r = imgsz / max(h0, w0)`; any `r != 1`
triggers a resize)
([`data/base.py` L210–L262](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/base.py#L210-L262),
the branch at L251) **[SRC]**. This happens before any letterbox or augmentation, in train *and*
val datasets alike. Consequence **[INF]**: a corpus of DPT-normalized images whose sizes differ
per layout does **not** stay DPT-constant through the dataloader — a layout whose image is
smaller than `imgsz` on the long side is silently upscaled, one larger is downscaled, and the
per-layout scale variation the normalization removed comes straight back.

**The fix is padding at dataset-derivation time, and it makes the whole scheme work** **[INF]**:
have `dataset/src/yolo_export.ts` pad every DPT-normalized image (never resize) to one
corpus-wide long side — the maximum layout extent × DPT, rounded up to a multiple of 32 — and
set `imgsz` to exactly that constant. Then `r == 1` and `load_image` never touches a pixel;
`rect=True` (§2) handles the *aspect* variation per batch as pure padding; and object scale is
DPT-by-construction end to end. (Padding to a full uniform canvas instead — same long side
*and* same short side — also works, costs more memory per batch, and is the only route that
keeps mosaic available, since `rect` kills mosaic; see §2.)

**`multi_scale` is the opposite of this design and stays 0.** It randomly varies `imgsz` per
batch ("Randomly vary `imgsz` each batch by +/- `multi_scale`", [train mode docs
arguments table](https://docs.ultralytics.com/modes/train/)) **[DOC]**; default `0.0`
([`cfg/default.yaml` L40](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/cfg/default.yaml#L40))
**[SRC]**.

## 2. `rect=True`: per-batch shapes, mosaic disabled, shuffle usually disabled

**`rect` is per-batch, confirmed from source.** `BaseDataset.set_rectangle`
([`data/base.py` L370–L393](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/base.py#L370-L393))
**[SRC]**:

- sorts the entire dataset by aspect ratio (`ar = h/w`, `ar.argsort()`) and reorders `im_files`
  and `labels` in place;
- assigns images to batches contiguously (`bi = floor(arange(ni) / batch_size)`);
- computes **one shape per batch** from the batch's extreme aspect ratio, scaled by the scalar
  `imgsz`, padded by `pad` and rounded **up** to stride multiples:
  `batch_shapes = ceil(shapes * imgsz / stride + pad) * stride` (L392).

Each image then carries its batch's shape into the transform pipeline as `label["rect_shape"]`
([`data/base.py` L415–L416](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/base.py#L415-L416))
**[SRC]**, where it takes priority over the square default in both consumers: `LetterBox`
(`new_shape = labels.pop("rect_shape", self.new_shape)`,
[`data/augment.py` L1762](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L1762))
and `RandomPerspective` ("rect has higher priority",
[`data/augment.py` L1165–L1166](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L1165-L1166))
**[SRC]**. The docs describe the same contract: "images in a batch are minimally padded to reach
a common size, with the longest side equal to `imgsz` … may affect model accuracy"
([train mode docs](https://docs.ultralytics.com/modes/train/)) **[DOC]** — note the docs' own
accuracy caveat is undated and unquantified.

**`rect=True` disables mosaic, mixup and cutmix outright.** In `YOLODataset.build_transforms`:
`hyp.mosaic = hyp.mosaic if self.augment and not self.rect else 0.0` (and identically for mixup
and cutmix,
[`data/dataset.py` L303–L317](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/dataset.py#L303-L317))
**[SRC]**. The exclusion is also asserted at runtime: `Mosaic.get_params` carries
`assert labels.get("rect_shape") is None, "rect and mosaic are mutually exclusive."`
([`data/augment.py` L511](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L511))
**[SRC]**. `close_mosaic` is therefore moot under `rect` — there is no mosaic to close.

**Mosaic is structurally square.** It composites onto a `2·imgsz × 2·imgsz` canvas
(`self.border = (-imgsz // 2, -imgsz // 2)`,
[`data/augment.py` L433–L480](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L433-L480))
and the following affine crops to `size=(imgsz, imgsz)`
([`data/augment.py` L2757–L2807](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L2757-L2807))
**[SRC]** — so even without `rect`, mosaic forces the square training grid. There is no
rectangular mosaic in the framework.

**`rect=True` usually disables shuffling — with a load-bearing exception.** The detection
trainer warns "'rect=True' is incompatible with DataLoader shuffle, setting shuffle=False" —
but only when batch shapes actually differ:
`if getattr(dataset, "rect", False) and shuffle and not np.all(dataset.batch_shapes == dataset.batch_shapes[0])`
([`models/yolo/detect/train.py` L93–L96](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/models/yolo/detect/train.py#L93-L96))
**[SRC]**. Consequence **[INF]**: if the padded corpus of §1 happens to produce one common batch
shape (all aspects in a band that rounds to the same /32 rectangle), shuffle survives; otherwise
training iterates aspect-sorted batches in a fixed order every epoch. For a corpus dominated by
a handful of layouts this is a real (if second-order) regularization loss to weigh against
uniform-canvas padding, which keeps both shuffle and mosaic.

**Nothing here is OBB-specific.** The OBB task trains through the same `YOLODataset`
(`use_obb=True`), the same `set_rectangle`, and the same `v8_transforms`; `RandomPerspective`
warps the rotated instances with the same matrix it applies to the image and honors
`rect_shape` for its output canvas
([`data/augment.py` L1154–L1196](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L1154-L1196))
**[SRC]**. `models/yolo/obb/train.py` overrides nothing about sizing or batching **[SRC]**.

## 3. Val and predict: what "native size" actually means per mode

**The letterbox has three behaviors, selected per mode** (all from
[`data/augment.py` L1656–L1790](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/augment.py#L1656-L1790))
**[SRC]**:

| Mode | `new_shape` | `auto` | `scaleup` |
|---|---|---|---|
| train (augment path) | per-batch `rect_shape` via `RandomPerspective` | — | (affine, not letterbox) |
| val dataset | per-batch `rect_shape`, else square `imgsz` | False | **False** — "only scale down, do not scale up (for better val mAP)" (L1768–L1769) |
| predict | `imgsz` (int or `[h,w]`) | `same_shapes and rect and (pt or dynamic)` | True (default) |

`auto=True` is the minimal-rectangle mode: after the aspect-preserving resize, padding is taken
modulo the stride (`dw, dh = np.mod(dw, stride)`, L1775–L1776) — the image is padded only up to
the next /32 boundary, not to the full target **[SRC]**.

**Predict:** `imgsz` may be `[h,w]` (`check_imgsz(..., min_dim=2)`,
[`engine/predictor.py` L271](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/predictor.py#L271));
`Model.predict` defaults `rect=True`
([`engine/model.py` L498](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/model.py#L498));
and `pre_transform` enables `auto` only for PyTorch weights **or an export that declares itself
dynamic**: `auto = same_shapes and self.args.rect and (self.model.format == "pt" or
(getattr(self.model, "dynamic", False) and self.model.format != "imx"))`
([`engine/predictor.py` L200–L217](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/predictor.py#L200-L217))
**[SRC]**. So per-image near-native prediction (bounded by `imgsz` on the long side, /32-padded)
is exactly what `.pt` weights and `dynamic=True` exports get; a static export gets `auto=False`
and the fixed export shape, always.

**Val:** `Model.val` defaults `rect=True`
([`engine/model.py` L585](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/model.py#L585)),
and the trainer builds its val dataset with `rect=mode == "val"` unconditionally
([`models/yolo/detect/train.py` L76](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/models/yolo/detect/train.py#L76))
**[SRC]** — so validation is rect-batched even when training is not. Val batches get `pad=0.5`
(train gets `0.0`;
[`data/build.py` L248](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/data/build.py#L248))
**[SRC]**, adding half a stride-cell of margin to each batch shape. At `batch=1` every "batch"
is one image, so val runs per-image shapes — but the §1 long-side-to-`imgsz` rescale in
`load_image` applies to val datasets identically, so "native" still requires the padded-corpus
convention **[INF]**.

**Val on a rectangular static export is not supported at all.** The exporter prints
"WARNING ⚠️ non-PyTorch val requires square images, 'imgsz=[544, 960]' will not work. Use export
'imgsz=960' if val is required"
([`engine/exporter.py` L947–L952](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L947-L952);
observed verbatim in this ticket's export run **[MEAS]**), and the validator, handed any
non-PyTorch fixed-shape model, overrides the user: `imgsz = max(model.imgsz)` ("reuse square
imgsz from export metadata", L209), forces the exported batch size (L211), and sets
`self.args.rect = False`
([`engine/validator.py` L206–L230](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/validator.py#L206-L230))
**[SRC]**. Consequence **[INF]**: under the current fixed-rect export, Ultralytics can never
score the deployed artifact at its deployed geometry — accuracy numbers come from PyTorch val
(or this repo's own diagnostics, #87/#4). A `dynamic=True` export dissolves this: the validator's
override is gated on `not getattr(model, "dynamic", False)`, so a dynamic ONNX validates
rect-batched like `.pt` does (same L206–L230 gate) **[SRC]**.

## 4. `dynamic=True` export: what changes, and what was measured

**What the flag does** ([export mode docs](https://docs.ultralytics.com/modes/export/): "Allows
dynamic input sizes … enhancing flexibility in handling varying image dimensions") **[DOC]**,
from source:

- Declares dynamic ONNX axes: `{"images": {0: "batch", 2: "height", 3: "width"}}` and, for
  detection models, `{"output0": {0: "batch", 2: "anchors"}}`
  ([`engine/exporter.py` L1049–L1060](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L1049-L1060))
  **[SRC]**. (That output spec is written for the raw one2many layout; on an end2end graph
  onnxslim's shape inference re-fixes the trailing dims — the exported model declares
  `output0: ['batch', 300, 7]`, measured below.)
- Sets `m.dynamic = True` on the head
  ([`engine/exporter.py` L860](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L860)),
  which makes `_get_decode_boxes` recompute anchors and strides from the actual feature-map
  shape every forward instead of caching one shape
  ([`nn/modules/head.py` L187–L196](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/nn/modules/head.py#L187-L196))
  **[SRC]**.
- Leaves the end2end TopK's `k` a **baked constant**: `k = max_det if self.export else
  min(max_det, anchors)`
  ([`nn/modules/head.py` L249](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/nn/modules/head.py#L249)),
  with `max_det` clamped at export time to the anchor count of the *export* `imgsz`
  ([`engine/exporter.py` L863–L869](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L863-L869))
  **[SRC]**. So the `[1, 300, 7]` contract the browser decode relies on survives dynamic export
  at every runtime size — 300 is a property of the graph, not the input.

**Measured on the real weights** (tracer-long `best.pt`, torch 2.2.2 CPU, the exact
`export_onnx.py` settings except `dynamic=True`) **[MEAS]**:

- Export succeeds; input `['batch', 3, 'height', 'width']`, output `['batch', 300, 7]`.
- The fp32 ONNX runs at 544×960, 352×640, 736×1280, 1088×1920 and 96×160, output `(1, 300, 7)`
  at every size.
- **The anchor floor is real**: at 96×128 (252 anchors) and 64×96 (126 anchors) inference fails
  with `TopK … k argument [300] should not be greater than specified axis dim value [252]`.
  Total anchors are `H·W·21/1024` (strides 8/16/32), so the graph requires
  `H·W ≥ 300·1024/21 ≈ 14,629 px` — irrelevant at deployment sizes, but a hard cliff, and the
  reason a tiled variant of this pipeline could not use tiny tiles with this head **[INF]**.
- **The full chain holds**: static INT8 (`quantize_static`, QDQ, per-channel, Conv-only —
  `export_onnx.py`'s exact recipe — calibrated at 960×544) succeeds on the dynamic graph, and
  `convert_onnx_models_to_ort --optimization_style Fixed` converts it (3.58 MiB `.ort`). The
  `.ort` loads on the CPU EP with input `['batch', 3, 'height', 'width']` and runs at 544×960,
  352×640 and 1088×1920.
- **Accuracy parity on real frames**: across 8 exported training frames at 960×544, detections
  above `confidence_threshold` 0.25 — dynamic fp32 ONNX **68**, dynamic INT8 `.ort` **70**,
  the shipped static `detector_int8.ort` **65**. Quantization jitter of the size #107 already
  characterized; no collapse, no degradation attributable to `dynamic` **[MEAS]** (shipped-model
  baseline **[REPO]**).

Calibration note **[INF]**: static quantization fixes per-tensor activation scales as constants;
they are applied unchanged at every runtime size. Calibrating at one geometry therefore
"specializes" the scales to that geometry's activation statistics — under DPT normalization
that is the deployment distribution by construction, which is the same argument
`export_onnx.py` already makes for letterbox-matched calibration.

## 5. The `.ort` format and `--optimization_style Fixed` are shape-agnostic

**"Fixed" is about when optimizations run, not about shapes.** The ORT-format docs define the
two styles: "'Fixed': Run optimizations directly before saving the ORT format model. This bakes
in any platform-specific optimizations." vs. "'Runtime': Run basic optimizations directly and
save certain other optimizations to be applied at runtime if possible" — Runtime recommended
only "when using NNAPI or CoreML"
([ORT format models docs](https://onnxruntime.ai/docs/performance/model-optimizations/ort-format-models.html))
**[DOC]**. The converter's implementation is nothing more than loading the model into an
`InferenceSession` with `session.save_model_format = ORT` and the chosen optimization level —
no shape handling anywhere (`onnxruntime/tools/convert_onnx_models_to_ort.py`, `_convert`,
onnxruntime 1.23.2) **[SRC]**. The empirical confirmation is §4's measurement, plus a minimal
control (tiny dynamic-HW conv net → `.ort` Fixed → runs at 64×64, 96×160, 544×960) **[MEAS]**.

**Where fixed shapes *are* required, it is the execution provider, not the format.** ONNX
Runtime's own tooling for this says why it exists: "NNAPI does not support dynamic input
shapes", and "CoreML may have better performance with fixed input shapes"
([make-dynamic-shape-fixed docs](https://onnxruntime.ai/docs/tutorials/mobile/helpers/make-dynamic-shape-fixed.html))
**[DOC]**. Neither applies to the CPU EP this repo's `.ort` runs on. For the browser
specifically, ONNX Runtime Web documents `freeDimensionOverrides` as the supported way to *pin*
a dynamic model's free dimensions at session load — e.g. "if your web app always use a single
image of 224x224, you can override the free dimensions" for performance
([ORT Web env flags and session options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html))
**[DOC]** — which both confirms that dynamic dimensions are a supported input to ORT-web and
provides the per-layout specialization knob if a single dynamic artifact turns out slower than
a fixed one.

One honest caveat on "Fixed" **[DOC]**/**[INF]**: offline-optimized models bake
platform-specific choices — the graph-optimization docs warn that layout-level optimizations
tie the saved model to compatible hardware
([graph optimizations docs](https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html)),
and the converter excludes the x86-specific `NchwcTransformer` for non-amd64 targets for
exactly this reason (`convert_onnx_models_to_ort.py` `_convert`) **[SRC]**. This is a
pre-existing property of the shipped `.ort`, unchanged by `dynamic`.

**The realistic export route, then** **[INF]**: `dynamic=True` is not blocked anywhere in this
chain — a single dynamic artifact with the browser padding each layout's frame up to /32 is
viable on everything measured. Per-layout fixed-size export remains the conservative
alternative; what it buys is freedom from the two things not measured here (WASM behavior at
runtime-varying shapes, and any fixed-shape-only optimization ORT-web might apply), at the cost
of one artifact per layout and a rebuild whenever a layout's extent changes. Given the
`freeDimensionOverrides` escape hatch — ship dynamic, pin per session — the dynamic route risks
little.

## 6. Fixed-scene guidance, and the end2end head's sharp edges

**What the augmentation guide actually says** (quoted exactly, because the paraphrase in
circulation — including in this repo's earlier research note — is looser than the source): "If
the camera's point of view is consistent and won't change once the model is deployed, you can
likely skip geometric transformations such as `rotation`, `translation`, `scale`, `shear`, or
`perspective`."
([data augmentation guide](https://docs.ultralytics.com/guides/yolo-data-augmentation/))
**[DOC]**. On mosaic: "Use the `mosaic` augmentation only if having partially occluded objects
or multiple objects per image is acceptable and does not change the label value. Alternatively,
you can keep `mosaic` active but increase the `close_mosaic` value to disable it earlier."
**[DOC]**. On rotation, the guide's positive case is exactly this task's geometry: "in aerial
drone imagery, vehicles can be oriented in any direction, requiring models to recognize objects
regardless of their rotation" **[DOC]**.

Reading it for this project **[INF]**: the guide's "skip geometric" is a blanket for consistent
viewpoints, but a fixed *camera* is not a fixed *scene* — cars appear at every orientation and
position, so `degrees` and `translate` still earn their keep (the prior note's §5/§6.3 case).
The knob DPT normalization specifically demands is `scale: 0` (default `0.5`,
[`cfg/default.yaml` L122](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/cfg/default.yaml#L122)
**[SRC]**): scale jitter re-blurs the very distribution the normalization sharpened, and with
`scale=0` the size spike survives augmentation intact. Under `rect=True` the mosaic question
answers itself (§2); under uniform-canvas padding it stays a judgment call the guide's occlusion
criterion governs.

**End2end head pitfalls at unusual sizes — none documented, four in source** **[SRC]**:

1. **The anchor floor** (§4): TopK's baked `k=300` makes inputs below ~14.6 kpx a runtime error,
   measured, not theoretical.
2. **`max_det` is sized at export time**: exporting at a small `imgsz` and running large keeps
   the 300-slot ceiling; 300 slots minus #107's up-to-4-boxes-per-car duplication is ~75
   distinct cars, comfortable for this task but a real ceiling
   ([`engine/exporter.py` L863–L869](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L863-L869),
   duplication **[REPO]** #107).
3. **`nms=True` is silently refused for end2end models** ("'nms=True' is not available for
   end2end models. Forcing 'nms=False'.",
   [`engine/exporter.py` L765–L766](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L765-L766))
   — the browser-side rotated-IoU suppression stays mandatory whatever the input geometry.
4. **Ultralytics itself disables end2end under static activation quantization for LiteRT**:
   "Static activation quantization collapses the end2end class-index output; export raw and run
   NMS later"
   ([`engine/exporter.py` L673–L675](https://github.com/ultralytics/ultralytics/blob/v8.4.115/ultralytics/engine/exporter.py#L673-L675))
   — upstream, independent corroboration of the score-collapse failure this repo found in #107
   and guards against with Conv-only quantization **[REPO]**.

Plus the val limitation of §3 (square-only val for static exports), which is where a
rectangular or dynamic pipeline feels the head least expectedly.

---

## What I could not determine

- **In-browser behavior of a dynamic `.ort` under onnxruntime-web's WASM EP.** Every runtime
  measurement here is the native CPU EP via Python. No test environment in this repo can execute
  a real WASM inference (#109 removed the tooling; #114 records the gap), so first-inference
  latency at a new shape, memory-arena growth at 1088×1920-class inputs, and thread behavior
  remain unmeasured. The #115 groundwork already names memory as "the one number here that
  should be measured rather than reasoned about" — that stands, now specifically for the WASM
  arena under the largest per-layout shape.
- **Any documented Ultralytics statement on end2end heads at non-square sizes.** The docs are
  silent; everything in §6 is source-read or repo-measured. The square-val warning is the
  closest thing to an official acknowledgment that rectangular geometry is off the beaten path.
- **Whether `rect=True` training costs accuracy on this task.** The train docs' "may affect
  model accuracy" is unquantified and undated, and the one-variable A/B that could measure it
  here (square vs rect at matched scale, #114's table) has not been run.
- **Whether aspect-sorted, unshuffled batching (§2) measurably hurts on a small multi-layout
  corpus.** Known regularization folklore; no primary measurement found, none run.

---

## Sources

**Official documentation:**
- Ultralytics train mode (arguments: `imgsz`, `rect`, `multi_scale`, `scale`, `mosaic`,
  `close_mosaic`, `degrees`) — <https://docs.ultralytics.com/modes/train/>
- Ultralytics export mode (arguments: `dynamic`, `imgsz`) — <https://docs.ultralytics.com/modes/export/>
- Ultralytics data augmentation guide (fixed-viewpoint and mosaic quotes) —
  <https://docs.ultralytics.com/guides/yolo-data-augmentation/>
- ONNX Runtime ORT-format models (`convert_onnx_models_to_ort`, Fixed vs Runtime) —
  <https://onnxruntime.ai/docs/performance/model-optimizations/ort-format-models.html>
- ONNX Runtime make-dynamic-shape-fixed (NNAPI/CoreML rationale) —
  <https://onnxruntime.ai/docs/tutorials/mobile/helpers/make-dynamic-shape-fixed.html>
- ONNX Runtime graph optimizations (offline-mode hardware caveat) —
  <https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html>
- ONNX Runtime Web env flags and session options (`freeDimensionOverrides`) —
  <https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html>

**Source code (pinned versions this repo runs):** `ultralytics` v8.4.115 —
`data/base.py` (`load_image`, `set_rectangle`), `data/dataset.py` (`build_transforms`),
`data/augment.py` (`Mosaic`, `RandomPerspective`, `LetterBox`, `v8_transforms`),
`data/build.py` (`build_yolo_dataset`), `models/yolo/detect/train.py`, `engine/trainer.py`,
`engine/validator.py`, `engine/predictor.py`, `engine/model.py`, `engine/exporter.py`,
`nn/modules/head.py` (`Detect`, `OBB`), `utils/checks.py` (`check_imgsz`), `cfg/default.yaml` —
all line-anchored above against <https://github.com/ultralytics/ultralytics/tree/v8.4.115>;
`onnxruntime` 1.23.2 — `onnxruntime/tools/convert_onnx_models_to_ort.py`.

**Measurements (this ticket, 2026-08-05):** pinned toolchain (torch 2.2.2, onnxruntime 1.23.2,
Intel i7-7820HQ CPU), weights `detector/runs/tracer-long/weights/best.pt`, calibration/probe
frames from `dataset/yolo/images/train`. Scripts were run from the session scratchpad and are
reproducible from the descriptions in §4–§5; none are checked in.

**This repo:** `detector/train.py`, `detector/export_onnx.py`, `lib/detector/src/letterbox.ts`,
`lib/detector/src/decode.ts`, `docs/research/yolo-detection-accuracy.md`, issues #100, #107,
#109, #112, #113, #114, #115.
