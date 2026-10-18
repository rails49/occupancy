# System

What the repository does now, across its stages. Each package's `README.md` or
`src/index.ts` describes that package; `ui/README.md` describes the UI.
`SPEC.md` describes the target, which this is not.

## The pipeline

Each directory is a stage in one data path. Two branches share one corpus: the
detector path runs, and the classifier path is parked at its first arrow. A
third consumer, `lib/drift`, trains nothing: it derives reference spectra from
the images at load time, and both UI views gate on them (#89).

```
.r49 archives (rails49/r49)         v4: layout photos, calibration, labels
        │
        ├── lib/drift/                   createDriftCheck(images)
        │       ├─▶ ui/rr-live-view       refuse to classify + override   #94
        │       ├─▶ ui/rr-editor-view     warn, never block               #95
        │       └─▶ tools/drift-bench     736 synthetic cases
        │
        ├── dataset/src/yolo_export.ts   labeled_complete gate, OBB spans
        │       ▼
        │   dataset/yolo/                Ultralytics OBB layout, 80/20 by image
        │       │  detector/train.py       YOLO26n-OBB fine-tune from DOTA
        │       ▼
        │   detector/runs/.../best.pt
        │       │  detector/export_onnx.py ONNX → static INT8 → .ort
        │       ▼
        │   detector/models/             detector_int8.ort (not in git)
        │       │
        │       └─▶ lib/detector/         loadDetector → L0 → occupancy() → L1
        │               │
        │               └─▶ ui/           rr-live-view: L0 boxes, sensors   #85
        │
        └── parked: no crop derivation runs (#8, #18)
                ▼
            dataset/data/                144×144 crops, data.csv
                │  classifier/resnet/TRAIN.ipynb   ResNet-18 → ONNX → ORT
                ▼
            classifier/resnet/models/    model_int8.ort + config.json (not in git)
                │
                └─▶ nothing loads it (ADR 0004)
```

The archives live in [`rails49/r49`](https://github.com/rails49/r49), not here
(#63). Its `fixtures/` tree holds six archives, 46 images with calibration and
no labels, below `layout.min_dpt`. They exercise the code and are not training
data.

`dataset/README.md` covers the export and its gates. `detector/README.md`
covers training and export.

## Configuration

`config.yaml` holds the parameters that must agree across stages. The format's
constants (standard gauge, scale ratios, class vocabulary) are in
`@rails49/r49`'s data file (#181). `pnpm config:generate` reads both and writes:

| Output | Tracked? | Read by |
| :--- | :--- | :--- |
| `config.json` | gitignored | the model export |
| `lib/config/src/` | committed | TypeScript in this repository |

`bin/test.sh` regenerates `lib/config` into a temporary tree and fails on a
difference. The generator fails, naming the class, when a `detector.classes`
entry is not in the vocabulary (`ui/tests/generateConfig.test.ts`), and fails
if `classifier.labels` reappears (#8). Python reads `config.yaml` and the
package's data file directly. See ADR 0009.

## Workspace packages

`pnpm-workspace.yaml` covers `lib/*`, `tools/*`, `dataset` and `ui`. The `lib/*`
packages are consumed as TypeScript source; nothing under `lib/` is built or
published. `lib/CLAUDE.md` holds their interface rules. The `.r49` format
package, `@rails49/r49`, comes from npm at the version `pnpm-workspace.yaml`
pins (ADR 0018).

| Package | Described in |
| :--- | :--- |
| `@occupancy/config` | `lib/config/src/index.ts` (generated) |
| `@occupancy/drift` | `lib/drift/src/index.ts` |
| `@occupancy/detector` | `lib/detector/src/index.ts` |
| `@occupancy/classifier` | `lib/classifier/README.md` |

The drift tolerance is `layout.max_drift_track_fraction`. It becomes pixels only
in `ui/src/driftSession.ts`'s `maxDriftPx` (ADR 0013).

## Model files and releases

Model files are gitignored; only the two `models/version.txt` files are
tracked. Publishing a retrained model means bumping `version.txt`, creating a
matching GitHub Release, and uploading `model_int8.ort` and `config.json` as
assets. `bin/test.sh` downloads no model.

The only model that ships is `detector/models/detector_int8.ort` (3.4 MiB).
Vite copies it into the bundle only if it exists; without it the live view
shows a no-model banner and reports every sensor `unknown`. The filename is
written once, in `ui/modelAssets.ts` (`ui/tests/modelAssets.test.ts`).

## Deploy

`bin/deploy.sh` regenerates `config.json`, builds the UI and uploads `ui/dist/`
to the Cloudflare Pages project `occupancy-rails49`. Two checks stop it first:

- `bin/check-deploy-source.sh`: the checkout is a clean `origin/main`
  (`ui/tests/deploySource.test.ts`).
- `bin/check-deploy-dir.sh`, after the build: a one-level inventory of what may appear in the
  deploy directory, no symlinks, no `.r49`/`.pt`/`.onnx`/`.ipynb`, and a 24 MiB
  budget in apparent bytes (#122, `ui/tests/deployGuard.test.ts`).

`ui/vite.config.ts`'s `dropUnfetchableOrtWasm` deletes the second, hashed ORT
binary Rollup emits; `ui/tests/ortAssets.test.ts` pins the places that set
`ort.env.wasm.wasmPaths`. `_headers` ships from `ui/public/`. The app's origin
is `occupancy.rails49.org` (rails49/control#47).
