# Shared Libraries

All written in TypeScript, all consumed as source — nothing here is built or
published. `ui/` and `tools/drift-bench` are the only consumers.

* `drift` : camera-drift detection — block-wise phase correlation over an
  archive's own images, measuring only, deciding nothing

The detector package, `@rails49/detector`, is not here: it comes from npm.

## The interface convention

The convention is rails49/detector's
([`lib/CLAUDE.md`](https://github.com/rails49/detector/blob/main/lib/CLAUDE.md)),
and it holds here. Each package's `src/index.ts` is its interface: it
exports by name, never `export *`; it holds no implementation; and what it
does not export is internal. TSDoc goes on the declaration in the
implementation module, not on the re-export. The root `tsconfig.json` has no
`paths` block, so each `package.json` `"exports"` map is the single boundary.
To add an export, follow § Adding an export there.

## What `drift` adds

* **A header cannot hide class members.** An exported class's public methods
  are all public regardless of what `index.ts` says. Narrowing a class's
  surface means `private`, `#field`, or deletion.

* **`drift` has one entry point, and that is the decision.** A package splits
  entry points to keep a platform's runtime out of the other platform's
  bundle, as `@rails49/detector` keeps ORT behind `./browser`. `drift` has no
  runtime to keep out of anything: the FFT is hand-rolled
  (~60 lines, against opencv.js at ~10.5 MiB) and every input is a `GrayPlane`,
  which is why `ImageData` is **not** the parameter type — it does not exist in
  Node, and `tools/drift-bench` is a first-class consumer that must score the
  code that ships rather than a copy of it. The canvas work lives in
  `ui/src/driftSession.ts`, which is the `detectorSession.ts` of that path.

  It also exports **no verdict**. The drift tolerance, `MAX_DRIFT_TRACK_FRACTION`,
  is a constant in `ui/src/driftSession.ts`, because refusing on it is the live view's
  policy, and a module that decided would hold policy as well as measurement. It is a
  fraction of a *track width*, not a pixel count: `ui/src/driftSession.ts`'s
  `maxDriftPx` multiplies it by the layout's DPT, which is the only place that
  conversion happens.
