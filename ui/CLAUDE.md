# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in `ui/`.

A static webapp: [Lit](https://lit.dev/) elements, [Shoelace](https://shoelace.style/) components,
Vite, TypeScript. It edits `.r49` layout archives — through the file picker, and on an occupancy
service where one answers at `/live` (#333) — and runs the detector in the browser via ONNX Runtime
WASM.

**This package has no backend of its own, and must not grow one — do not introduce one without
discussion.** Since #331 it is a client of an [occupancy service](../GLOSSARY.md#occupancy) on its own
origin, where one runs: [`../docs/UI.md`](../docs/UI.md) § An occupancy service is found at `/live`.
Since #333 it opens that service's archive and saves back to it, which is a client of somebody
else's backend and not one of its own.

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
| `persistence.ts`, Open and Save | Saving is three routes, and the fallback is permanent |
| `serviceArchive.ts`, `getImage`, reading images | An image is read when it is needed, and a read can fail |
| anything that writes `ManifestData`, `history.ts` | Every manifest mutation goes through `history.record` |
| car authoring clicks | Chaining; Right-click is a state branch, and the menu knows nothing |
| class names, `vocabulary.ts` | The vocabulary |
| `labeled_complete` | Completeness |
| the rail's tools, DPT | The calibration gate |
| `rr-viewer`, zoom, what each view draws | `rr-viewer` is shared; Zoom; What the three views draw |
| editor geometry, `geometry.ts` | `geometry.ts` holds the arithmetic |
| `calibrationMarker.ts`, `sensorMarker.ts`, `carMarker.ts` | Markers are modules, not elements |
| `base` in `vite.config.ts`, `/ort/`, `/shoelace`, `modelAssets.ts` | Absolute asset paths |
| `detectorSession.ts`, the model | Model loading lives in `detectorSession.ts` |
| the live loop, `liveSources.ts`, a frame or result source | Frames and results come from sources |
| `liveContract.ts`, `occupancyService.ts`, `serviceArchive.ts`, `/live` | An occupancy service is found at `/live` |
| `occupancy.ts`, `SensorState` | L1 lives in `occupancy.ts` |
| `driftSession.ts`, drift readouts | Camera drift lives in `driftSession.ts` |
| `diagnostics.ts`, `rr-diagnostics-view` | Diagnostics reads the model against the labels |
| a pane's colours, `matte.ts`, `tests/theme.test.ts` | The panes follow the theme |
| the band, the rail, a `look-dialog`, `lookTheme` | The chrome is `@rails49/look`'s |
| a test, a jsdom stub, `tests/setup.ts` | Tests run in jsdom |

## Shoelace

Import components one file at a time — `@shoelace-style/shoelace/dist/components/<name>/<name>.js` —
never the package barrel; the barrel pulls the whole library into the bundle. Type-only imports from
`@shoelace-style/shoelace` are fine. **`@rails49/look/look.css`, imported by `rr-app.ts`, carries
both themes and `prefers-color-scheme` decides**; there is no toggle. Components inherit `--sl-*`
tokens, so use those rather than hardcoding new colors.

The panes' surfaces and inks are `--sl-*` neutrals, in the vocabulary already in use: `neutral-0` a
pane, `neutral-50` a raised card, `neutral-100` a bar, `neutral-200` a hairline,
`neutral-500`/`600`/`700` graded ink, `neutral-900` the primary ink. Warning is
`--sl-color-warning-100`/`-800` and a refusal `--sl-color-danger-100`/`-800`. `tests/theme.test.ts`
fails on a hex literal in a pane module, template included. The reasons, and the three colours a
pane still states outright: [`../docs/UI.md`](../docs/UI.md) § The panes follow the theme.

## The chrome is `@rails49/look`'s (#161)

What `rr-app` declares on look's elements, and how a look release reaches this repository:
[`../docs/UI.md`](../docs/UI.md) § The chrome is `@rails49/look`'s.

* Every component puts `lookTheme` first in its `static styles`: a `::part()` rule reaches only the
  widgets in its own shadow root.
* `look-check` in `bin/test.sh` fails on a selector naming a `look-` element, on setting a look
  token or an `--sl-*` property, and on `sl-*::part()` in app code. `.fit-control::part(base)`
  names a class, not a widget, and passes.

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
`matchMedia`, `URL.createObjectURL`), and stubs `sl-alert`'s `toast()` so a toast stays in its
fixture, unopened (#376).

* jsdom is the only runner, and visual behaviour is verified by hand. Do not add a second runner
  without reopening #109.
* Every component has a test file.
* Reach for a stub before concluding a module is untestable: most of jsdom's gaps are a few lines
  in a `beforeEach`.
* Assert DOM structure, attributes, computed values, and emitted events; never claim a test verifies
  visual appearance.
* Camera (`getUserMedia`) and ONNX sessions are mocked per test file.
* What each of jsdom's gaps means for a test, and how the suites here handle it:
  [`../docs/UI.md`](../docs/UI.md) § Tests run in jsdom.

Run `pnpm test` from the repo root after changes here: it covers `lib/*` too. `ui` consumes
`lib/drift` as TypeScript source, so a change there breaks the UI at typecheck. `@rails49/detector`
comes from npm as a built `dist/`; a change to it reaches the UI only at a version bump.
