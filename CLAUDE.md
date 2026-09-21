# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Computer vision suite for model railroaders: camera-based track occupancy detection using CNN image classification. Monorepo at https://github.com/rails49/occupancy.git; UI served at https://occupancy.rails49.org.

**Safety note (from README):** the classifier does sometimes miss rolling stock or report phantom trains. Nothing here should be presented as a safety interlock.

**`SPEC.md` at the root is the requirements document for the whole project** — the `.r49` v4 format, the occupancy output contract, labeling UX, training-data derivation, and the reasoning behind each. It describes the **target**, and parts of it are still unbuilt. Where SPEC and the code disagree, that is the migration, not a bug to fix. This file describes what exists and how to build it; SPEC describes what it is for.

**SPEC § Format is now implemented.** The manifest is **v4** — cars as two-point spans with provenance, sensors per layout, multi-point calibration, `labeled_complete` per image — and `@occupancy/r49` reads and writes nothing else. Every authoring surface the v4 editor asks for is built, but the editor is not finished — see `ui/CLAUDE.md` for its state, GitHub Issues for what is open, and `SPEC.md` § In scope for the still-unresolved proposal interaction. The detector path is now wired end to end: the dataset export and the training/export path run (`dataset/src/yolo_export.ts`, then `detector/`), and **`rr-live-view` loads the detector, draws L0 boxes and reports L1 per sensor** (#85) — the CNN is retained and retrainable but nothing loads it. Archive diagnostics is built too (#87) — a third top-level mode scoring the shipped `.ort` against an archive's labels; `ui/CLAUDE.md` documents it.

**The input geometry is decided but not built** (map #125, decision #130). The pipeline moves to **DPT normalization**: one authored *square* canvas constant replacing `detector.input`, images resampled to a constant DPT and **padded — never resized — onto it**, captures larger than the canvas tiled with overlap exceeding the longest car, detections unioned back into full-frame coordinates. `SPEC.md` § Input geometry holds the reasoning; the code still reads `detector.input: [960, 544]` and `train.py` still passes a square `imgsz`, so this is the migration, not a bug. Two things to know before touching that path:

* **The padding is the mechanism, not a detail.** Ultralytics' `load_image` rescales every image's long side to `imgsz` before any letterbox, so normalizing at capture time and resizing here silently undoes it. Pad, and the rescale becomes a no-op.
* **Nothing here reaches a user.** v4 gains no field, the editor and live view keep drawing in full-frame image pixels, and tiling lives between a frame arriving and `occupancy()` being called. That is also what keeps the decision reversible if #131 picks native single-pass or multi-camera.

The canvas has **no value yet** — bounded below by the `end2end` head's measured anchor floor (`H·W ≥ ~14,629` px) and above by training memory (#128, gated on the M2). `docs/research/ultralytics-variable-size.md` on branch `research/ultralytics-variable-size` is the cited source for every framework claim above, including the measured finding that a *dynamic* export survives the whole INT8 → `.ort` chain at parity — held as a fallback, deliberately not adopted.

**The calibration model is decided but not built** (map #125, decisions #135 and #136). Layouts are not planar and cameras are not at infinity, so under a pinhole camera at height `h` every length at height `z` reads `z/(h−z)` too large — **9.3% at track height under a 1 m camera**, landing in DPT and so in car width, the drift tolerance, the `min_dpt` gate and the resample factor above. `SPEC.md` § Camera height holds the model; `docs/research/camera-calibration.md` on branch `research/camera-calibration` is the cited source and carries every derivation. Four things to know before touching that path:

* **Focal length is not the lever and was rejected as a field.** It cancels from every error term — these are depth ratios — so only camera *height* helps. Its provenance is weak anyway: all three Exif focal tags are optional, and the live `getUserMedia` path has no Exif and no focal length in any API.
* **`h` enters *inside* the least squares**, normalizing each pair by `(h−z)/h`, which is what dissolves the equal-`z` restriction rather than working around it (#103's original complaint). Mixed-height points stop being inert, and `getDPTResidual` validates `h` for free — a wrong `h` normalizes different heights inconsistently, which is exactly what the residual already measures. It is blind when every point sits at one height, so it is a cross-check, never a gate.
* **DPT gains a reference height, and that is the point of the second field.** DPT is *Dots Per Track*; reporting it on a plane with no track is what generated the 9%. Note today's `equalHeightPairs` admits pairs at *any* equal `z`, so a mixed-height set silently blends scales up to 9% apart — latent, since all six fixtures carry two points at z=0, and closed by the new fallback.
* **Scale is corrected; position is not, and images are never warped.** Relief displacement is large (6.3 track gauges at a 2×1 m layout's corner) but latent — nothing maps image↔world positions — so it is specified and deliberately unbuilt. Warping is ruled out permanently: a z=0 warp cannot fix track-height objects, which are the ones being detected.

The response is **warn, in the editor, with no threshold** — the live view never refuses, because a static geometry invalidates nothing the author placed (unlike drift), and refusing would reject every archive that exists. No `max_obliquity` constant is set: the geometry is quantified (an HO car presents **2.6× its nadir width** at a 2×1 m layout's corner under a 1 m camera, 1.8× at 2 m) but its cost to *accuracy* is unmeasured, and inventing the constant would be the substitute gate this file warns against below. `tools/r49-validate` follows its own `dptResidual` precedent — facts in the report, one narrow warning, nothing blocking. **The two fields add no version** (#139): the version marks changes that make an old file *misread* or a new file *lose data*, and an additive optional field is neither — a bump would instead orphan every v4 archive, since `version` is a literal and there is no compatibility shim. They are `.optional()` and deliberately **not** `.default()`, which would inject the key on the first save of any archive the user merely opened. Enforcement is the **editor's**: one declared list of required layout metadata (`scale`, layout `name`, `camera_height_mm`) behind an undismissable settings dialog on create and on any open missing one, plus an `h > max(z)` sanity check — which caught its first unit slip during the grilling, since a single-plane calibration makes the residual blind to exactly that error. One consequence stays open: whether `spanToPolygon`'s constant car width needs an obliquity term (#138, gated on #131).

> ⚠️ **Schema first, then data.** `CalibrationSchema` is `.strict()`, so writing `camera_height_mm` into an archive **before** the schema accepts it breaks every test that loads a fixture *and* the corpus CI, which runs `tools/r49-validate` from this repo's `main`. The six fixtures' height is measured (1150 mm) and waiting on the schema change, not on the measurement.

**Camera-drift detection is built** (map #89): `@occupancy/drift` measures how far the camera has moved from the pose an archive's images were shot in, the live view **refuses to classify** past `layout.max_drift_track_fraction` of a track width with a visible override (#94), reporting the alignment continuously in the stats bar, and the editor **warns without blocking** on a freshly added image (#95). Validation is entirely synthetic — the fixtures were all shot on a tripod, so `tools/drift-bench` warps them — and the recovery flow after a refusal is deliberately unspecified until real usage exists.

## Commands

Run from the repo root unless noted. pnpm workspace + `uv` for Python.

| Task | Command |
| :--- | :--- |
| Full check (typecheck + TS tests + Python lint) | `bin/test.sh` |
| Typecheck all packages | `pnpm typecheck` |
| All TS tests | `pnpm test` |
| Tests for one package | `pnpm --filter @occupancy/r49 test` |
| A single test file | `pnpm --filter @occupancy/ui test tests/marker.test.ts` |
| Watch mode (ui) | `pnpm --filter @occupancy/ui test:watch` |
| The look-rules check (**not** in `bin/test.sh`, by decision) | `pnpm --filter @occupancy/ui test:look` |
| UI dev server | `pnpm --filter @occupancy/ui dev` (HTTPS via self-signed cert; `dev:http` for plain HTTP) |
| Build UI | `pnpm build` |
| Regenerate `config.json` **and `lib/config`** | `pnpm config:generate` (or `bin/generate_config.py`) |
| Deploy to Cloudflare Pages (needs permissions, ask user to run it) | `bin/deploy.sh` |
| Python lint/format/types | `cd <classifier/resnet\|detector> && uv run ruff check . && uv run black --check . && uv run pyright` |
| Derive the detector dataset | `pnpm --filter dataset run export:yolo` (reads `dataset/r49/`, writes `dataset/yolo/`) |
| Score the drift check on the fixtures | `pnpm --filter @occupancy/drift-bench bench` (needs `rails49/r49` cloned at `../r49`; ~10 min for 736 cases) |
| Fine-tune + export the detector | `cd detector && uv run python train.py && uv run python export_onnx.py` |
| Install pre-push hook (runs `bin/test.sh`) | `bin/install-hooks.sh` |

The UI dev server serves over HTTPS by default because `getUserMedia` requires a secure context — a phone on the LAN needs the HTTPS URL. It also sets COOP/COEP headers, required for ONNX Runtime's threaded WASM.

## Architecture

### The pipeline

The whole system is one data path; each directory is a stage in it.

Two branches share one corpus: the **detector** path runs, the **classifier**
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

**The classifier's first arrow does not run; the detector's does.** `dataset/src/yolo_export.ts` derives the Ultralytics OBB dataset straight from the archives — `labeled_complete` is its one hard gate, and everything else that could drop a car (an unmapped class, an uncalibrated archive, a zero-length span) is fatal instead. See `dataset/README.md` and `SPEC.md` § YOLO annotations. Nothing trains from its output yet.

`dataset/src/data_prep.ts` and `dataset/src/online_diagnostics.ts` are **parked stubs** that print their reason and exit non-zero — they derived crops and scored a confusion matrix from v3 point markers, which v4 does not store. Deriving from car spans alone gives every crop the same tag, so the vocabulary collapses to one degenerate class with no negatives. See `SPEC.md` § v4 cannot produce a trainable CNN dataset (issues #8, #18). The documented route back is sampling background crops as verified negatives — an experiment, dormant while the ResNet is. **Do not revive them by inventing a substitute vocabulary or synthesising negatives.**

### `config.yaml` is authored; everything else is generated

`config.yaml` is the single source for parameters that must agree across stages (`crop_size`, normalization mean/std, training hyperparameters, layout and detector constants, scale→ratio table). `pnpm config:generate` emits **two** derived representations from it:

| Output | Tracked? | Consumed by |
| :--- | :--- | :--- |
| `config.json` | **gitignored** — absent on a fresh clone until you generate | the model export |
| `lib/config/src/` | **committed** | `@occupancy/r49`, and TypeScript generally |

`lib/config` is committed precisely so a fresh clone typechecks before anyone runs a generator. **Never hand-edit either output** — edit `config.yaml` and regenerate. `bin/test.sh` regenerates `lib/config` into a temp tree and diffs, so editing `config.yaml` without regenerating fails the full check with the command to run rather than surfacing at runtime.

`@occupancy/r49` derives `STANDARD_GAUGE`, the scale→ratio table, and its scale enum from `lib/config` rather than declaring any of them. That is the point of the package: those constants used to exist in both `config.yaml` and `manifest.schema.ts` with nothing checking that they matched. Python keeps reading `config.yaml` directly and does not consume `lib/config`.

> ⚠️ **`detector.classes` is append-only.** A list position *is* a YOLO class index, so reordering or deleting an entry invalidates trained weights while the file still validates — the one config edit that can break a model with nothing noticing. The generator preserves its order exactly and must keep doing so.

`classifier.labels` is **deleted, not corrected**: it named a four-tag CNN vocabulary v4 cannot produce, and nothing could verify it (`TRAIN.ipynb` takes its labels from the dataset vocab). The generator fails loudly if the key reappears.

### Workspace packages

`pnpm-workspace.yaml` covers `lib/*`, `ui`, `dataset`. The `lib/*` packages are consumed **as TypeScript source** — nothing under `lib/` is built or published.

* `@occupancy/r49` — `.r49` archive parser/serializer (zip of `manifest.json` + images), zod-validated **v4-only** manifest schema, scale geometry (`getDPT`, and `getDPTResidual` — the same least-squares fit's disagreement, in image pixels, which is what makes a mis-typed world coordinate visible instead of silently absorbed into the scale). Loading a v3 archive fails on the version number alone: there is no compatibility shim, because a point marker carries neither extent nor orientation and so cannot be migrated. Its gauge, scale ratios and scale enum come from `@occupancy/config`.
* `@occupancy/drift` — camera-drift detection (#89). `createDriftCheck(refs)` → `check(frame)` → `{ displacementPx, refIndex }` in the reference images' pixels. Block-wise phase correlation with a hand-rolled FFT, dependency-free, one entry point: it runs identically in the browser and in Node because `tools/drift-bench` scores **it** rather than a copy — 736 synthetic cases, AUC 1.000, every legitimate case exactly 0. **It measures and decides nothing**: the verdict is `layout.max_drift_track_fraction` in `config.yaml` — a fraction of a *track width*, converted to pixels in the one place that multiplies it by a DPT (`ui/src/driftSession.ts`'s `maxDriftPx`), because the failure is geometric and an absolute pixel count would have to be re-picked per camera. The live view refuses to classify on it (with an override) and the editor warns without blocking. Correction — homography fitting, fiducials — is out of scope by decision (#12).
* `@occupancy/config` — **generated** from `config.yaml`, committed. Layout and detector constants.
* `@occupancy/uid` — Snowflake-style id generator
* `@occupancy/classifier` — ONNX Runtime classifier; **three entry points**, and the split is load-bearing: `.` exports only `ClassifierConfig`, `./browser` exports `BrowserClassifier`, `./node` exports `NodeClassifier`. This is what keeps `onnxruntime-node` and `sharp` out of the browser bundle. Shared preprocessing math lives in the unexported `BaseClassifier`. **Nothing loads it any more** (#7, #85) — `ui` does not even depend on it — but it stays retrainable and revivable.
* `@occupancy/detector` — the detector runtime and, despite the name, **the car-box package**. `.` is pure: `Detection`, the total `occupancy()` (L1), and the span→box geometry — `carWidthPx` and `spanToPolygon` live here rather than in `dataset` so the width constant that biases boxes toward `occupied` has one home, and so the browser can reach it (`dataset/src/obb.ts` imports `node:crypto` at module top). `./browser` carries the ORT session behind `loadDetector`, a factory so that an unloaded detector is unrepresentable. The letterbox and the `[1, 300, 7]` decode sit in pure modules, tested against synthetic tensors — **no test needs a model file**. The decode also **suppresses duplicate boxes** (#107): `end2end`'s `TopK` selects the top 300 slots but suppresses nothing, so the head emits up to four boxes per car — measured at fp32 and INT8 alike, so quantization is not the cause. `overlap.ts` holds the rotated-box IoU that does it, exported because `ui/src/diagnostics.ts` matches predictions to labels with the same arithmetic.

**Read `lib/CLAUDE.md` before touching anything under `lib/`.** Each package's `src/index.ts` is its interface (explicit exports only, no implementation, no `export *`), TSDoc goes on the declaration rather than the re-export line, and the root `tsconfig.json` deliberately has no `paths` block so `package.json` `"exports"` is the one boundary that binds identically at typecheck and at bundle time.

### UI (`ui/`)

Lit + Shoelace + Vite. Per-component contracts are documented at length in `ui/README.md`; the load-bearing points:

* All custom elements are prefixed `rr-` (railroad). Non-element modules use plain camelCase filenames (`carMarker.ts`, `capture.ts`).
* **The chrome is not this repository's to design** (#148, #149). Four rails49 UIs are bound to the same six values — the band, its ink, the rail, a rail group, the rail button's 44px and the height the rail turns into a strip — and to nothing else; whole components and tool versions are explicitly free. They are decided in `rails49/.github` (ADR-0003, `docs/LOOK.md`) and travel as a **copied file, not a package** (ADR-0005): `ui/look/tokens.css` is that file verbatim, `ui/look/README.md` records the commit, and `ui/look/values.test.ts` asserts that what the UI draws with equals the copy. It never fetches, so it fails only on a local edit, and it sits **outside `ui/tests/` on purpose** — `pnpm test` and therefore `bin/test.sh` do not run it, because falling out of step with a decision taken elsewhere is not a reason to red-light a pull request about something else. This UI's expression of the values is `ui/src/look.ts` plus `COMPACT_MAX_HEIGHT_PX`, which is a number rather than a token because a media query cannot read one. Taking a change means replacing the copy, writing the new commit, and fixing what the test reports.
* `rr-viewer` is shared by both the editor and live views — same component, `src` (image) in one, `stream` (video) in the other. Its media element and SVG overlay resolve to **one box** by construction (#41), so a marker lands on the pixel it names in either mode. It **reports pointer gestures but authors nothing**: typed `rr-pointer-*` events carry image-pixel coordinates, deciding what a gesture means is `rr-editor-view`'s job, and the arithmetic lives in the pure `ui/src/geometry.ts`. The editor's authoring surfaces — calibration points, sensors, car chaining with shared coupler handles, reclassify, the completeness affordance — and their invariants are documented in `ui/CLAUDE.md`.
* `carMarker.ts`, `sensorMarker.ts` and `calibrationMarker.ts` are modules, not custom elements, because custom elements break the SVG namespace inside `<svg>`. Each one's renderer and styles must be used together. `carMarker.ts` draws both the authored car and the detector's L0 box — a detection is the same object seen from the other side, so it shares the ink and the winding rule (#85).
* **Camera drift gates both views, asymmetrically** (#89). `ui/src/driftSession.ts` is the one place that holds a canvas for it — `openDriftCheck(archive)`, `grabPlane(source, w, h)` — because `@occupancy/drift` takes a `GrayPlane` rather than an `ImageData` so Node can call it too. **The pose is defined by one image: `images[0]`, the first thumbnail in the strip** (#118). Every image being a reference, scored as a minimum, let an accepted drifted image widen the accepted pose permanently; position 0 closes that, and the reorder control is what keeps the choice visible — drag a thumbnail to the front and every drift number in the editor re-measures against it. In the **live view** a measurement past `maxDriftPx(dpt)` withholds L1 (every sensor `unknown` / `drift`) while **L0 keeps running**: the boxes are true of the frame they were computed in, and what a moved camera invalidates is their mapping onto sensors authored in the archive's frame — so sensor diamonds sitting off the track beside correct boxes is the statement of *why*. Occupancy is machine-consumable, so refusal is the honest response where a banner is not; the banner carries the number in pixels and track widths plus the "classify anyway" override, which exists because the check's false-positive rate is young, and `rr-stats-bar` carries the measurement *continuously* against the tolerance — the banner is an event, alignment is an instrument, and someone aiming a camera has to watch it move. In the **editor** every image carries its own measurement against the reference — position 0 reads "zero by definition", an image inside tolerance states its number, and one past it earns an amber warning bar; **nothing is blocked**, the `MIN_DPT` precedent. The inside-tolerance row is load-bearing rather than decorative: without it a reorder could re-point the pose with nothing on screen moving. Drift is sampled every few seconds, never per frame, and sampling continues *while* refusing: putting the camera back is the fix, and a gate that stopped measuring could not see it happen.
* The app is entirely client-side: layouts are opened and saved as `.r49` files through the file picker, and inference runs in the browser via ONNX Runtime's WASM backend. There is no backend — don't reintroduce one without discussion.
* **The ORT runtime ships from origin, and every stage of the build depends on that** (#15). `ui/public/_headers` cross-origin-isolates the app's origin so ORT gets more than one WASM thread; `require-corp` then forbids the cross-origin CDN the runtime used to come from. It fits under Cloudflare's 25 MiB limit only because the app imports `onnxruntime-web/wasm` rather than the package root, which would pull the 25.02 MiB jsep (WebGPU/WebNN) binary the `executionProviders: ['wasm']` sessions never use. `ui/ortAssets.ts` names the binary, its Emscripten glue and the copy targets; `bin/check-deploy-dir.sh` repeats the filename because a shell script cannot import it, and `ui/tests/ortAssets.test.ts` is what keeps the two from drifting.
* Vite copies `detector/models/detector_int8.ort` into the bundle **only if that directory exists**, so builds succeed without a local model — the live view then shows a no-model banner and reports every sensor `unknown`. The filename comes from `ui/modelAssets.ts`, never a literal.

### Model files and releases

The model files are gitignored; only the two `models/version.txt` files are tracked. Publishing a retrained model means bumping `version.txt`, creating a matching GitHub Release, and uploading `model_int8.ort` + `config.json` as assets. **`bin/test.sh` does not download them and asserts no accuracy figure** — it runs identically on a clean clone with no model present.

**The detector's `version.txt` says `unreleased`, and the tracer's model must not change that.** It is trained on 46 fixture images below `layout.min_dpt` against a six-image validation split; it exists to prove the pipeline runs, and nothing measures it. Publishing it would ship a model nothing has evaluated, and there is no gate that would catch you — see below.

> **There is no automated model gate.** The marker-driven regression test and its 99.5% threshold were retired with the v4 conversion (issue #17), because v4 deletes the point markers they iterated and the number was a reproducibility check, never a generalization estimate. Nothing currently checks that a model rebuild matches the published one. A real held-out protocol waits on a fresh higher-DPT corpus — see `SPEC.md` § Accuracy. Do not plug the gap with a substitute gate.

**The model that ships is `detector/models/detector_int8.ort` (3.4 MiB)**, and it is the only one — Cloudflare Pages rejects files over 25 MiB, and the CNN's `model_int8.ort` is no longer copied because nothing loads it.

Which model ships is named **once**, in `ui/modelAssets.ts`: `ui/vite.config.ts` and `rr-live-view.ts` both import it, and `ui/tests/modelAssets.test.ts` fails if either writes the filename itself. They used to be two literals, and the gap between a build-time copy target and a run-time fetch is invisible to both the typechecker and the build. The editor loads no model at all (#19).

**`bin/check-deploy-dir.sh` is what a deploy has to get past**, and it is the one guard that checks for *absence* (#122). Every earlier check was one-directional — the ORT binary must be present, no single file over Cloudflare's 25 MiB — and none of them could see 21 MB of corpus archives in the bundle: six files, individually small, ordinary extension, arriving through a symlink the copy dereferenced. So it also holds a **two-level inventory** of what may appear in the deploy directory (two levels because the archives landed at `ui/proto-fixtures/`, inside the subtree the build legitimately writes, where a depth-1 list waves them through), **refuses symlinks anywhere**, forbids `.r49`/`.pt`/`.onnx`/`.ipynb` outright, and enforces a **24 MiB total-size budget** against a bundle measuring 18.0 MiB in apparent bytes (`du` says 25 MB, block-rounding 2000-odd tiny icons — measure it the way the script does). Each of those catches the #122 condition on its own: with the symlink replaced by a copy the inventory still fires, and with the extension disguised too the budget still does, at 38.7 MiB. The inventory stops at two levels because `shoelace/assets/icons/` is 2000 files three levels down — payload buried deeper under an allowed name is the budget's to catch, which is why the budget is load-bearing rather than a nicety. It is a separate script from `bin/deploy.sh` precisely so it can be run against a directory built to fail it — `ui/tests/deployGuard.test.ts` constructs deploy directories and runs it, so the inventory has no second copy to drift from. Note the rsync's `--delete` covers only `ui/`: anything dropped beside it persists across every future deploy, which is how a `.DS_Store` came to be sitting there. `ui/vite.config.ts`'s `dropUnfetchableOrtWasm` deletes the second, hashed copy of that binary Rollup emits for the case where nothing sets `ort.env.wasm.wasmPaths`; the two places that do set it are pinned by `ui/tests/ortAssets.test.ts`.

`bin/test.sh` loops over the two Python projects and skips each **independently** when `uv sync` cannot resolve it; every other Python failure is fatal. The per-project skip matters because they pin torch in opposite directions on purpose — `classifier/resnet` tracks current, `detector` pins 2.2.2 for macOS x86_64 — so on the 2017 laptop the resnet checks skip while the detector's run, and on Apple silicon it will be the other way round. A shared skip would silently drop the checks for whichever project does work.

### Deploy

`bin/deploy.sh` regenerates `config.json`, builds the UI, runs `bin/check-deploy-dir.sh` (below — a refusal there uploads nothing), and pushes `ui/dist/` to the Cloudflare Pages project `occupancy-rails49` via `wrangler`. Credentials come from the environment or 1Password (`op://rails49/Cloudflare Pages/…`).

The app has an origin of its own, `occupancy.rails49.org`, and the deploy directory is the build output itself (rails49/control#47). It used to share the apex with a landing page, which is why it built under a `/ui/` base and staged into a tracked `rails49.org/` directory. The landing page now lives in `rails49/rails49.org`, `_headers` ships from `ui/public/`, and there is no staging copy — so `vite`'s emptying of `dist/` is what keeps unaccounted files out, rather than an `rsync --delete` that only covered part of the tree.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `rails49/occupancy`, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

One document — `SPEC.md` at the repo root — plus the wayfinder maps on GitHub Issues as the decision record. **No `CONTEXT.md` and no `docs/adr/`**, by decision (#9). See `docs/agents/domain.md`.

## Contributing

AGPL-3.0 licensed (`LICENSE`). There is no CLA and no contributor gate on pull requests — contributions are taken under the project's own terms.

The project is AGPL-3.0 because the detector is derived from Ultralytics YOLO, which is AGPL-3.0; trained weights inherit those terms, and a client-side web app distributes them to every visitor. See issue #10 for the full reasoning. Dependency licences (MIT, BSD, Apache-2.0) are all one-way compatible into AGPL-3.0.

## 🛠 Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Deep Learning** | [Fastai](https://docs.fast.ai/), [PyTorch](https://pytorch.org/), [ONNX Runtime](https://onnxruntime.ai/) — `classifier/resnet/`; [Ultralytics](https://docs.ultralytics.com/) YOLO26n-OBB — `detector/` |
| **Frontend** | [Lit](https://lit.dev/), [Shoelace](https://shoelace.style/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/) |
| **Tooling** | [pnpm](https://pnpm.io/), [uv](https://github.com/astral-sh/uv), [Vitest](https://vitest.dev/) |
