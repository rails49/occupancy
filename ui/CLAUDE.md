# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in `ui/`.

A static, fully client-side webapp: [Lit](https://lit.dev/) elements, [Shoelace](https://shoelace.style/)
components, Vite, TypeScript. It edits `.r49` layout archives through the file picker and runs the
detector in the browser via ONNX Runtime WASM. **There is no backend — do not introduce one
without discussion.**

## The three documents, and which one is true

| File | What it is | Trust it for |
| :--- | :--- | :--- |
| `../SPEC.md` | Requirements and rationale for the **whole project** — the **target** | *why*, and what to build next |
| `README.md` | Per-component contracts: properties, events, hierarchy — describes only what is built | the shape of existing components |
| `src/` | What actually ships | ground truth |

Where README and the code disagree, the code wins and README is the thing to correct:
**a change to a component's properties or events belongs in README in the same commit.**

## Dev server

Dev serves HTTPS with a self-signed cert because `getUserMedia` needs a secure context (a phone on
the LAN must use the HTTPS URL), and sets COOP/COEP because ORT's threaded WASM requires cross-origin
isolation. Both are configured in `vite.config.ts`; don't drop them.

## How the UI works: `docs/UI.md`

[`../docs/UI.md`](../docs/UI.md) holds the invariants an edit can break. Read the section for what
you are touching:

| Touching | Section |
| :--- | :--- |
| what the editor does and deliberately does not do | What the editor builds |
| `rr-app`, `editSession.ts`, who owns which state | State: props down, events up |
| `persistence.ts`, Open and Save | Saving is two paths, and the fallback is permanent |
| anything that writes `ManifestData`, `history.ts` | Every manifest mutation goes through `history.record` |
| car authoring clicks | Chaining; Right-click is a state branch, and the menu knows nothing |
| class names, `vocabulary.ts` | The vocabulary |
| `labeled_complete` | Completeness |
| the rail's tools, DPT | The calibration gate |
| `rr-viewer`, zoom, what each view draws | `rr-viewer` is shared; Zoom; What the three views draw |
| editor geometry, `geometry.ts` | `geometry.ts` holds the arithmetic |
| centerlines, the snap, patch outlines, `centerlineSnap.ts` | The snap is mirror symmetry |
| `calibrationMarker.ts`, `sensorMarker.ts`, `carMarker.ts` | Markers are modules, not elements |
| `base` in `vite.config.ts`, `/ort/`, `/shoelace`, `modelAssets.ts` | Absolute asset paths |
| `detectorSession.ts`, the model | Model loading lives in `detectorSession.ts` |
| `occupancy.ts`, `SensorState` | L1 lives in `occupancy.ts` |
| `driftSession.ts`, drift readouts | Camera drift lives in `driftSession.ts` |
| `diagnostics.ts`, `rr-diagnostics-view` | Diagnostics reads the model against the labels |

## Shoelace

Import components one file at a time — `@shoelace-style/shoelace/dist/components/<name>/<name>.js` —
never the package barrel; the barrel pulls the whole library into the bundle. Type-only imports from
`@shoelace-style/shoelace` are fine. **`@rails49/look/look.css`, imported by `rr-app.ts`, carries
both themes and `prefers-color-scheme` decides**; there is no toggle. Components inherit `--sl-*`
tokens, so use those rather than hardcoding new colors.

**The work panes follow the theme** (#151). Every surface and ink in `rr-app`, the three
`rr-diagnostics-*` elements, `rr-thumbnail-bar`, `rr-stats-bar`, `rr-live-view` and
`rr-editor-view`'s `.main-content` is an `--sl-*` neutral, which inverts when the operating system's
preference changes. The vocabulary is the one `rr-editor-view` and `index.html` already used, and
new code takes it rather than picking a fresh step: `neutral-0` a pane, `neutral-50` a raised card,
`neutral-100` a bar, `neutral-200` a hairline, `neutral-500`/`600`/`700` graded ink, `neutral-900`
the primary ink.

**Warning and fault are Shoelace's too.** The notice bars, the incomplete flags and the alignment
row past tolerance are `--sl-color-warning-100`/`-800`, and a refusal `--sl-color-danger-100`/`-800`
— the pair `rr-editor-view`'s readout bars already used. They invert like the neutrals, so neither
needs a second amber written for one theme; and both ends of those scales sit clear of the marker
inks, which are saturated mid-tones stroked onto the photograph rather than a filled bar in a pane.

**A finding's colour is text in three places** — the report's scorecard number and crop caption, and
the queue card's heading — and `diagnostics.ts`'s `KIND_COLOR` is one vocabulary shared with the
boxes drawn on the photograph, where a saturated mid-tone is right against any image. As small text
on a white pane it is not: amber is 1.9:1 there. Those three mix it 65% toward
`--sl-color-neutral-1000`, which is black under one preference and white under the other, so one
declaration darkens it in light and lightens it in dark. A swatch, a bar segment and a border take
it **undiluted** — a filled shape carries at any lightness, and diluting it would put two greens on
one screen.

**What the panes still state outright is three things, and all three sit off the pane.**
`src/matte.ts`'s `--photo-matte` is the black a photograph or a video frame is matted against —
`rr-viewer`'s viewport, a thumbnail, and the report's row image and crop card take it, and nothing
else may. `rgba()` scrims and drop shadows stay: a shadow is an alpha over whatever is under it, and
the fit control's scrim sits on the photograph. And `color: white` stays on a badge whose background
is `--sl-color-danger-600` or `--sl-color-success-600` — a saturated fill that does not move with
the theme, so neither may its ink.

`tests/theme.test.ts` is the guard, and its scope is exactly **no hex literal in a pane module**,
template included — the report set a tile's tint from an inline `style` attribute. It does not see
`rgba()` or `white`, which is why those three are argued above rather than asserted. It runs inside
the required gate: a literal creeping back is this repository's own regression. jsdom does not paint (#109), so the result was
judged by hand in both OS settings and no browser runner was added for it.

## The chrome is `@rails49/look`'s (#161)

The band, the rail, the dialog shell and the Shoelace theme layer come from
[`@rails49/look`](https://github.com/rails49/look), a git dependency pinned to a tag. A tag there
opens a bump pull request here
([rails49/look#10](https://github.com/rails49/look/issues/10)).

* `rr-app` declares the chrome on look's elements. `look-band` names the UI, "occupancy", and holds
  `look-about` (the layout's name and scale, absent with nothing loaded), a `look-reading` naming
  the bound file once Save would overwrite it, and `look-gear` for the settings dialog. `look-rail` holds the three
  views, then, in the editor only, File, History and, while a manifest is loaded, Tools. Live and
  Diagnostics have the views alone.
* The rail is `rr-app`'s and the tool state is the session's. The rail reads the tool, whether DPT
  resolves and the image on screen from the session, and a press calls `session.selectTool`.
* Status text is a toast, `rr-app`'s own `sl-alert`. The band carries no unsaved mark and no
  source link; the detector's source link is in the settings dialog (#274).
* The settings, calibration and sensor dialogs are `look-dialog`s (`medium`, `small`, `small`),
  still opened with `show()`. The discard confirm stays `window.confirm`.
* Every component puts `lookTheme` first in its `static styles`: a `::part()` rule reaches only the
  widgets in its own shadow root.
* `look-check` in `bin/test.sh` fails on a selector naming a `look-` element, on setting a look
  token or an `--sl-*` property, and on `sl-*::part()` in app code. `.fit-control::part(base)`
  names a class, not a widget, and passes.
* The editor's readout bars give back their padding at look's `TURN_HEIGHT_PX`, where the rail lies
  down as a strip. `tests/layout.test.ts` holds them to that number.

## Coding standards

* `pnpm lint` ([`../eslint.config.mjs`](../eslint.config.mjs), run by the gate) checks `src/`: no
  `any`; a `style` attribute in an `html` or `svg` template is quoted and sets custom properties
  only; element tags are `rr-<noun>[-<qualifier>]` and keys of the file's `HTMLElementTagNameMap`,
  which goes at the bottom of the file. A declaration written wholly as `${}` is not checked.
* Where a type is loose, write a narrow local interface or a type guard.
* A value a component can only compute at render time goes in a custom property, and its rule stays
  in `static styles` (`rr-viewer`'s zoom transform writes three numbers as `--zoom-*`). Shoelace part
  overrides are custom properties too (`style="--width: 500px"`).
* Compose from small elements. Non-element modules use plain camelCase filenames (`carMarker.ts`,
  `capture.ts`).
* Document each component with a short purpose comment and its interface (properties in, events out).
  Update `README.md`'s table for that component in the same change.
* Support current Chrome, Safari, and Firefox. Do not constrain features to accommodate other browsers.

## Testing

Vitest in **jsdom**, `@open-wc/testing` fixtures, `tests/<module>.test.ts` mirroring `src/<module>.ts`.
`tests/setup.ts` polyfills what jsdom lacks globally (`ResizeObserver`, `Element.animate`,
`matchMedia`, `URL.createObjectURL`).

**jsdom is the whole automated story, and no browser runner is coming** (#109). `@web/test-runner`
sat in `devDependencies` for months with no config file and no script, running nothing while
implying browser coverage existed; it is removed. Visual behaviour — that a box lands on the pixel
it names, that a real pointer capture holds through a drag — is verified **by hand**, and the
project accepts that. Do not add a second runner without reopening #109.

That decision is not a claim jsdom is sufficient; it is a reading of where the defects actually
were. Reviewing #106 turned up six, and four were plainly jsdom-testable and had simply never been
written — the diagnostics components shipped with **zero** test files. A browser runner would have
caught none of the six. Two more things follow, and both are load-bearing:

* **A component with no test file is the failure mode**, not a component whose test file cannot
  reach the paint. `rr-diagnostics-view` owned the sweep loop, the detector session's lifetime and
  every blob URL on screen with nothing exercising any of it, which is why #108's leak could live
  there — and why writing its tests surfaced a second defect of the same family (an abandoned sweep
  republishing its dead handles over a live sweep's map).
* **jsdom's gaps are stubbable more often than they look.** It implements neither
  `HTMLImageElement.decode` nor `URL.createObjectURL`; both are a few lines in a `beforeEach`, and
  the second must be stubbed *per test* when a test needs to tell handles apart — the global in
  `setup.ts` returns `undefined` for every call, which is enough to pass a handle along and useless
  for asserting one came back. Reach for a stub before concluding a module is untestable.

* **jsdom has no File System Access API**, which is the honest baseline — it is the fallback path,
  and it is what Safari and every phone run. `tests/persistence.test.ts` covers the write-back
  routes by installing fakes on `window`, so it proves the module *routes* correctly and **not**
  that Chromium's API behaves as documented, which nothing in jsdom could show.

* **jsdom does not lay out or paint.** `getBoundingClientRect()` is all zeros and SVG geometry
  (`createSVGPoint`, `getScreenCTM`) is absent, so `tests/rr-viewer.test.ts` stubs both per test —
  a scale plus an offset, standing in for a letterboxed viewport — and polyfills `PointerEvent` as
  a `MouseEvent` carrying a `pointerId`. The stub proves the viewer converts through the transform
  it is given, not that the transform is right — which is why the arithmetic lives in
  `geometry.ts`. Assert DOM structure, attributes, computed values, and emitted events; never claim
  a test verifies visual appearance.
* Camera (`getUserMedia`) and ONNX sessions are mocked per test file.
* The drag tests dispatch `rr-pointer-*` events shaped the way `rr-viewer` emits them, so they
  cover the editor's half of a gesture — the click threshold, the sticky drag flag, and closing a
  drag whose end never arrives — and **not** pointer capture, which is the browser's and the
  viewer's. One entry per drag and no-op suppression are session tests. A drag leaving the viewer is
  exercised as coordinates outside the image, which is what the editor actually sees.
* The detector session is pinned from **two sides**, and they are different checks:
  `tests/ortAssets.test.ts` reads `detectorSession.ts` as source text — that the `wasmPaths`
  assignment exists, names `/ort/`, and appears in no view — because the link it guards runs
  between a build-time copy target and a run-time fetch, which neither the typechecker nor the build
  can see. `tests/detectorSession.test.ts` runs the module instead, and asserts the setup actually
  fires, fires once per page, and reaches `loadDetector` with the assets module's URL. An assignment
  behind a condition that never fires would pass the first and fail the second.

Run `pnpm test` from the repo root after changes here: it covers `lib/*` too. `ui` consumes
`lib/drift` as TypeScript source, so a change there breaks the UI at typecheck. `@rails49/detector`
comes from npm as a built `dist/`; a change to it reaches the UI only at a version bump.
