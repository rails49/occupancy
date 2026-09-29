# Detector — YOLO26n-OBB

Fine-tunes an oriented-box detector on rolling stock and exports it for the
browser. Sibling of `classifier/resnet/`, with its own `uv` environment — **do
not merge the two**: each locks its own torch against its own framework
(fastai there, Ultralytics here).

Nothing here is published. `SPEC.md` § Accuracy: there is no held-out protocol
and the fixture corpus sits below `layout.min_dpt`, so no number this produces
is a generalization estimate. See `models/version.txt`.

## The path

```bash
# 0. the corpus, and the dataset derived from it
git clone https://github.com/rails49/r49.git ../dataset/r49
pnpm --filter dataset run export:yolo

# 1. fine-tune from the DOTA-pretrained OBB checkpoint
uv run python train.py --epochs 20

# 2. .pt -> ONNX -> static INT8 -> .ort
uv run python export_onnx.py
```

`train.py` writes to `runs/`, `export_onnx.py` to `models/`. Both are
gitignored, exactly as `classifier/resnet/models/` is.

## Three export findings that are easy to rediscover the hard way

**Quantize convolutions only.** Quantizing the whole graph yields a model that
loads, runs, and returns the right `[1, 300, 7]` shape with **every score
zero** — it detects nothing, and nothing errors. The head's last `Concat` fuses
box coordinates (0..960) with scores (0..1) into one output tensor; a single
activation scale has to span both, it gets sized for the coordinates, and the
whole score range lands in the zero bucket. `op_types_to_quantize=["Conv"]`
leaves the head's plumbing in float and costs ~0.5 px of centre agreement
against fp32.

Excluding the head by node name works just as well and is ~0.5 MiB larger, but
it silently degrades to quantizing everything if Ultralytics renumbers its
layers — hence the op-type filter, which depends on no naming convention.

**Static quantization, never dynamic.** Dynamic emits `ConvInteger`, which the
ORT CPU provider does not implement — the model quantizes fine and then refuses
to load. Static emits `QLinearConv`, which it does. Calibration data is
therefore mandatory; the exported training frames are the calibration set,
because static quantization picks activation ranges from what it observes and
calibrating off-distribution costs accuracy silently.

**FP16 is not a rung on this ladder.** There is no FP16 arithmetic path on a
CPU/WASM target, and the conversion fails on a `Resize` type mismatch anyway.
The useful rungs are fp32 and static INT8.

The last two were established in the issue #3 feasibility research
(`docs/research/issue-3-browser-yolo-feasibility.md`, branch
`research/yolo-feasibility`), which ran this whole path on the released DOTA
weights before any of this existed. The first was **not** — that research
checked the output shape, which a collapsed model passes.

Which is why `export_onnx.py` finishes by running fp32 and INT8 over the
calibration frames and comparing detection counts. Loading, running and shape
all pass on a model that detects nothing; only the comparison catches it. On
the tracer weights: fp32 116, INT8 124, whole-graph-quantized **0**.

**Calibration frames are letterboxed, because the browser's are.** Static
quantization fixes its activation ranges on whatever geometry it is shown, so
preprocessing them differently from the deployed path calibrates the model for a
distribution it will never be given. `detector/letterbox.py` is therefore a
second copy of `lib/detector/src/letterbox.ts` — deliberate duplication (issue
#100): sharing nine lines of arithmetic across the language boundary would mean
emitting a *function* from `config.yaml` or shelling out to node mid-quantize,
and both cost more than the copy. `tests/test_letterbox.py` and
`lib/detector/tests/decode.test.ts` assert the same scale and padding for the
same inputs, which is what keeps them together. The fill is `(114, 114, 114)`,
Ultralytics' own, which is what makes the bars in-distribution.

It is worth 2 px of bar per edge on today's 1920x1080 corpus — the detection
counts above went up from 106/115 when the probe frames stopped being stretched
— and 42 px per edge at the intended capture geometry (§ Resolution below).

## Resolution is chosen by geometry

`detector.input` is `[960, 544]`, read from `config.yaml` by both scripts —
Python reads the authored YAML directly and never the generated `lib/config`.

640 is too small, and not because of the weight budget: at that input a track
box lands ~6 px wide, under a single stride-8 P3 cell, so the smallest feature
map cannot represent it. The 25 MiB Cloudflare ceiling is not the binding
constraint here — the INT8 `.ort` comes in around 3.3 MiB, an eighth of it.

The rectangular shape is applied at **export**, not during training:
Ultralytics trains at a single square `imgsz` and letterboxes to it, while the
exported graph is what gets deployed.
