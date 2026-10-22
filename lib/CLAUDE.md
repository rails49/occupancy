# Shared Libraries

All written in TypeScript, all consumed as source — nothing here is built or
published. `ui/` and `tools/drift-bench` are the only consumers.

* `drift` : camera-drift detection — block-wise phase correlation over an
  archive's own images, measuring only, deciding nothing

The detector package, `@rails49/detector`, is not here: it comes from npm and
its interface rules are rails49/detector's
([`lib/CLAUDE.md`](https://github.com/rails49/detector/blob/main/lib/CLAUDE.md)).

## The interface convention

**Each package's `src/index.ts` is its interface.** It is the C++ `.h` file of
the package: open it and you see the entire public surface, nothing more.

Three rules:

1. **Explicit exports only — never `export *`.** A wildcard makes the surface an
   accident of which files exist. Every exported name is a decision.
2. **`index.ts` contains no implementation.** It re-exports and it comments;
   that's all. Implementation lives in sibling modules (`base.ts`,
   `geometry.ts`, …).
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

* **There is no `paths` block in the root `tsconfig.json`.** Packages resolve
  through pnpm workspace symlinks and each `package.json` `"exports"` map, so
  `exports` is the single boundary and binds identically at typecheck and at
  bundle time. A `paths` entry — especially a wildcard one — would let deep
  imports typecheck cleanly and then fail only at build.

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
  is a constant in `ui/src/driftSession.ts`, because the live view refuses on it
  and the editor only warns — one number, two responses, and a module that decided would
  force both surfaces to agree about policy as well as about measurement. It is a
  fraction of a *track width*, not a pixel count: `ui/src/driftSession.ts`'s
  `maxDriftPx` multiplies it by the layout's DPT, which is the only place that
  conversion happens.

## Adding an export

1. Write the TSDoc on the declaration in the implementation module.
2. Name it in that package's `src/index.ts`, under the appropriate group
   comment. If it doesn't fit a group, ask whether it belongs in the interface.
3. `pnpm -r typecheck`.

If you remove one, note it in the "Withheld" comment at the bottom of the
header when the omission is a decision someone might otherwise read as an
oversight.
