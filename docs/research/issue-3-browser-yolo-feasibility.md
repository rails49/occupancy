# Browser-side YOLO: is it feasible at all?

Written 2026-07-28. Research for [issue #3](https://github.com/iot49/rails49/issues/3), under map
[#2](https://github.com/iot49/rails49/issues/2). Sibling: `docs/research/issue-4-label-derivation.md`
(branch `research/label-derivation`).

No project code was modified by this research.

---

## 1. Verdict

**Yes — comfortably, on every axis the ticket asked about, and it is not close.**

Recommendation: **YOLO26n-OBB**, statically INT8-quantized, converted to `.ort`,
exported at a **rectangular** input matching the 16:9 corpus (start at 960×544).

The four questions, answered with measured numbers:

| Question | Answer | Headroom |
| :-- | :-- | :-- |
| Weight budget vs 25 MiB | **3.33 MiB** measured (`.ort`, INT8, OBB head) | 7.5× under |
| Runs under `onnxruntime-web` WASM? | **Yes — executed, correct output shape** | — |
| Mobile latency | **377.6 ms measured** @960×544 (656 ms @1024²), on a 2017 Intel laptop under WASM single-thread | see §7, §8 |
| Export path | `ultralytics` → ONNX → ORT static quant → `.ort`; parallels `classifier/resnet/` exactly | — |

**Take the OBB head.** It costs **+2.5% file size and ~+1% FLOPs** over the
axis-aligned head at equal input resolution (§5, §6). Against #4's finding that
axis-aligned track boxes are only 14–25% filled, that is not a trade-off — it is
free.

**There is one genuine blocker, and it is not technical: Ultralytics is
AGPL-3.0 and this repo is MIT (§11).** The repo relicensed *away* from GPL-3.0
in commit `e3bf81c` two commits ago. Shipping YOLO26 weights to a browser is
exactly the distribution AGPL bites on. That decision must be made before any
training work starts, because it may change which detector family is on the
table. Everything else in this document is green.

---

## 2. Constraints verified against this repo

Each claim in the ticket was checked in the code rather than taken on trust.

| Ticket claim | Verified | Where |
| :-- | :-- | :-- |
| 100% client-side, no backend | Confirmed | `CLAUDE.md`; `lib/classifier/src/browser.ts` runs `ort.InferenceSession` in-page, `executionProviders: ['wasm']` |
| Cloudflare rejects >25 MiB | Confirmed, and enforced | `bin/deploy.sh` aborts on `find "$DEPLOY_DIR" -type f -size +25M`; Cloudflare docs: "The maximum file size for a single Cloudflare Pages site asset is 25 MiB" |
| `model_int8.ort` (11 MB) ships, not `model.ort` (45 MB) | Confirmed | `ui/vite.config.ts` copies only `{model_int8.ort,config.json}`; `bin/test.sh` sets `MODEL_FILE="model_int8.ort"` |
| ~26 MB of WASM stripped to jsDelivr | Confirmed, with a nuance | `bin/deploy.sh` deletes `*.wasm`; `rr-live-view.ts:101` / `rr-editor-view.ts:92` swap `ort.env.wasm.wasmPaths` to `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.25.1/dist/`. Measured: `ort-wasm-simd-threaded.jsep.wasm` is 25,906,828 B = **24.71 MiB**, i.e. actually *under* 25 MiB; the plain `ort-wasm-simd-threaded.wasm` is 12.22 MiB. The strip is safe but broader than strictly required. |
| Phone on LAN is first-class; HTTPS for `getUserMedia` | Confirmed | `ui/vite.config.ts` loads `@vitejs/plugin-basic-ssl` unless `HTTP=1` |
| Two-endpoint labels give both shapes | Confirmed as a map decision (6); schema is v3 today (`lib/r49/src/manifest.schema.ts` `MarkerSchema` is still `{x, y, type}`) | — |

Corpus geometry, measured directly from `dataset/r49/`:

* Source images are **1920×1080** JPEG.
* All six archives are **HO** scale. Native DPT via `getDPT()`: 19.08 (the three
  `cars *` archives), 18.53 (`catalog-bg`), 17.96 (`lighting`, `simple`).
  Canonical is `cnn.sample_dpt: 20`, so **native pixels ≈ 0.90–0.95 × canonical
  pixels** — the source frames are already within 10% of canonical scale.

This last number matters more than it looks; §7 turns it into the input-resolution
decision.

---

## 3. The decision: oriented, not axis-aligned

#4 handed this ticket the measurement (46 images, 1195 markers, HO throughout):

| | median \|angle\| | tail |
| :-- | --: | :-- |
| track spans | **32°** | 40% beyond 45° |
| stock spans | **4°** | 75% within 15° |

and the resulting AABB fill ratio (OBB area ÷ AABB area) at per-class widths
`stock L=169 w=39`, `track L=240 w=20` in canonical 20-DPT pixels:

| angle | stock | track |
| --: | --: | --: |
| 0° | 1.00 | 1.00 |
| 15° | 0.47 | 0.25 |
| 30° | 0.34 | 0.16 |
| 45° | 0.30 | 0.14 |

**A track AABB at the median orientation is 16% track and 84% background.** On a
layout with parallel tracks at HO spacing, a 32°-rotated track AABB is wide enough
to enclose most of its neighbour. Axis-aligned track boxes in this corpus are
mostly not track.

The counter-argument to an OBB head is normally cost. It does not apply here.
Measured, at equal input resolution:

| | axis-aligned (`yolo26n`) | oriented (`yolo26n-obb`) | delta |
| :-- | --: | --: | --: |
| fp32 ONNX (Ultralytics release) | 9.48 MiB | 9.73 MiB | +2.6% |
| INT8 QDQ ONNX (measured) | 2.99 MiB | 3.05 MiB | +2.0% |
| INT8 QDQ `.ort` (measured) | 3.25 MiB | 3.33 MiB | +2.5% |
| FLOPs per megapixel (from Ultralytics tables) | 13.2 | 13.35 | +1.1% |
| output tensor | `[1, 300, 6]` | `[1, 300, 7]` | +1 float per detection |

The OBB head is one extra angle regression channel and one `Sin`/`Cos` pair in the
decode. The graph diff, measured node-by-node, is +38 nodes on 384 (§6).

> **Decision: the detector consumes oriented boxes, for all classes.**

Uniform rather than per-class, for three reasons. (a) One head is one model, one
release, one `config.json` vocabulary — decision 7's dotted class strings map to
one flat index list either way, and a mixed head is not a thing YOLO exports.
(b) Stock at median 4° is a *degenerate* OBB, not a wrong one; an OBB head loses
nothing on near-axis-aligned objects. (c) Decision 6 stores endpoints, so the
OBB label is the direct encoding of what is stored — the AABB is the lossy
derivation, not the other way round.

Label format is Ultralytics' four-corner polygon,
`class_index x1 y1 x2 y2 x3 y3 x4 y4`, all coordinates normalized 0–1, which the
trainer converts internally to `xywhr`. Generating four corners from
`{p0, p1, per-class width}` is exact and trivial — it is the same rectangle #4
already computes to get the fill ratios above.

---

## 4. Which variant

**YOLO26n-obb.** Three properties decide it, in order of importance.

**(a) It is NMS-free.** This is the one that actually matters for a browser, and
it is verified empirically, not from the marketing table. Reading the ONNX
metadata off Ultralytics' own released `yolo26n-obb.onnx`:

```
meta[end2end] = True
meta[task]    = obb
output: output0 [1, 300, 7]
```

and the op histogram of the graph contains **no `NonMaxSuppression` node**. The
model emits up to 300 final detections directly.

Compare `yolo11n-obb.onnx`, measured the same way: output `[1, 20, 21504]` —
21,504 raw candidates that must be decoded and passed through **rotated** NMS.
Rotated NMS is not an ONNX operator; it would have to be hand-written in
TypeScript over 21k candidates, per frame, on the UI thread. That is a real cost
in code, in latency, and in a whole class of bugs the NMS-free head simply does
not have. It is also the thing that historically makes OBB-in-the-browser
unpleasant.

**(b) Nano is the right size.** The task is 3–4 classes of rigid, high-contrast,
fixed-camera, roughly-known-scale objects. It is far easier than COCO. Sizes, from
Ultralytics' own release assets (exact bytes, `api.github.com`, tag `v8.4.0`):

| model | fp32 `.onnx` | fits 25 MiB at fp32? |
| :-- | --: | :-- |
| `yolo26n-obb` | 9.73 MiB | yes |
| `yolo11n-obb` | 10.49 MiB | yes |
| `yolov8n-obb` | 12.08 MiB | yes |
| `yolo26s-obb` | 37.46 MiB | **no** (needs quantizing) |
| `yolo11s-obb` | 37.23 MiB | **no** (needs quantizing) |

Nano fits before quantization. Small does not, but quantizes to ~11 MiB and would
still fit — so `s` remains a fallback if `n` underfits, at roughly 4× the FLOPs
(55.1 vs 14.0 GFLOPs @1024).

**(c) It is the current, maintained generation.** YOLO26n is 2.4M params / 5.4
GFLOPs at 40.9 mAP, versus YOLO11n at 2.6M / 6.5 / 39.5 — smaller, faster,
better. Ultralytics claims "up to 43% faster CPU ONNX inference" for the nano
variant. My own native measurements agree in direction: `yolo26n-obb` fp32 at
1024² ran 293.5 ms against `yolo11n-obb`'s 317.7 ms single-threaded, and that is
*before* counting the rotated NMS `yolo11n-obb` still owes.

DFL removal is part of why: no `ReduceSum`-over-16-bins decode in the box head.

**Caveat on all sizes above:** these are the 15-class DOTA (OBB) and 80-class COCO
(detect) heads. A 3-class head is marginally smaller. Treat every figure in this
document as an **upper bound**.

---

## 5. Weight budget — measured

Everything below was produced locally on the actual model files, not estimated.
Ultralytics fp32 ONNX downloaded from `github.com/ultralytics/assets` tag
`v8.4.0`; quantization with `onnxruntime==1.23.2`; `.ort` conversion with
`python -m onnxruntime.tools.convert_onnx_models_to_ort`.

| artifact | bytes | MiB | vs 25 MiB |
| :-- | --: | --: | --: |
| `yolo26n-obb.onnx` (fp32, as released) | 10,207,250 | 9.73 | 39% |
| `yolo26n-obb` INT8 QDQ `.onnx` | — | 3.05 | 12% |
| `yolo26n-obb` INT8 QOperator `.onnx` | — | 2.78 | 11% |
| **`yolo26n-obb.int8-qdq.ort`** @1024² | **3,493,032** | **3.33** | **13%** |
| **`yolo26n-obb` INT8 `.ort` @960×544** (recommended, §7) | **3,460,456** | **3.30** | **13%** |
| `yolo26n-obb` INT8 `.ort` @640×384 | 3,443,344 | 3.28 | 13% |
| `yolo26n.int8-qdq.ort` (axis-aligned, for reference) | 3,403,640 | 3.25 | 13% |
| `yolo26n.ort` (fp32, for reference) | 10,047,440 | 9.58 | 38% |
| *(today)* `model_int8.ort` ResNet-18 | — | ~11 | 44% |

**The detector is one third the size of the classifier it would eventually
replace.** Even the fp32 `.ort` fits with 15 MiB to spare, so quantization is a
latency and bandwidth optimization here, not a budget necessity. That is a
materially more comfortable position than the CNN is in today, where
`model.ort` at 45 MB does *not* fit and `model_int8.ort` at 11 MB is the only
option.

Calibration for the static quantization above used 10 real frames from
`lighting.r49` and `simple.r49`, resized to the model input — i.e. the corpus
itself is already an adequate calibration set.

### Two quantization findings worth carrying forward

**Dynamic INT8 quantization does not work for this model, and fails loudly.**
`quantize_dynamic(weight_type=QInt8)` produced a 2.77 MiB model that then refused
to load on the CPU execution provider:

```
NotImplemented: [ONNXRuntimeError] : 9 : NOT_IMPLEMENTED :
Could not find an implementation for ConvInteger(10) node with name '/model.0/conv/Conv_quant'
```

This is exactly what the ORT docs warn about: "it is recommended to use dynamic
quantization for RNNs and transformer-based models, and **static quantization for
CNN models**." Static quantization emits `QLinearConv`, which is implemented;
dynamic emits `ConvInteger`, which is not. Anyone reproducing this must supply
calibration data.

**FP16 is not a useful middle rung here.** `onnxconverter_common.float16` produced
a 4.81 MiB model that failed to load with a type mismatch around a `Resize` node
(`Type (tensor(float)) of output arg ... does not match expected type
(tensor(float16))`). Even if patched, FP16 buys nothing on a CPU/WASM target —
there is no FP16 arithmetic path — so the useful rungs are fp32 and static INT8.
`quantize=16` is a GPU-export option.

---

## 6. Runtime viability — it runs, and this was verified by running it

### Op coverage

The primary-source answer is unambiguous. ONNX Runtime's web tutorial states:

> "All ONNX operators are supported by WASM but only a subset are currently
> supported by WebGL, WebGPU and WebNN."

The WASM backend is the full native CPU EP compiled to WebAssembly, so op coverage
is not a question for it — it is a question only if you reach for WebGPU (§8).

Concretely, the operators `yolo26n-obb` actually requires, extracted from the
`required_operators.config` that `convert_onnx_models_to_ort` generates:

```
ai.onnx;7;Cos,Sin
ai.onnx;10;QLinearMatMul
ai.onnx;11;Conv,TopK
ai.onnx;12;MaxPool
ai.onnx;13;Concat,Flatten,Gather,GatherElements,Mod,Sigmoid,Softmax,Tile,Transpose,Unsqueeze
ai.onnx;14;Add,Div,Mul,Sub
ai.onnx;18;Split
ai.onnx;19;Cast,DequantizeLinear,QuantizeLinear,Reshape,Resize
ai.onnx;20;ReduceMax
com.microsoft;1;FusedConv,FusedMatMul,NhwcMaxPool,QLinearAdd,QLinearConcat,QLinearConv,QLinearMul,QLinearSigmoid,QLinearSoftmax
```

Nothing exotic. The only two ops a reader might flag — `TopK` and `GatherElements`,
which are the NMS-free head's top-300 selection — are core ONNX and are in the
WASM build. `Mod` is the class/index decode. No custom domain, no
`NonMaxSuppression`.

Opset: the released `yolo26n-obb.onnx` is **opset 20 / IR 9**, which ORT ≥1.20
supports (ORT 1.20 maps to opset 21 / IR 10). No version pressure.

### It was actually executed

Loaded and run under `onnxruntime-web@1.25.1`, `executionProviders: ['wasm']`, on
Node v20.5.1 — the same package version `ui/package.json` depends on and the same
version the jsDelivr URL in `rr-live-view.ts` pins.

Machine: **Intel Core i7-7820HQ @ 2.90 GHz** (4 physical / 8 logical cores, 2017
laptop-class). Median of 6 runs after 2 warmups, random input.

| model | input | ORT-web WASM, 1 thread | native ORT CPU, 1 thread | WASM penalty |
| :-- | :-- | --: | --: | --: |
| `yolo26n` fp32 `.onnx` | 640² | 352.8 ms | 91.0 ms | 3.9× |
| `yolo26n` INT8 `.ort` | 640² | **245.3 ms** | 63.4 ms | 3.9× |
| `yolo26n-obb` fp32 `.onnx` | 1024² | 914.5 ms | 293.5 ms | 3.1× |
| `yolo26n-obb` INT8 `.ort` | 1024² | **656.2 ms** | 174.8 ms | 3.8× |
| `yolo11n-obb` fp32 `.onnx` | 1024² | 1126.7 ms | 317.7 ms | 3.5× |

Every one produced the correct output shape (`1x300x7` for OBB, `1x300x6` for
detect, `1x20x21504` for the YOLO11 raw head). **The `.ort` + static-INT8 +
NMS-free-OBB combination loads and executes under the exact runtime this app
ships.** That is the ticket's central question and the answer is a demonstrated
yes.

Two secondary results worth recording:

* **WASM costs a consistent ~3–4× over native ORT CPU** on this hardware. That
  ratio is the single most useful number for projecting to other devices.
* **INT8 is ~30% faster than fp32 under WASM** (245 vs 353 ms), so quantization
  earns its place on latency even though the budget does not require it.

---

## 7. Input resolution is the real design variable

Not the weight budget. Not op coverage. Resolution.

The released OBB models are exported at **1024²** (DOTA aerial imagery), which is
both the wrong aspect ratio for a 1920×1080 frame and more compute than needed.
Letterboxing 16:9 into a square wastes ~44% of the pixels on grey bars, and
Ultralytics' `imgsz` accepts `[h, w]`.

Working out what resolution the *objects* need, using #4's canonical-20-DPT
dimensions and the measured native DPT of ~18–19 (so native ≈ canonical):

| input | scale from 1920×1080 | stock box (px) | track box (px) | megapixels | est. GFLOPs |
| :-- | --: | --: | --: | --: | --: |
| 640×384 | 1/3 | 53 × 12 | 76 × 6 | 0.246 | 3.3 |
| 960×544 | 1/2 | 80 × 18 | 114 × 9.5 | 0.522 | 7.0 |
| 1280×736 | 2/3 | 107 × 25 | 152 × 13 | 0.942 | 12.6 |
| 1024×1024 (as released) | letterboxed | 85 × 20 | 122 × 10 | 1.049 | 14.0 |

*(GFLOPs scaled from the published 14.0 GFLOPs @ 1024² for `yolo26n-obb`, i.e.
13.35 GFLOPs/Mpx. Box dimensions derived from #4's `stock L=169 w=39`,
`track L=240 w=20` at DPT 20, adjusted by the measured native DPT.)*

**At 640×384 the track box is 6 px wide.** YOLO's finest feature level is P3 at
stride 8, so a 6 px track is narrower than a single P3 cell. That is the regime
where small-object recall collapses, and track is precisely the class that most
needs the oriented head. 640 is too small.

**960×544 is the recommendation.** Track lands at ~9.5 px wide — still small but
above one P3 cell — stock at 18 px, and it is half the compute of the released
1024² export.

### These were then measured, not left as projections

`yolo26n-obb.pt` was re-exported at both rectangular sizes with
`model.export(format="onnx", imgsz=[h, w], simplify=True, batch=1)`, statically
quantized against the same 10 corpus frames, converted to `.ort`, and run through
the §6 harness on the same machine:

| input | fp32 `.onnx` | INT8 `.ort` | ORT-web WASM, 1 thread | output |
| :-- | --: | --: | --: | :-- |
| 640×384 | 9.55 MiB | **3.28 MiB** | **186.3 ms** | `1×300×7` |
| **960×544** | 9.61 MiB | **3.30 MiB** | **377.6 ms** | `1×300×7` |
| 960×544 (fp32, for contrast) | 9.61 MiB | — | 605.8 ms | `1×300×7` |
| 1024×1024 (released) | 9.73 MiB | 3.33 MiB | 656.2 ms | `1×300×7` |

Three things this confirms:

* **Rectangular export preserves the NMS-free head.** Output stays `[1, 300, 7]`
  at both sizes. (Ultralytics warns that non-square `imgsz` breaks its `val`
  command; it does not affect export or predict.)
* **960×544 costs 42% less than the released 1024² export** (377.6 vs 656.2 ms)
  while giving the corpus a better pixel budget on the long axis. Ultralytics'
  own summary for the 960×544 export reports **6.9 GFLOPs**, against the 7.0
  predicted in the table above — the FLOPs model is sound.
* **My linear-in-pixels latency extrapolation under-predicted by ~22–24%**
  (predicted ~150 / ~310 ms, measured 186.3 / 377.6 ms). Latency is not purely
  proportional to pixel count; there is fixed per-inference overhead. Anyone
  projecting to other resolutions from these numbers should add that margin
  rather than scaling naively — which is precisely why these rows were measured
  instead of left as arithmetic.

Note the re-export came out at **opset 17**, not the released files' opset 20,
because the local `torch==2.2.2` pin caps it. It loaded and ran under ORT-web
regardless, which widens rather than narrows the compatibility window.

---

## 8. Threading — a production defect this research surfaced

`CLAUDE.md` says the dev server "sets COOP/COEP headers, required for ONNX
Runtime's threaded WASM," and `ui/vite.config.ts` does exactly that.

**Production does not.** `rails49.org/` contains only `index.html` — there is no
Cloudflare Pages `_headers` file anywhere in the repo, and `bin/deploy.sh` does not
create one. So the deployed site is not `crossOriginIsolated`.

ORT-web's documentation is explicit about the consequence:

> "Only when the browser supports WebAssembly multi-threading and
> `crossOriginIsolated` mode is enabled, multi-threading will be enabled."

**Every latency figure that matters for the deployed app is therefore the
single-thread column.** All the numbers in §6 and §7 are already single-thread, so
nothing here is invalidated — but the multi-threaded speedup is currently
unavailable in production and would be free to reclaim.

How much is it worth? Natively, 4 threads gave 2.4–2.7× on this machine
(`yolo26n-obb` INT8: 174.8 → 64.9 ms). Under ORT-web in Node, threading did **not**
engage — 1 and 4 threads were indistinguishable (245.3 vs 244.1 ms), and for the
fp32 model 4 threads was measurably *worse* (610.1 vs 352.8 ms). I could not
determine from Node whether that is a Node-harness artifact or a real ORT-web
behaviour, so **the browser multi-threaded number is unmeasured** and I am not
going to guess at it.

Two follow-ups for whoever picks this up:

1. Add a Pages `_headers` file setting `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp`, matching the dev server. Note
   the interaction with the jsDelivr WASM fetch in `rr-live-view.ts` — under
   `require-corp` that cross-origin subresource must carry CORS/CORP headers.
   jsDelivr does send `Access-Control-Allow-Origin: *`, but this needs verifying
   against the deployed site, not assumed.
2. If threading proves unreliable, **WebGPU is the larger lever** and is now
   broadly available on the phone targets: WebGPU is enabled by default in iOS
   Safari 26+ and Chrome for Android 150+. The catch is the op-coverage quote from
   §6 — only a subset of ops runs on WebGPU, so a WebGPU path needs its own
   verification pass against this specific graph, and needs the `jsep` WASM
   variant (24.71 MiB) rather than the plain one (12.22 MiB). Out of scope for
   this ticket; worth its own.

---

## 9. Export path and repo layout

The pipeline mirrors `classifier/resnet/` closely enough that the existing
conventions transfer with almost no invention. **Every stage below from
`best.pt` onward was executed end-to-end during this research** (on the released
DOTA weights rather than trained ones), so the path is verified, not proposed.

```
dataset/r49/*.r49                     endpoint labels (v4, decision 6)
      │  YOLO exporter — new; emits Ultralytics OBB polygon .txt,
      │  four normalized corners per span from {p0, p1, per-class width},
      │  only from images where labeled_complete is true (decision 8)
      ▼
classifier/yolo/data/                 images/ + labels/, train/val split
      │  ultralytics train  (YOLO26n-obb.pt fine-tune)
      ▼
classifier/yolo/runs/.../best.pt
      │  model.export(format="onnx", imgsz=[544, 960], simplify=True, batch=1)
      ▼
best.onnx  (fp32, opset 20, end2end=True, output [1, 300, 7])
      │  ORT static quantization, calibration = frames from dataset/r49/
      │  (equivalently: export(format="onnx", quantize=8, data=...))
      ▼
best.int8.onnx
      │  python -m onnxruntime.tools.convert_onnx_models_to_ort
      ▼
classifier/yolo/models/detector_int8.ort  +  config.json
      │
      └─▶ ui/  — new BrowserDetector alongside BrowserClassifier
```

Concretely, in this repo's terms:

**Layout.** `classifier/yolo/`, sibling to `classifier/resnet/`, with its own
`pyproject.toml` + `uv.lock` (the resnet env pins fastai; the yolo env pins
ultralytics — do not merge them), its own `models/version.txt`, and `models/`
gitignored exactly as the resnet one is. `bin/test.sh`'s Python block already
hardcodes `cd classifier/resnet`; it would need a loop.

**The four-places rule generalizes to eight.** `CLAUDE.md` warns that which model
ships is named in four places that must agree: `ui/vite.config.ts`,
`rr-live-view.ts`, `rr-editor-view.ts`, `bin/test.sh`'s `MODEL_FILE`, and
`lib/classifier/tests/regression.test.ts`. A second model doubles that. This is
already flagged in map #2's "Not yet specified" as the two-model release problem;
it is real and it is the main integration cost, not the ML.

**`lib/classifier` gains a fourth entry point, or a sibling package.** Per
`lib/CLAUDE.md`, the `./browser` / `./node` split is load-bearing — it keeps
`onnxruntime-node` and `sharp` out of the browser bundle. A detector shares the
ORT session handling and the letterbox math but not the crop-around-a-point math
(`BaseClassifier.getScalingMath` is point-and-DPT-centric and does not generalize
to whole-frame detection). Cleanest is `@occupancy/detector` with the same
three-entry-point shape, rather than widening `@occupancy/classifier`.

**Decision 3 is satisfied by construction.** Both models ship; YOLO is proven in
the live view before the ResNet is retired. At 3.33 MiB + 11 MiB the two together
are still well inside budget, and the CNN's inference path is untouched — the
classifier only ever receives a query point, never an orientation, so an OBB
detector changes nothing about how the CNN is fed.

**`config.json` with two vocabularies** (map #2, open item): decision 7's dotted
strings are the single source. Suggest namespacing — `classifier.labels` stays as
it is, `detector.classes` is generated from the same `config.yaml` set. They
genuinely differ: #8 notes `coupling` is 15.8% of the CNN regression set but has
no place in decision 7's class list, so the two vocabularies will not be equal and
should not be forced to be.

---

## 10. What the ONNX graphs actually contain

Recorded because it is cheap to state and expensive to rediscover. Op histograms
read off the released files with `onnx.load`.

| | `yolo26n` | `yolo26n-obb` | `yolo11n-obb` |
| :-- | --: | --: | --: |
| producer | pytorch 2.10.0 | pytorch 2.10.0 | pytorch 2.9.1 |
| ultralytics version | 8.4.38 | 8.4.38 | 8.3.238 |
| opset / IR | 20 / 9 | 20 / 9 | 22 / 10 |
| input | `[1,3,640,640]` | `[1,3,1024,1024]` | `[1,3,1024,1024]` |
| output | `[1,300,6]` | `[1,300,7]` | `[1,20,21504]` |
| `end2end` metadata | `True` | `True` | *(absent)* |
| nodes / distinct ops | 384 / 24 | 422 / 25 | 356 / 16 |
| `Conv` | 102 | 111 | 97 |
| head-selection ops (`TopK`, `GatherElements`, `Mod`, `ReduceMax`) | present | present | **absent** |
| `Sin`, `Cos` (angle decode) | — | 1, 1 | 1, 1 |
| `NonMaxSuppression` | none | none | none (must be done in JS) |

All three exported with `{'nms': False, 'simplify': True, 'half': False,
'dynamic': False}`. Note that YOLO26's `end2end` head means `nms=False` still
yields final detections — the 300-detection selection is *inside* the graph via
`TopK`, which is why the YOLO11 column has none of those ops and 21,504 raw
candidates instead.

---

## 11. The blocker: AGPL-3.0 vs MIT

This was not in the ticket and it is the only thing standing between this
recommendation and a green light.

**Ultralytics is AGPL-3.0.** Verified two ways: the GitHub API reports
`spdx_id: AGPL-3.0` for `ultralytics/ultralytics`, and every model file I
downloaded carries it in its own ONNX metadata:

```
meta[license] = AGPL-3.0 License (https://ultralytics.com/license)
```

**This repo is MIT** (`LICENSE`, "MIT License, Copyright (c) 2026 Bernhard
Boser"), and it got there deliberately: commit `e3bf81c` — two commits before
`main`'s head — is "Relicense from GPL-3.0 to MIT and drop the CLA." Moving to an
AGPL-encumbered detector would reverse a decision made days ago, and AGPL is
*stronger* copyleft than the GPL that was just dropped.

Ultralytics' own licensing page is explicit on both points that matter:

* "All Ultralytics YOLO trained models fall under the AGPL-3.0 License by
  default" — training your own weights does not escape it.
* Compliance means "publicly releasing the complete corresponding source code for
  the entire derivative work, including the larger application, modifications,
  scripts, configuration files."

A client-side web app **distributes** the model to every visitor. This is the
paradigm case, not an edge case, and it is not rescued by there being no backend —
if anything the absence of a backend makes it plainer distribution rather than the
AGPL's network-use trigger.

Three ways out, none of them free:

1. **Relicense rails49 as AGPL-3.0.** Cheapest technically, reverses `e3bf81c`.
2. **Buy an Ultralytics Enterprise License.** Keeps MIT, costs money, and the
   terms need reading against a hobby-scale open-source project.
3. **Use a non-AGPL detector.** Apache-2.0 candidates, licenses verified via the
   GitHub API: `open-mmlab/mmrotate` (Apache-2.0, and the only one of these with
   real OBB support — RTMDet-R, Oriented R-CNN, rotated FCOS),
   `Megvii-BaseDetection/YOLOX` (Apache-2.0, axis-aligned only),
   `Peterande/D-FINE` (Apache-2.0, axis-aligned only).

Option 3 has a technical cost this document is well placed to price: **none of
those has an NMS-free head.** MMRotate models need rotated NMS, which is not an
ONNX op — MMDeploy supplies it as a TensorRT/custom-op plugin, which is exactly
the thing that does not exist in `onnxruntime-web`. Going Apache means writing
rotated NMS in TypeScript over a few thousand candidates per frame, plus decoding
a raw head. Doable — that is what every pre-YOLO26 browser OBB demo does — but it
is the cost YOLO26n-obb was chosen to avoid.

**I did not evaluate the Apache-2.0 alternatives to the same depth as YOLO26n-obb**
(no size, latency, or op-coverage measurements), because whether they matter
depends entirely on a licensing decision that is not mine to make. If the answer
is "stay MIT and do not pay," that evaluation is the next research ticket, and its
headline question is whether RTMDet-R-tiny quantizes and runs under ORT-web with a
JS rotated-NMS stage inside the same latency envelope.

---

## 12. Not measured, and the experiments that would fix that

Stated plainly rather than guessed at.

1. **Actual phone latency.** Every number here is from an Intel i7-7820HQ under
   Node. A modern phone's single-core throughput is in the same broad range but I
   have no measurement and will not invent one.
   *Experiment:* serve a page that loads `yolo26n-obb.int8-qdq.ort` via ORT-web
   and times 20 `session.run()` calls on a fixed tensor; open it on the target
   phone over the existing HTTPS dev server. About an hour of work, and it needs
   no training, no labels, and no v4 schema — the released DOTA weights answer the
   latency question exactly as well as trained ones would, because latency depends
   on shape, not weights. **This is the highest-value next step and it is
   available today.**
2. **Browser multi-threading.** §8: threading did not engage in Node and the
   production site is not cross-origin isolated. Same harness as (1), run with and
   without COOP/COEP, `numThreads` 1 vs 4.
3. **Accuracy.** Nothing in this document is evidence that a 3-class YOLO26n-obb
   *detects trains well*. mAP on DOTA says nothing about a fixed-camera HO layout.
   That requires v4 relabeling (decision 4) and is downstream of this map.
4. **The right resolution empirically.** §7 argues 960×544 from box sizes and one
   stride threshold. Confirming it means training at 640×384 / 960×544 / 1280×736
   and comparing recall on the track class specifically, which is where the small-
   object limit bites.
5. **INT8 accuracy delta.** The CNN's experience is instructive — `model_int8.ort`
   scores 99.58% against fp32's 99.69%, with the gate at 99.5%, i.e. under one
   sample of headroom. Whatever gate the detector gets should be set with more
   slack than that, and #4's finding that the current regression set is
   train-inclusive (roughly 770 of 963 samples seen during fitting) is a warning
   about how that gate gets built.

---

## 13. Sources

**Primary — Ultralytics**

* [YOLO26 model page](https://docs.ultralytics.com/models/yolo26/) — detect table
  (n: 640 px, 40.9 mAP, 38.9 ± 0.7 ms CPU ONNX, 2.4M params, 5.4 GFLOPs); NMS-free
  one-to-one head with `(N, 300, 6)` output; DFL removal; "up to 43% faster CPU
  ONNX inference" for nano, benchmarked on Intel Xeon @ 2.00 GHz.
* [OBB task](https://docs.ultralytics.com/tasks/obb/) — YOLO26-obb table
  (n: 2.5M params, 14.0 GFLOPs, 1024 px, 52.4 mAP on DOTAv1); internal `xywhr`.
* [YOLO11 model page](https://docs.ultralytics.com/models/yolo11/) — detect table
  (n: 2.6M, 6.5 GFLOPs, 56.1 ± 0.8 ms).
* [Export mode](https://docs.ultralytics.com/modes/export/) — ONNX arguments
  `imgsz, quantize, dynamic, simplify, opset, nms, batch, data, fraction, device`;
  quantization support FP32/FP16/INT8; "INT8 uses ONNX Runtime static quantization
  and calibration data."
* [ONNX integration](https://docs.ultralytics.com/integrations/onnx/) —
  `model.export(format="onnx", quantize=8, data="coco8.yaml")`; "ONNX can run
  directly in web browsers"; `simplify` on by default via onnxslim.
* [OBB dataset format](https://docs.ultralytics.com/datasets/obb/) —
  `class_index x1 y1 x2 y2 x3 y3 x4 y4`, normalized 0–1.
* [Licensing](https://www.ultralytics.com/license) — AGPL-3.0 by default;
  "All Ultralytics YOLO trained models fall under the AGPL-3.0 License by
  default"; enterprise required otherwise.
* [`ultralytics/assets` release `v8.4.0`](https://github.com/ultralytics/assets/releases/tag/v8.4.0)
  — exact byte sizes of the released `.onnx` and `.pt` files, read via
  `api.github.com`.

**Primary — ONNX Runtime**

* [Web tutorial](https://onnxruntime.ai/docs/tutorials/web/) — "All ONNX operators
  are supported by WASM but only a subset are currently supported by WebGL,
  WebGPU and WebNN."
* [Env flags and session options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
  — "Only when the browser supports WebAssembly multi-threading and
  `crossOriginIsolated` mode is enabled, multi-threading will be enabled";
  `numThreads` default 0 → min(hardwareConcurrency/2, 4).
* [Quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)
  — "use dynamic quantization for RNNs and transformer-based models, and static
  quantization for CNN models"; QOperator vs QDQ formats.
* [ORT format models](https://onnxruntime.ai/docs/performance/model-optimizations/ort-format-models.html)
  — `python -m onnxruntime.tools.convert_onnx_models_to_ort`; Fixed vs Runtime
  optimization styles; ORT format version compatibility table.
* [Compatibility](https://onnxruntime.ai/docs/reference/compatibility.html) —
  ORT 1.20 → ONNX 1.16.1, opset 21, IR 10.

**Primary — Cloudflare**

* [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) —
  "The maximum file size for a single Cloudflare Pages site asset is 25 MiB";
  20,000 files (Free) / 100,000 (paid).

**Primary — this repo**

`CLAUDE.md`, `lib/CLAUDE.md`, `bin/deploy.sh`, `bin/test.sh`, `ui/vite.config.ts`,
`ui/src/rr-live-view.ts`, `ui/src/rr-editor-view.ts`, `lib/classifier/src/browser.ts`,
`lib/classifier/src/base.ts`, `lib/r49/src/manifest.schema.ts`, `config.yaml`,
`LICENSE`, `rails49.org/`, `dataset/r49/*.r49`, commit `e3bf81c`.

**Secondary / corroborating**

* Third-party ORT-web YOLO demos, cited only as existence proof that the
  combination is routinely deployed, not for any number in this document:
  [Hyuto/yolov8-onnxruntime-web](https://github.com/Hyuto/yolov8-onnxruntime-web),
  [nomi30701/yolo-multi-task-onnxruntime-web](https://github.com/nomi30701/yolo-multi-task-onnxruntime-web).
* [caniuse: WebGPU](https://caniuse.com/webgpu) — iOS Safari 26+, Chrome for
  Android 150+, enabled by default.
* Licenses of Apache-2.0 alternatives read from the GitHub API:
  [mmrotate](https://github.com/open-mmlab/mmrotate),
  [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX),
  [D-FINE](https://github.com/Peterande/D-FINE).

**Measurement environment.** Intel Core i7-7820HQ @ 2.90 GHz (4 physical / 8
logical), macOS 13.7.8, Node v20.5.1, `onnxruntime==1.23.2` (Python),
`onnxruntime-web@1.25.1` (Node/WASM), `onnx==1.22.0`, `onnxconverter-common`,
`ultralytics==8.4.109` on `torch==2.2.2` (the last macOS x86_64 build) for the
rectangular re-exports. Latency is the median of 6 timed runs after 2 warmups on
random input. Calibration data for static quantization: 10 frames extracted from
`lighting.r49` and `simple.r49`. `yolo26n-obb` fused summary as reported by
Ultralytics: 132 layers, **2,449,332 parameters**, 6.9 GFLOPs at 960×544.
