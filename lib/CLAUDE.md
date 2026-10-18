# Shared Libraries

All written in TypeScript, all consumed as source — nothing here is built or
published. `ui/` and `dataset/` are the only consumers.

* `r49` : `.r49` archive parser and serializer, manifest schema, scale geometry,
  and the id generator every `id` field is minted with
* `classifier` : ONNX Runtime image classifier (browser and node targets)
* `detector` : car boxes — the YOLO OBB session (browser), the L0 decode, the
  L1 occupancy geometry, and the span→box construction the exporter uses
* `drift` : camera-drift detection — block-wise phase correlation over an
  archive's own images, measuring only, deciding nothing
* `config` : **generated** from `config.yaml` — layout and detector constants

## `config` is generated, and committed

`lib/config/src/` is emitted by `pnpm config:generate` (`bin/generate_config.py`)
and **must not be hand-edited** — edit `config.yaml` and regenerate. It is
committed rather than gitignored so a fresh clone typechecks before anyone runs
a generator, and `bin/test.sh` regenerates into a temp tree and diffs, so a
`config.yaml` edit without a regenerate fails the full check.

The interface convention below holds for it too: the generator emits `index.ts`
as a header of explicit named exports with a "Withheld" note, and the values
with their TSDoc in a sibling `generated.ts`. Both carry a DO-NOT-EDIT banner.
If you need a new value exported, add it to the generator's
`render_generated_ts` and `render_index_ts` — not to the output.

Python keeps reading `config.yaml` directly and must not consume this package.

## The interface convention

**Each package's `src/index.ts` is its interface.** It is the C++ `.h` file of
the package: open it and you see the entire public surface, nothing more.

Three rules:

1. **Explicit exports only — never `export *`.** A wildcard makes the surface an
   accident of which files exist. Every exported name is a decision.
2. **`index.ts` contains no implementation.** It re-exports and it comments;
   that's all. Implementation lives in sibling modules (`archive.ts`,
   `base.ts`, `uid.ts`, …).
3. **Not exported from `index.ts` means internal.** Consumers may not rely on
   it and it may change without notice. Tests, which live inside the package,
   may import internals directly.

## Why it is built this way

* **Per-symbol docs go on the declaration, not the header.** TSDoc written
  above an `export { x } from './y'` line is silently discarded — verified
  against the TypeScript language service, which returns empty documentation
  for such a symbol. Put `@param`/`@throws`/units on the declaration in the
  implementation module, where hover and IntelliSense read them. The header
  carries group comments and rationale instead.

* **The zod schemas are withheld deliberately.** Exporting `ManifestDataSchema`
  and friends would make zod part of `r49`'s public contract, so it could not
  be replaced without a breaking change. Callers receive validated data or an
  exception; how that validation happens is ours to change.

* **There is no `paths` block in the root `tsconfig.json`.** Packages resolve
  through pnpm workspace symlinks and each `package.json` `"exports"` map, so
  `exports` is the single boundary and binds identically at typecheck and at
  bundle time. A `paths` entry — especially a wildcard one — would let deep
  imports typecheck cleanly and then fail only at build.

* **A header cannot hide class members.** `R49Archive` is exported, so all of
  its public methods are public regardless of what `index.ts` says. Narrowing
  a class's surface means `private`, `#field`, or deletion.

* **`classifier` has three entry points, not one.** `.` carries only the config
  type; `./browser` and `./node` carry the classifiers. The split is what keeps
  `onnxruntime-node` and `sharp` out of the browser bundle, so it is load-
  bearing, not stylistic.

* **`drift` has one, and that is the decision.** `classifier` and `detector`
  split entry points to keep a platform's runtime out of the other platform's
  bundle. `drift` has no runtime to keep out of anything: the FFT is hand-rolled
  (~60 lines, against opencv.js at ~10.5 MiB) and every input is a `GrayPlane`,
  which is why `ImageData` is **not** the parameter type — it does not exist in
  Node, and `tools/drift-bench` is a first-class consumer that must score the
  code that ships rather than a copy of it. The canvas work lives in
  `ui/src/driftSession.ts`, which is the `detectorSession.ts` of that path.

  It also exports **no verdict**. `layout.max_drift_track_fraction` is
  `@occupancy/config`'s, because the live view refuses on it and the editor only
  warns — one authored number, two responses, and a module that decided would
  force both surfaces to agree about policy as well as about measurement. It is a
  fraction of a *track width*, not a pixel count: `ui/src/driftSession.ts`'s
  `maxDriftPx` multiplies it by the layout's DPT, which is the only place that
  conversion happens.

* **`detector` has two, and the second one is the same idea.** `.` is pure —
  types and geometry, importable from node, which is how `dataset` gets
  `spanToPolygon` — and `./browser` carries the ORT session. There is no
  `./geometry`: pure geometry has no dependency to keep out of anything, so a
  third entry point would be ceremony. `loadDetector` is a factory rather than
  a constructor plus `await load()` on purpose — an unloaded session cannot be
  represented, so `detect` has no null branch and "model not loaded" stays the
  view's `unknown` rather than an empty detection list.

## Adding an export

1. Write the TSDoc on the declaration in the implementation module.
2. Name it in that package's `src/index.ts`, under the appropriate group
   comment. If it doesn't fit a group, ask whether it belongs in the interface.
3. `pnpm -r typecheck`.

If you remove one, note it in the "Withheld" comment at the bottom of the
header when the omission is a decision someone might otherwise read as an
oversight.
