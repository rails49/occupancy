# System

What the repository does now, across its stages. Each package's `README.md` or
`src/index.ts` describes that package; `ui/README.md` describes the UI.
`SPEC.md` describes the target, which this is not.

## The pipeline

Each directory is a stage in one data path. The detector is trained in
[rails49/detector](https://github.com/rails49/detector) and reaches the UI as
the `@rails49/detector` package; its own stages are in rails49/detector's
[`docs/SYSTEM.md`](https://github.com/rails49/detector/blob/main/docs/SYSTEM.md#the-pipeline).
`lib/drift` trains nothing: it derives reference spectra from the images at
load time, and the live view gates on them (#89). The editor does not (#252).

```
.r49 archives (rails49/r49)         v4: layout photos, calibration, labels
        │
        ├── lib/drift/                   createDriftCheck(images)
        │       ├─▶ ui/rr-live-view       refuse to classify + override   #94
        │       └─▶ tools/drift-bench     736 synthetic cases
        │
        └── rails49/detector             training-data export, training, model
                │
                └─▶ @rails49/detector     loadDetector → L0
                        │
                        └─▶ ui/           occupancy() → L1; rr-live-view: L0 boxes, sensors   #85
```

The archives live in [`rails49/r49`](https://github.com/rails49/r49), not here
(#63). Its `fixtures/` tree holds six archives, 46 images with calibration and
no labels, below `MIN_DPT`. They exercise the code and are not training data.

## Workspace packages

`pnpm-workspace.yaml` covers `lib/*`, `tools/*` and `ui`. The `lib/*` packages
are consumed as TypeScript source; nothing under `lib/` is built or published.
`lib/CLAUDE.md` holds their interface rules. The `.r49` format package,
`@rails49/r49`, and the detector package, `@rails49/detector`, come from npm at
the versions `pnpm-workspace.yaml`'s catalog pins (org ADR-0022, ADR 0019).

| Package | Described in |
| :--- | :--- |
| `@occupancy/drift` | `lib/drift/src/index.ts` |
| `@rails49/detector` | rails49/detector's [`lib/detector/src/index.ts`](https://github.com/rails49/detector/blob/main/lib/detector/src/index.ts) |

The drift tolerance is `MAX_DRIFT_TRACK_FRACTION`, a constant in
`ui/src/driftSession.ts`. It becomes pixels only in that file's `maxDriftPx`
(ADR 0013).

## The model

The model ships inside `@rails49/detector`, so the package version names it
([rails49/detector `docs/SYSTEM.md` § Model files](https://github.com/rails49/detector/blob/main/docs/SYSTEM.md#model-files)).
`0.0.1` carries none. The package exposes the model as its `./model` exports
entry (ADR 0019). Vite resolves that entry and copies the file into the bundle
only if it exists. A package with no `./model` entry, or an entry with no file
behind it, builds without one, and the live view shows a no-model banner and
reports every sensor `unknown`. The filename is written only in the package;
the UI names none (`ui/tests/modelAssets.test.ts`). `bin/test.sh` downloads no
model. `README.md` has the command that runs the UI against a local model.

## Deploy

`bin/deploy.sh` builds the UI and uploads `ui/dist/` to the Cloudflare Pages
project `occupancy-rails49`. Two checks stop it first:

- `bin/check-deploy-source.sh`: the checkout is a clean `origin/main`
  (`ui/tests/deploySource.test.ts`).
- `bin/check-deploy-dir.sh`, after the build: a one-level inventory of what may appear in the
  deploy directory, no symlinks, no `.r49`/`.pt`/`.onnx`/`.ipynb`, and a 24 MiB
  budget in apparent bytes (#122, `ui/tests/deployGuard.test.ts`).

`ui/vite.config.ts`'s `dropUnfetchableOrtWasm` deletes the second, hashed ORT
binary Rollup emits; `ui/tests/ortAssets.test.ts` pins the places that set
`ort.env.wasm.wasmPaths`. `_headers` ships from `ui/public/`. The app's origin
is `occupancy.rails49.org` (rails49/control#47).
