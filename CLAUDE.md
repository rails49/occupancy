# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Computer vision suite for model railroaders: camera-based track occupancy detection with an oriented-box object detector. Monorepo at https://github.com/rails49/occupancy.git; UI served at https://occupancy.rails49.org.

Safety note: the detector does sometimes miss rolling stock or report phantom trains. Nothing here may be presented as a safety interlock.

Each document has one job ([ADR 0001](docs/adr/0001-glossary-and-adrs-alongside-the-spec.md)). `CONTEXT.md` defines the terms. `docs/adr/` records the decisions. `SPEC.md` holds the requirements; it describes the target, and parts of it are not built. Where `SPEC.md` and the code disagree, that is the planned migration, not a bug to fix. This file describes what exists and how to build, test and deploy it.

## Status

**SPEC § Format is now implemented.** The manifest is **v4** — cars as two-point spans with provenance, sensors per layout, multi-point calibration, `labeled_complete` per image — and `@occupancy/r49` reads and writes nothing else.

* Editor: every authoring surface v4 asks for is built, but the editor is not finished. See `ui/CLAUDE.md`, the open GitHub Issues, and `SPEC.md` § In scope, still unresolved.
* Detector path: runs end to end. `dataset/src/yolo_export.ts` derives the dataset, `detector/` trains and exports, and `rr-live-view` loads the detector, draws L0 boxes and reports L1 per sensor (#85). The CNN is retained and retrainable; nothing loads it ([ADR 0004](docs/adr/0004-one-model-in-the-live-path.md)).
* Archive diagnostics (#87): a third top-level view that scores the shipped `.ort` against an archive's labels. See `ui/CLAUDE.md`.
* Input geometry: decided, not built ([ADR 0014](docs/adr/0014-dpt-normalized-input-padded-never-resized.md), #172). The code still reads `detector.input: [960, 544]`, and `train.py` still passes a square `imgsz`. The canvas size is not set; #128 measured the M2's training memory ceiling. On that path, pad and never resize. The framework facts are cited in `docs/research/ultralytics-variable-size.md` on branch `research/ultralytics-variable-size`.
* Camera height: built ([ADR 0015](docs/adr/0015-camera-height-corrects-scale.md), #143, #144). `CalibrationSchema` accepts `camera_height_mm` and `reference_height_mm`, `getDPT` corrects for height, and the editor's settings dialog requires a camera height above the tallest calibration point (`ui/src/requiredMetadata.ts`, reading `calibrationFit`'s `cameraHeightFits`). `tools/r49-validate` reports obliquity. Not built: `dptAtHeight`, the editor's DPT-bar height states, its obliquity advisory and the suggested height (`SPEC.md` § Camera height). The two fields take no zod `.default()` ([ADR 0008](docs/adr/0008-v4-only-and-optional-fields-add-no-version.md)). The live view never refuses on obliquity, and no `max_obliquity` constant is set until something measures what obliquity costs ([ADR 0007](docs/adr/0007-no-automated-model-gate.md)). Open: whether the span-to-box width needs an obliquity term (#138). Derivations are in `docs/research/camera-calibration.md` on branch `research/camera-calibration`.
* Camera drift: built ([ADR 0013](docs/adr/0013-drift-is-measured-against-the-first-image.md), map #89, #94, #95); see UI below. Validation is synthetic: `tools/drift-bench` warps the fixtures. What happens after a refusal is unspecified.

## Commands

Run from the repo root unless noted. pnpm workspace + `uv` for Python.

gate: bin/test.sh

| Task | Command |
| :--- | :--- |
| Full check (typecheck + TS tests + look-check + UI build + Python lint) | `bin/test.sh` |
| Typecheck all packages | `pnpm typecheck` |
| All TS tests | `pnpm test` |
| Tests for one package | `pnpm --filter @occupancy/r49 test` |
| A single test file | `pnpm --filter @occupancy/ui test tests/carMarker.test.ts` |
| Watch mode (ui) | `pnpm --filter @occupancy/ui test:watch` |
| The chrome check alone | `ui/node_modules/.bin/look-check ui/src ui/index.html` |
| UI dev server | `pnpm --filter @occupancy/ui dev` (HTTPS via self-signed cert; `dev:http` for plain HTTP) |
| Build UI | `pnpm build` |
| Regenerate `config.json` and `lib/config` | `pnpm config:generate` (or `bin/generate_config.py`) |
| Deploy to Cloudflare Pages (needs permissions, ask user to run it) | `bin/deploy.sh` |
| Python lint/format/types | `cd <classifier/resnet\|detector> && uv run ruff check . && uv run black --check . && uv run pyright` |
| Derive the detector dataset | `pnpm --filter dataset run export:yolo` (reads `dataset/r49/`, writes `dataset/yolo/`) |
| Score the drift check on the fixtures | `pnpm --filter @occupancy/drift-bench bench` (needs `rails49/r49` cloned at `../r49`; ~10 min for 736 cases) |
| Fine-tune + export the detector | `cd detector && uv run python train.py && uv run python export_onnx.py` |
| Install pre-push hook (runs `bin/test.sh`) | `bin/install-hooks.sh` |

The UI dev server serves HTTPS by default because `getUserMedia` needs a secure context; a phone on the LAN needs the HTTPS URL. It also sets the COOP/COEP headers that ONNX Runtime's threaded WASM needs.

## Architecture

### The pipeline

The whole system is one data path; each directory is a stage in it.

Two branches share one corpus: the detector path runs, the classifier
path is parked at its first arrow.

The archives feed a third consumer that trains nothing: `lib/drift` derives
reference spectra from the images at load time and both UI surfaces gate on them
(#89). It is off the training path entirely — no model, no export, no artifact.

```
.r49 archives (rails49/r49)         v4: layout photos, calibration, labels
        │
        ├── lib/drift/                   ✓ RUNS  createDriftCheck(images)
        │       │                        block phase correlation, nothing stored
        │       ├─▶ ui/rr-live-view       refuse to classify + override   ✓ #94
        │       ├─▶ ui/rr-editor-view     warn, never block               ✓ #95
        │       └─▶ tools/drift-bench     736 synthetic cases, AUC 1.000
        │
        ├── dataset/src/yolo_export.ts   ✓ RUNS  (labeled_complete gate, OBB spans)
        │       ▼
        │   dataset/yolo/                Ultralytics OBB layout, 80/20 by image
        │       │  detector/train.py       (YOLO26n-OBB fine-tune from DOTA)
        │       ▼
        │   detector/runs/.../best.pt
        │       │  detector/export_onnx.py (ONNX → static INT8 → .ort)
        │       ▼
        │   detector/models/             detector_int8.ort  (NOT in git, NOT released)
        │       │
        │       └─▶ lib/detector/         loadDetector → L0 → occupancy() → L1
        │               │
        │               └─▶ ui/           rr-live-view: dashed L0 boxes, sensors
        │                                 coloured occupied/clear/unknown  ✓ #85
        │
        └── ✗ PARKED — no crop derivation runs today (see below)
                ▼
            dataset/data/                144×144 crops, 80/20 split, data.csv
                │  classifier/resnet/TRAIN.ipynb   (Fastai ResNet-18 → ONNX → ORT)
                ▼
            classifier/resnet/models/    model_int8.ort + config.json  (NOT in git)
                │
                └─▶ ✗ nothing loads it — retained and retrainable (#7, #85)
```

### The archives live in another repository

**There are no `.r49` files in this repo any more** (#63). The corpus is
[`rails49/r49`](https://github.com/rails49/r49): submissions arrive there by pull request under CC BY 4.0, and its CI checks them out of a `rails49` checkout at `main` and runs `tools/r49-validate` from it. See issue #54 for the whole design.

> ⚠️ **This repository must stay public, or the corpus's CI breaks.** Its workflow does `actions/checkout` on `rails49/occupancy`, and `GITHUB_TOKEN` is scoped to the repository running the workflow — a public repo's token 404s on a private one. No token fixes it either: every contributor submission is a **fork** pull request, and GitHub passes no secrets to those, so a PAT would work for the maintainer's own branches and fail for every real contributor. This was found the hard way in #74, and it is invisible from inside this repo — nothing here goes red.

The six archives this repo used to carry moved to that repo's `fixtures/` tree — 46 images, real calibration, **zero labels**, DPT 18.0–19.1. They were converted from v3 once, in place, by a throwaway script deleted with the conversion (#22); all 1195 v3 point markers were **dropped, not promoted**, because a point carries neither extent nor orientation and any promotion would be fabricated geometry entering the corpus. Both the originals and the converted copies stay recoverable from this repo's git history — the deletion reclaims no weight, since every version is already in `.git`.

> They are **fixtures, not training data**, which is why they sit outside `archives/` over there. Below `layout.min_dpt`, zero labels: no number derived from them predicts model accuracy. Training will use the corpus's real submissions.

The conversion's regression guard is **retired** (#67) — its job ended with the conversion, and its zero-labels assertions blocked the relabeling the six exist for. What stands in its place is a different kind of test: `lib/r49/tests/fixtures/format-v4.r49`, a tiny **frozen** archive written once and never regenerated, which catches the writer-and-parser-drifting-together failure a symmetric round-trip test structurally cannot see. Do not regenerate it — if it fails to load, that is a v4 break needing a version bump.

`dataset/src/yolo_export.ts` derives the Ultralytics OBB dataset from the archives. `labeled_complete` is its one gate; anything else that could drop a car (an unmapped class, an uncalibrated archive, a zero-length span) is fatal. See `dataset/README.md` and `SPEC.md` § YOLO annotations.

`dataset/src/data_prep.ts` and `dataset/src/online_diagnostics.ts` are parked stubs that print their reason and exit non-zero. They worked from v3 point markers, which v4 does not store; see `SPEC.md` § v4 cannot produce a trainable CNN dataset (#8, #18). Do not revive them by inventing a substitute vocabulary or synthesising negatives.

### `config.yaml` is authored; everything else is generated

`config.yaml` is the single source for parameters that must agree across stages (`crop_size`, normalization mean/std, training hyperparameters, layout and detector constants). The .r49 format's own constants — the standard gauge, the scale→ratio table and the class vocabulary — are authored in `lib/r49/r49.json` instead (ADR 0018, #181), and the generator reads them from there. `pnpm config:generate` emits two derived representations from the two:

| Output | Tracked? | Consumed by |
| :--- | :--- | :--- |
| `config.json` | gitignored; absent on a fresh clone until you generate | the model export |
| `lib/config/src/` | committed, so a fresh clone typechecks | TypeScript in this repository |

Never hand-edit either output; edit `config.yaml` and regenerate ([ADR 0009](docs/adr/0009-config-yaml-is-authored-and-classes-is-append-only.md)). `bin/test.sh` regenerates `lib/config` into a temp tree and diffs, and fails with the command to run.

`@occupancy/r49` reads `STANDARD_GAUGE`, the scale→ratio table, its scale enum and the vocabulary from its own `r49.json` rather than declaring any of them, and depends on neither `@occupancy/config` nor anything else that stays in this repository — so it can move to `rails49/r49` as a straight copy. The generator emits the same values into `lib/config` for occupancy's own consumers, and **fails, naming the class, when a `detector.classes` entry is not in the vocabulary** (`ui/tests/generateConfig.test.ts`): the two files are authored apart now, so nothing else sees both. Python keeps reading `config.yaml` directly (and `r49.json` for the gauge) and does not consume `lib/config`.

> ⚠️ `detector.classes` is append-only. Never reorder or delete an entry ([ADR 0009](docs/adr/0009-config-yaml-is-authored-and-classes-is-append-only.md)). The generator keeps the order and must keep doing so.

`classifier.labels` is deleted (#8). The generator fails if the key reappears.

### Workspace packages

`pnpm-workspace.yaml` covers `lib/*`, `ui`, `dataset`. The `lib/*` packages are consumed as TypeScript source; nothing under `lib/` is built or published.

* `@occupancy/r49` — `.r49` archive parser/serializer (zip of `manifest.json` + images), zod-validated **v4-only** manifest schema, scale geometry (`calibrationFit`, the least-squares fit as one result: DPT, the residual in image pixels, the pairs used, the points left out and why, and whether the camera height clears every point; `getDPT` and `getDPTResidual` read from it. The residual is what makes a mis-typed world coordinate visible instead of absorbed into the scale). Loading a v3 archive fails on the version number alone: there is no compatibility shim, because a point marker carries neither extent nor orientation and so cannot be migrated. Its gauge, scale ratios, scale enum and vocabulary come from its own `r49.json`, and it exports `isSegmentPrefix`, the rule a class is matched by. `detectorClassIndex` is `@occupancy/detector`'s, because the class list it indexes is this project's.
* `@occupancy/drift` — camera-drift detection (#89). `createDriftCheck(refs)` → `check(frame)` → `{ displacementPx, refIndex }` in the reference image's pixels. Block-wise phase correlation with a hand-rolled FFT, no dependencies, one entry point. `tools/drift-bench` scores this module, not a copy: 736 synthetic cases, AUC 1.000. It measures and decides nothing. The tolerance is `layout.max_drift_track_fraction` in `config.yaml`, converted to pixels only in `ui/src/driftSession.ts`'s `maxDriftPx` ([ADR 0013](docs/adr/0013-drift-is-measured-against-the-first-image.md)).
* `@occupancy/config` — generated from `config.yaml`, committed. Layout and detector constants.
* `make_id`, the Snowflake-style id generator, is exported by `@occupancy/r49` (#181) — `@occupancy/uid` was folded into it so the format package stands on its own.
* `@occupancy/classifier` — ONNX Runtime classifier with three entry points: `.` exports only `ClassifierConfig`, `./browser` `BrowserClassifier`, `./node` `NodeClassifier`. Keep the split; it keeps `onnxruntime-node` and `sharp` out of the browser bundle. Shared preprocessing is in the unexported `BaseClassifier`. `ui` does not depend on it ([ADR 0004](docs/adr/0004-one-model-in-the-live-path.md)).
* `@occupancy/detector` — the detector runtime and the car-box geometry. `.` is pure: `Detection`, the total `occupancy()` (L1), and `carWidthPx` and `spanToPolygon`, the one home of the car width. They are here rather than in `dataset` so the browser can reach them (`dataset/src/obb.ts` imports `node:crypto`). `./browser` has the ORT session behind the `loadDetector` factory. The letterbox and the `[1, 300, 7]` decode are pure modules tested against synthetic tensors; no test needs a model file. The decode suppresses duplicate boxes, which the `end2end` head emits (#107). `overlap.ts` holds the rotated-box IoU, which `ui/src/diagnostics.ts` also uses.

Read `lib/CLAUDE.md` before touching anything under `lib/`. Each package's `src/index.ts` is its interface (explicit exports only, no implementation, no `export *`), TSDoc goes on the declaration, and the root `tsconfig.json` has no `paths` block, so `package.json` `"exports"` is the only boundary.

### UI (`ui/`)

Lit + Shoelace + Vite. `ui/README.md` documents each component's contract and `ui/CLAUDE.md` the rules behind them.

* Custom elements are prefixed `rr-`. Non-element modules use camelCase filenames (`carMarker.ts`, `capture.ts`).
* The chrome is `@rails49/look`'s (#161): the band, the rail, the dialog shell and the Shoelace theme layer, a git dependency pinned to a tag. `rr-app` declares them on look's elements, every component puts `lookTheme` first in its `static styles`, and `look-check` in `bin/test.sh` fails on app code that styles the chrome.
* The work panes follow the theme (#151). Every pane surface and ink is an `--sl-*` token. `ui/tests/theme.test.ts` fails on any hex literal in a pane module. The few allowed exceptions are listed in `ui/CLAUDE.md` § Shoelace.
* `rr-viewer` serves the editor (`src`, an image) and the live view (`stream`, video). Its media and SVG overlay resolve to one box (#41). It reports pointer gestures in image pixels and authors nothing. `EditSession` decides what a gesture means ([ADR 0017](docs/adr/0017-editing-rules-live-in-a-session-not-the-editor.md)), and the arithmetic is in `ui/src/geometry.ts`.
* `carMarker.ts`, `sensorMarker.ts` and `calibrationMarker.ts` are modules, not custom elements, because custom elements break the SVG namespace inside `<svg>`. Use each one's renderer and styles together. `carMarker.ts` draws both the authored car and the detector's L0 box (#85).
* Camera drift gates both views ([ADR 0013](docs/adr/0013-drift-is-measured-against-the-first-image.md), #89). `ui/src/driftSession.ts` is the only place that holds a canvas for it. The reference is `images[0]`; reordering the thumbnails re-measures every image (#118). In the live view, past `maxDriftPx(dpt)` every sensor reads `unknown` / `drift` while L0 keeps running; the banner carries the override and `rr-stats-bar` shows the measurement continuously. The editor shows each image's measurement, including those inside the tolerance, and warns past it, blocking nothing. Keep the inside-tolerance row: it is what shows a reorder re-pointing the pose (#118). Drift is sampled every few seconds, and sampling continues while the live view refuses.
* The app is client-side only. Layouts are opened and saved as `.r49` files through the file picker, and inference runs in the browser on ONNX Runtime's WASM backend. Don't add a backend without discussion.
* The ORT runtime ships from origin ([ADR 0006](docs/adr/0006-the-onnx-runtime-ships-from-origin.md)). Anything the app fetches must come from origin. Import `onnxruntime-web/wasm`, never the package root. `ui/ortAssets.ts` names the binary, its Emscripten glue and the copy targets; `bin/check-deploy-dir.sh` repeats the filename, and `ui/tests/ortAssets.test.ts` keeps the two in step.
* Vite copies `detector/models/detector_int8.ort` into the bundle only if it exists, so builds succeed without a local model. The live view then shows a no-model banner and reports every sensor `unknown`.

### Model files and releases

The model files are gitignored; only the two `models/version.txt` files are tracked. Publishing a retrained model means bumping `version.txt`, creating a matching GitHub Release, and uploading `model_int8.ort` + `config.json` as assets. `bin/test.sh` downloads no model and runs the same on a clean clone.

The detector's `version.txt` says `unreleased`. Keep it so for the current model: it is trained on the 46 fixture images and nothing measures it.

There is no automated model gate ([ADR 0007](docs/adr/0007-no-automated-model-gate.md)). Do not add a substitute.

The only model that ships is `detector/models/detector_int8.ort` (3.4 MiB). Cloudflare Pages rejects files over 25 MiB.

The model filename is named once, in `ui/modelAssets.ts`. `ui/vite.config.ts` and `rr-live-view.ts` import it, and `ui/tests/modelAssets.test.ts` fails if either writes the filename itself. The editor loads no model (#19).

`bin/check-deploy-dir.sh` is what a deploy must pass, and it is the one guard that checks for absence (#122). It holds a two-level inventory of what may appear in the deploy directory, refuses symlinks anywhere, forbids `.r49`/`.pt`/`.onnx`/`.ipynb`, and enforces a 24 MiB total-size budget. The bundle measures 18.0 MiB in apparent bytes; `du` says 25 MB, so measure the way the script does. Payload deeper than two levels is the budget's to catch. `ui/tests/deployGuard.test.ts` builds deploy directories and runs the script. `ui/vite.config.ts`'s `dropUnfetchableOrtWasm` deletes the second, hashed ORT binary Rollup emits for the case where nothing sets `ort.env.wasm.wasmPaths`; `ui/tests/ortAssets.test.ts` pins the places that set it.

`bin/test.sh` runs `uv sync` and the lint, type and test checks for both Python projects; any failure, including a `uv sync` that cannot resolve, is fatal. Both track current torch on Apple silicon (#154).

### Deploy

`bin/deploy.sh` refuses to run unless the checkout is a clean `origin/main` (`bin/check-deploy-source.sh`, tested by `ui/tests/deploySource.test.ts`). It then regenerates `config.json`, builds the UI, runs `bin/check-deploy-dir.sh` (a refusal there uploads nothing), and pushes `ui/dist/` to the Cloudflare Pages project `occupancy-rails49` via `wrangler`. Credentials come from the environment or 1Password (`op://rails49/Cloudflare Pages/…`).

The app has its own origin, `occupancy.rails49.org`, and the deploy directory is the build output (rails49/control#47). `_headers` ships from `ui/public/`. Vite empties `dist/` on each build, which keeps stray files out.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `rails49/occupancy`, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single context: `CONTEXT.md` (glossary) and `docs/adr/` (decisions) at the repo root, with `SPEC.md` for requirements and GitHub issues as the full record. See `docs/agents/domain.md`.

## Contributing

AGPL-3.0 licensed (`LICENSE`), because the detector is fine-tuned from AGPL weights ([ADR 0003](docs/adr/0003-agpl-because-the-detector-is-fine-tuned-from-agpl-weights.md)). There is no CLA and no contributor gate on pull requests. Dependency licences (MIT, BSD, Apache-2.0) are all one-way compatible into AGPL-3.0.

## 🛠 Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Deep Learning** | [Fastai](https://docs.fast.ai/), [PyTorch](https://pytorch.org/), [ONNX Runtime](https://onnxruntime.ai/) — `classifier/resnet/`; [Ultralytics](https://docs.ultralytics.com/) YOLO26n-OBB — `detector/` |
| **Frontend** | [Lit](https://lit.dev/), [Shoelace](https://shoelace.style/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/) |
| **Tooling** | [pnpm](https://pnpm.io/), [uv](https://github.com/astral-sh/uv), [Vitest](https://vitest.dev/) |
