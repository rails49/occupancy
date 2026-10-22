# The UI

How `ui/` works today: the invariants behind each module, and why they hold. Component
contracts (properties, events, hierarchy) are in [`ui/README.md`](../ui/README.md); the
conventions are in [`ui/CLAUDE.md`](../ui/CLAUDE.md). Paths are relative to `ui/`.

## What the editor builds

The editor was reduced to what v4 supports (#19) — v3's point-marker authoring and `src/prototype/`
are gone for good — and rebuilt one ticket at a time: calibration points (place, drag, delete via
context menu), the tools and calibration gate, sensor authoring, car authoring, chaining,
reclassify, and the completeness affordance are all built. Every authoring surface v4 asks for
exists, but the editor is not finished — check GitHub Issues for what is open. **A missing
affordance is usually a deferral, not a bug.** One gap is deliberate and stated in the code: a
click **inside a car already labelled on this image** starts no car *while idle* — it would stack a
second box on the vehicle being aimed at — and it says so rather than doing nothing visibly (#43).
That is the whole width rectangle, `geometry.ts` § `carCovering`, generalising the older rule that a
click on a car *end* starts nothing — and the end handle now gives the **same reason**, because a
handle sits inside the same rectangle and two wordings would read as two rules. Under another tool a
car end stays silent: no car was being authored, so there is nothing to explain. A chain's second
click lands wherever it is aimed, existing end included; that is how a car is coupled onto a train
already drawn. Only the click that **starts** a
chain is checked: a drag may still take an endpoint into another car, and an archive that already
contains overlapping cars opens and edits unchanged — this gates authoring, and adds no validation
at the format layer.

## State: props down, events up

`rr-app` owns the view mode and one `EditSession` (`src/editSession.ts`) per archive, created on New
and Open. It passes `.session` to the editor and the session's `.archive` to the live and diagnostics
views, and listens for bubbling `rr-*` events coming up. Every child event is
`new CustomEvent('rr-<verb>', { detail, bubbles: true, composed: true })` — `composed` is required to
escape the shadow root. Children never reach into the archive's parent or mutate global state.

The editing rules live in the session, not in `rr-editor-view` (ADR 0017): every write the editor
makes, the tool and its gate, the chain, drags, the image on screen, hit-testing, and undo and redo.
The editor turns pointer, dialog and menu events into session calls and keeps what is only for
display: dialogs and menus and what they are open on, zoom and pan, highlights, blob URLs and drift.
Add an editing rule to the session and test it in `tests/editSession.test.ts`, without mounting
anything.

Lit does not observe mutations *inside* `R49Archive`. The session calls its listeners after every
change, and `rr-app` and the editor re-render on that. The settings dialog's edits go through the
session too (`editLayout`, `setCameraHeight`), so nothing edits the manifest outside it.

## Saving is two paths, and the fallback is permanent (#48)

`persistence.ts` owns both and is the only place that knows which one runs. A browser cannot write
to a file handed to it by `<input type="file">`; only the File System Access API yields a writable
handle, and that API is **Chromium desktop only** — not Firefox, not Safari, on no phone. Since this
file supports all three engines equally and the labeling device is a phone, **write-back is an
enhancement layered over the download path, never a replacement for it.** Do not delete the fallback,
and do not gate a feature on a handle existing.

* A **`FileBinding`** is the file this session writes back to. **Handle present ⇒ Save overwrites;
  absent ⇒ Save downloads a new generation.** `rr-app` holds it; New clears it, Save As re-points
  it, and Open sets it **only once the bytes parse** — a binding to a file that failed to load aims
  the next save at an archive this session never held.
* **The timestamp is the download path's, and only its.** A written-back file keeps its name across
  every overwrite, so a timestamp in the picker's suggestion would assert a save time the file no
  longer has. The format exists so a **lexical sort of the folder is a chronological one** — that,
  not tidiness, is what stops a session re-opening the wrong generation and silently reverting
  labeling work the history cannot recover (`SPEC.md` § Undo and redo: it never survives a reload).
* **The stem is the file's, not the layout's.** It comes from the opened filename, falling back to
  `layout.name` only for an archive that has never been saved, and it does **not** follow a later
  rename: `layout.name` is metadata stored inside the file, not the file's identity.
* **A download counts as saved.** `markSaved()` runs on both paths — the fallback did write a file,
  and withholding the marker would leave a phone permanently dirty and make the discard gate cry
  wolf on every New. Only a dismissed picker marks nothing, and it toasts nothing either.
* **Write permission is requested at the first save, never at open**, and a refusal falls through to
  the download rather than failing. An overwrite has **no other safety net**: `createWritable`'s
  atomic swap is the decision, so no `.bak` file and no verification read — re-parsing every image
  on every save costs more than the failure it would guard.
* **Save As is a Shift-click on Save, not a button of its own**, read from `look-press`'s
  `shiftKey`. On a browser without the API a Save As button would do exactly what Save does. The
  tooltip names the modifier only where the browser can honour it.

## Every manifest mutation goes through `history.record`

Each `EditSession` owns one `EditHistory` (`src/history.ts`). **Any code that changes
`ManifestData` must run inside `history.record(label, target, mutate)`** — in the session, each write
picks its own target.

Nothing enforces this. A component that reaches into `.archive` directly still typechecks, still
renders, and leaves a stack that is *wrong* rather than merely short: undo then reverses the edit
before it, which is worse than having no undo. Rules, from entries being scoped snapshots:

* **Declare the subtree you actually touch** (`layout`, one `image`, or the `images` array).
  Mis-declaring it is the only class of bug this design admits; `tests/history.test.ts` fuzzes a
  round-trip specifically to catch it. Cars are per **image** and sensors are per **layout**, so a
  car edit targets `{ kind: 'image', filename }` and a sensor edit targets `layout` — a drag picks
  its target from what the press grabbed.
* **Key on label `id`, never on object identity.** Applying a snapshot replaces objects wholesale.
* An edit that **removes images** must pass `options.retain` with their filenames — the bytes are
  gone from the zip by the time the entry could look for them. Additions are captured automatically.
* **A drag uses `beginGesture`, not `record`**: a drag mutates on every pointer-move and must still
  be one Cmd+Z. Snapshot when the drag starts, mutate freely, `commit()` at pointer-up records one entry
  — or none, when the subtree came back byte-identical. One entry covering several objects falls
  out of the target being a subtree (a coupler drag's two cars share one image record). Undo and
  redo are **refused while a gesture is open** — the drag has already mutated outside the stack —
  so every ending path (a repeated `pointerId`, `disconnectedCallback`, `attach`) must close one.
  `EditSession.undo` refuses before it selects anything, so an undo pressed mid-drag does not move
  the user either.
* **A reveal is three steps in one order** (#37), all in `EditSession.undo` and `redo`: select the
  *pending* entry's image, apply, then tell the listeners what changed. Undo may move the user; it
  may never change something they cannot see. The ordering keeps the snapshot from landing while
  the session still points at the frame being left — it buys no intermediate paint, since Lit
  batches the two into one update, so **the highlight is what actually shows the user what moved**.
* **What an entry changed is diffed from its own snapshots**, never declared by the caller —
  `changedObjects` in `history.ts`. The editor holds those candidates as the history gave them and
  **resolves them on every render** — by `id` for a car or sensor, by pixel for a calibration point,
  which has no id. So an undone **add** lights nothing rather than throwing, and an edit arriving
  while the glow is up cannot leave it on a renumbered crosshair. The glow is `highlight.ts`,
  transient by a timer, and view state: it is written nowhere and survives no image change.
* The rail's Undo and Redo tooltips are **qualified with the image** when the entry lands on another
  one ("Undo delete car — img_3.jpg"). `rr-app` composes the phrase from the session's image on
  screen.

`SPEC.md` § Undo and redo carries the reasoning.

## Chaining (#33)

* Every click after the first is simultaneously the end of the current car and the start of the
  next: the same pixel is written as one car's `p1` and handed on as the next one's `p0`, so the
  coincidence a coupling is derived from is exact by construction — chaining records no train.
  **One history entry per car, never one for the train**: a mis-click on the last coupler of a
  twelve-car consist must cost one car.
* A chain is **view state**. Its anchor writes nothing, so every way of abandoning one (right-click,
  tool change, image change, a lost DPT, a new archive) costs the manifest and the undo stack
  nothing; the cars already written stay, each on its own entry.
* `EditSession.rightClick` and `undo` are the state-dependent gestures: with no chain, right-click
  names a menu subject and undo goes to the stack; with a chain live, right-click ends it and undo
  stays inside it.
* The **rubber band** (`rr-viewer`'s `pendingCar`) draws the whole car it would commit, rectangle
  included — the rectangle is the only feedback that a label covers the car. The cursor is tracked
  **only** while a chain is live. On touch there is no cursor between taps, so the band is just the
  anchor's handle — a platform limit, not a gap to close, but worth knowing since the labeling
  device is a phone.
* **A live chain consumes every undo** (`EditSession.undo`): further along it undoes the last car
  and walks the anchor back — but only if that undo actually removed the chain's car — and at the
  chain's start it clears the anchor and touches no history. Redo ends a live chain. Known cosmetic
  lag: the rail's Undo label reads the stack's `undoLabel` and does not show this wall.
* A **coupling renders as one shared handle**, derived by `rr-viewer` from exact coincidence
  (`geometry.ts` § `couplerPoints` — the same rule the hit-test grabs by); the cars leave their own
  handles off at those ends. Dragging it is one entry moving every end under it.
* A second click on the **anchor's own pixel** writes no car — a zero-length span has neither an
  axis nor two ends — and the chain stays where it was.

## The vocabulary (#35)

`vocabulary.ts` reads the vocabulary out of `@rails49/r49`'s data file (`@rails49/r49/data.json`)
and is the **only place in `ui/` a class name comes from** — including the class
a new car is created as, which is the taxonomy's root rather than a literal `'stock'`. A hardcoded
class anywhere in `ui/` breaks the data-file→menu path while still typechecking. Rules, each stated in
rails49/detector's [`SPEC.md` § Parameters live in `config.yaml`](https://github.com/rails49/detector/blob/main/SPEC.md#parameters-live-in-configyaml):

* **The root is required in the stored class and never rendered.** An unrooted class is a
  segment-prefix of no `detector.classes` entry and is dropped from the export — the
  unlabeled-car-as-background failure the completeness rule exists to prevent. So the menu offers
  the root's *children*, and every row carries the full dotted class.
* **A nested object is a subtype; anything else (`width_mm`) is a property.** The distinction is
  structural, which is what avoids a reserved list of key names.
* **Conformance is a warning here, never a parse error.** A car whose class names no vocabulary
  entry draws in red with the class beside it, and the archive opens exactly as before — a format
  that refused files over a pruned vocabulary would punish vocabulary edits. The exporter is where
  the same mismatch becomes fatal.
* A **submenu row is opened, never chosen** (Shoelace does not select a parent), so a subtype with
  subtypes of its own repeats itself as the first row of its own submenu ("loco (unspecified)") —
  "kind unknown from the photograph" is a real answer and must stay reachable.

## Completeness (#36)

`labeled_complete` is the only place in the format where a human asserts something about **absence**
— no car in this image is unlabeled — and it is the one gate on detector training.

* `EditSession.setComplete` is the **only** place `true` is ever written, one history entry per
  toggle, and the editor calls it only from the checkbox. Nothing computed may stand in for it: an image whose labels are all `proposed` is
  byte-identical whether the user checked every one or clicked accept-all blind, so an accept-all
  must never set it.
* **Deleting a car clears the flag, in the same entry** (`SPEC.md` § Labeling completeness). Nothing
  can tell a label deleted off background from one deleted off a car still in the photograph, and a
  flag surviving the second case exports an image teaching the detector that cars are background.
  Setting is the claim only a human may make; clearing withdraws it and asks again. Deletion alone
  clears — adds, drags, and reclassify do not.
* The thumbnail-bar badge is a **readout, not a second control**: a toggle on a 64px thumbnail would
  let a click aimed at selecting an image assert completeness by landing a few pixels off.
* An image marked complete with **zero** cars is a valid all-background sample and warns about
  nothing.

## The calibration gate

* The rail's Tools group chooses the tool a click means and **disables the labeling tools while DPT
  is unresolved, with the reason as their tooltip** — naming DPT, not the width rectangle: car width is derived from DPT
  rather than stored, so an uncalibrated archive cannot draw the rectangle that is the only
  feedback a label covers the car.
* The gate is on **existence, never completion** (`SPEC.md` § Labeling Workflow): `getDPT` returning
  a number *is* the gate. It is enforced twice on purpose — the rail disables the buttons, and
  the session demotes a live tool back to calibration after every change — because DPT can vanish
  through an **undo**, which no disabled button can stop.
* The **sensor** tool is gated with the car tool, one step beyond `SPEC.md` § Labeling Workflow — a
  sensor point needs no DPT to draw, but #31 asked for both. `needsDpt` is per tool in
  `tools.ts` if that is revisited.
* Sensors are **per layout**, carry **no provenance** (no model can propose where a human wants an
  answer), and their snowflake ids live in a namespace never compared with label ids. A sensor is
  placed unnamed: `name` is optional passthrough, never auto-generated, and the UI shows the `id`
  in its place.

## `rr-viewer` is shared, and that is load-bearing

The same component backs the editor (`src` → `<img>`) and the live view (`stream` → `<video>`).

* **The media and the overlay resolve to one box, by construction** (#41). Both cover the container
  and fit their content by the same rule — `object-fit: contain` against
  `preserveAspectRatio="xMidYMid meet"` — over a viewBox that is the **media's own pixel grid**.
  Two boxes fitted independently coincide only by luck; that drift is what let a sensor slide off
  its track as the window was resized.
* The authored frame (`camera.resolution`) reaches that grid through the `g.frame` scale
  (`geometry.ts` § `overlayFit`): everything drawn and every coordinate emitted is in the frame the
  manifest is written in (`SPEC.md` § Output encoding), **not** the image's own pixels. When an
  image is a different shape than the declared resolution, no mapping is correct (nothing records
  the crop); the defined answer is that the frame is **stretched** to cover the photograph, and the
  viewer emits `rr-media-frame` so the editor can warn (`.frame-warning`, which blocks nothing).
  Silently absorbing the mismatch is forbidden (#41).
* The viewer **reports pointer gestures and authors nothing**. It emits `rr-pointer-down`/`-move`/
  `-up`/`-cancel`/`-contextmenu` with coordinates already converted to **image pixels**, via
  `createSVGPoint` + the inverse of the **content group's** `getScreenCTM` (the group's user space
  is the authored frame) — **never a hand-rolled subtraction of `getBoundingClientRect()`**, which
  ignores the letterbox and is right only when the viewport matches the image's aspect ratio. The
  same matrix yields `imagePxPerScreenPx`, which converts grab radii and measures `symbolSize`.
  Deciding what a gesture means is `EditSession`'s job; the arithmetic is in `geometry.ts`. The v3
  machinery that mutated does not come back.
* `symbolSize = SYMBOL_SIZE_SCREEN_PX / ctm.a`, recomputed by a `ResizeObserver` off the **content
  group's** CTM (a ratio from the SVG's bounding rect is wrong by the letterbox), keeps annotations
  a constant screen size.
* It draws what it is given — `cars`, `calibrationPoints`, `sensors` from the manifest, and
  `detections`/`sensorStates` from the live view's loop — never writing any of it. Order is a
  claim: cars **first**, then the detections over them (a prediction is read *against* a label),
  then points and sensors over both. Their rectangles are the overlay's only area fills, and a
  point or sensor on a car must not be tinted over.

## Zoom is one transform above the overlay (#44)

* `rr-editor-view` owns a nullable **rect of the authored frame**; `rr-viewer` applies it to a layer
  carrying the media **and** the SVG. That placement is the whole feature: two children of one
  transformed box stay one box by construction (#41), and because `getScreenCTM()` walks up through
  it, `imagePxPerScreenPx` and `symbolSize` are zoom-aware with **no arithmetic changed anywhere** —
  annotations stay 36 screen px, cars stay 2.09 track widths, the grab radius stays 14 screen px.
  `hitTest`, `carUnderPointer`, `carCovering`, `dragHandles`, `dragTo` and `isClick` needed no edit,
  and a zoom implemented by moving the viewBox and transforming the media separately would undo #41.
* **`null` is fit** — the absence of a zoom, not a rect covering the frame. Zoom is **view state**:
  it records nothing, `SPEC.md` § Undo and redo already names it among what undo does not restore,
  and it survives an image change and a live chain. New and Open drop it.
* The rect→transform, the pan clamp, the cap and the reveal decision are pure and live in
  `geometry.ts`; jsdom can prove all of them and **cannot** prove the transform lands on screen —
  `tests/rr-viewer.test.ts` stubs the CTM, so a viewer test shows the property was applied and
  nothing more. Do not describe a test here as visual verification.
* A **pan is measured on the glass** (`originalEvent.clientX/Y`), the one gesture in the editor that
  is: panning moves the transform image coordinates are reported through, so a delta taken from them
  would measure the pan's own effect.

## `geometry.ts` holds the arithmetic, because a component cannot be tested

jsdom does not lay out or paint, so anything left inside a Lit element is covered by nothing — and
by decision (#109) nothing is coming to cover it. Put new editor geometry here, not in the component
that happens to need it first. Rules it encodes, each wrong somewhere if reimplemented:

* **No scale lookup.** The ratio cancels out of `DPT × STANDARD_WIDTH / STANDARD_GAUGE`, so a car is
  2.09 track-widths wide in every scale. `carWidthPx` itself is **re-exported from
  `@rails49/detector`** rather than implemented here, so the width L1 normalizes with and the
  width the editor draws cannot disagree.
* **Objects draw at world sizes; annotations at screen sizes.** A sensor is one track width across
  (`trackWidthPx` *is* DPT: px/mm × gauge_mm) and a car is 2.09, so both shrink with the
  photograph; labels, crosshairs, markers and endpoint handles stay constant on screen. `rr-viewer`
  holds both: `dpt` for world sizes, `symbolSize` for screen ones.
* **Tolerances are screen pixels**, converted with `imagePxPerScreenPx` — a grab radius belongs to
  the mouse, not the photograph — but a radius is a **floor, not a cap**: a world-sized symbol is
  grabbable across its whole footprint. `sensorDiameterPx` is shared by renderer and hit-test so
  the two cannot drift.
* **A coupler is exact coincidence.** Nothing about a coupling is stored; a proximity test would
  fuse cars placed separately. `hitTest` and `couplerPoints` apply the one rule, so what draws as a
  coupling is exactly what grabs as one.
* **Three questions, deliberately not one**, all off the same `HitScene` so they can never disagree
  about what is on screen. `hitTest` is what a gesture can **grab** — a car's body grabs nothing.
  `carCovering` is whether a pixel is already **labelled**, a claim about the image, asked only by
  the car tool's first click (#43). `carUnderPointer` is which car a gesture is **aimed at**, a
  claim about the pointer, asked only by the menu (#45). The last two measure the same rectangle in
  the span's own frame — a diagonal car across its axis, not across a bounding box half again too
  big, boundary inside — and differ only in the fingertip floor, which the pointer's question has
  and the image's must not: widening `carCovering` would refuse a chain start across a band of
  demonstrable background, which in a yard photo is the gap between parallel tracks.
* `hitTest`'s `kinds` parameter **narrows the search, not the answer**. Nearest-wins has already
  discarded everything the winner beat, so filtering the *result* loses a sensor standing just
  behind a car end. Passing a scene with `cars: []` would work and is wrong for the same reason the
  three questions share one scene.
* One `DEFAULT_GRAB_RADIUS_SCREEN_PX` for every tool — it describes the pointing device, not the
  object. `CLICK_SLOP_SCREEN_PX` is smaller (hand tremor, not aim), and `isClick` keeps a swipe on
  a phone from placing a point.
* `dragHandles` turns a hit into the **list** of points a gesture moves — the coupler case, and why
  one entry can cover several objects. `dragTo` applies the same delta to each handle's
  *pointer-down* position: measured from the press so the grab offset survives, identical across
  handles so coupled ends stay on one pixel.

## Right-click is a state branch, and the menu knows nothing

* `rr-editor-view` hands `rr-pointer-contextmenu` to `EditSession.rightClick`: a subject for the
  menu when idle, end-the-chain while chaining (`SPEC.md` § Right-click is state-dependent). Undo is
  state-dependent against the same states, inside `EditSession.undo`.
* The native menu is suppressed **in the editor, not in `rr-viewer`**, and for every right-click —
  inside the labeling surface the gesture is the editor's whatever it lands on. `rr-live-view`
  shares the viewer, does not listen, and keeps the browser's menu.
* `rr-context-menu` renders rows and reports which was chosen; it never learns what the object is.
  The session names the subject and the editor maps it to rows (`itemsFor`); empty image opens no
  menu at all.
* **A car's subject is its body, and the subject is one object** (#45). `rightClick` resolves it
  **topmost drawn first**: `hitTest` for sensors and calibration points only, then `carUnderPointer`
  for the area. Car ends are not asked about at all — a shared handle is two cars at one pixel, so a
  hit there must fall through to the area or right-clicking a joint opens nothing — and a sensor
  inside a car's rectangle, the normal case, stays reachable because it is drawn over the car. Two
  cars covering a pixel is the zero-area seam of a coupling; the first in scene order wins.
* Rows are therefore **verbs and name nothing**: `delete`, `reclassify:<class>`. A row that only
  opens a submenu uses a separate prefix (`reclassify-group:<class>`) — an id identifies a row, and
  two rows sharing one defeats that. `MenuSubject` is its own union, not a `HitTarget`: a
  `HitTarget` means *what a gesture can grab*, and a body grabs nothing.
* Delete is **one entry scoped to what it deletes**: `layout` for a point or sensor, that image's
  record for a car. A calibration-point subject carries the pixel it was opened on
  (`_pointIsStillAt` in the session, the same staleness guard the calibration dialog uses) — an undo landing while
  either is up can slide an index onto another point. Cars and sensors carry an `id` and need no
  guard.
* Right-click shares the pointer stream with the left button: the editor **ignores presses and
  releases whose `button` is not primary** (otherwise the press that opens the menu also runs the
  click path, and a secondary release ends a left drag mid-gesture), and the menu **swallows its
  own dismissing press** (so closing a menu over empty image places no point).

## Markers are modules, not elements

Custom elements break the SVG namespace when nested in `<svg>`, so `calibrationMarker.ts`,
`sensorMarker.ts` and `carMarker.ts` are plain-export modules whose exports
(renderer, defs where needed, styles) **must be used together** — the module boundary is the
encapsulation. Each object type is unmistakable in both shape and colour, a requirement rather than
taste (`SPEC.md` § Reference points: authored by different tools, meaning different things); README
carries the exact exports and glyphs. Two rules that don't show in the README table:

* `renderCar` takes the **DPT**, not a width — the 2.09 derivation lives in `geometry.ts`, and a
  caller passing a number would be a second place to get it wrong. A `null` DPT draws the chord and
  handles with **no rectangle**: there is no derived width to claim, and authored cars must stay
  visible after a calibration point is deleted. `renderDetection`, beside it in the same module,
  takes the opposite: a `Detection`, drawn at the width the *model* predicted (#85).
* `marker.ts` is **gone** (#85). Its glyph set — `track`, `train`, `coupling` — was the CNN's label
  vocabulary, and nothing could produce a `MarkerData` once the live view stopped classifying
  points. Do not reintroduce it: L0 is a box and L1 is a state on the sensor that already exists.
* Labels flip inwards at a frame edge through the shared `placeLabel`.
* `highlight.ts` spans all three: one white glow, on the group, for whichever object a reveal
  points at. Its class and its styles are used together like every other pair here. White because
  each type's own ink is a requirement, so a coloured highlight would read as a fourth kind of
  object.

## Absolute asset paths

`base: '/'` in `vite.config.ts`, and runtime asset paths are hardcoded to match:
`setBasePath('/shoelace')` in `rr-app.ts`, `/ort/`, and `modelAssets.ts`'s
`DETECTOR_MODEL_URL`. Changing `base` means changing all of them.

It was `/ui/` while the app shared the apex with a landing page; the app owns
`occupancy.rails49.org` outright now (rails49/control#47). The hardcoding is the
part that did not change — these are still literals rather than `import.meta.env.BASE_URL`,
because `tests/ortAssets.test.ts` reads the `wasmPaths` assignment as source text.

## Model loading lives in `detectorSession.ts`, and the model is the detector (#85, #87)

`ui/src/detectorSession.ts` is the sole place that calls `loadDetector`. It points
`ort.env.wasm.wasmPaths` at `/ort/` — the same path everywhere, deployed or not (#15) — then
loads `DETECTOR_MODEL_URL`. **Two views open a session through it**: `rr-live-view` per camera
frame, and `rr-diagnostics-view` over an archive's stills.

It used to live in the live view, which was the only caller. Two callers make the extraction
load-bearing rather than tidy: `ort.env` is module-global, so a second view setting the path would
mean **mount order decides whether the runtime resolves** — and the failure is a 404 on a hashed
filename in whichever view happened to come up second. `tests/ortAssets.test.ts` now asserts the
assignment exists in exactly one file, and `tests/modelAssets.test.ts` that no `rr-*` view names the
model at all.

What the module does **not** do is decide what a failed load means. It rejects; the views differ —
the live view keeps its loop running and reports every sensor `unknown`, because `occupancy()` is
total and that is a state SPEC names, while the diagnostics view has no partial answer to give and
says so. Folding that into the loader would take the choice away from both.

**Which model ships is named by the detector package, and the UI names no model file** (#234,
ADR 0019). It used to be two literals in two files that run in different worlds — a build-time copy
target in `vite.config.ts` and a run-time fetch here — and the gap between them is invisible to the
typechecker *and* to the build: a rename touched one and 404'd the moment the camera came up. The
build now copies whatever `@rails49/detector/model` resolves to (`ui/modelCopy.ts` names the entry
and the bundle directory), and the fetch goes to `modelAssets.ts`'s `DETECTOR_MODEL_URL`, built from
the package's `DETECTOR_MODEL_FILE`. They are two modules so that `vite.config.ts` loads no package
code. `tests/modelAssets.test.ts` fails if any of these files names
the filename, and builds the UI with a stand-in at the package's entry to check it lands at the URL.

**The CNN is retained but not loaded, and the bundle no longer carries it.** The classifier
is in rails49/detector ([SPEC § CNN crops, for the classifier](https://github.com/rails49/detector/blob/main/SPEC.md#cnn-crops-for-the-classifier)), but `ui` does not depend on it and Vite
copies no `model_int8.ort`. L1 is a pure function of L0 (`SPEC.md` § Occupancy Output), so the
per-sensor answer is a geometric consequence of the detector's boxes and there is nothing left for a
second model to say — one model, one ORT session, one vocabulary, settled in #7. Reintroducing a
classifier load here would be reintroducing a second answer.

**The loop runs even when the model does not load.** `occupancy()` is total: with `detections: null`
it reports every sensor `unknown` / `no-model`, which is a state SPEC names. A guard that skipped
the loop would leave the previous frame's answers on screen instead — the one outcome worse than
saying nothing.

**The ORT runtime is same-origin, and that is what pays for threading.** `ui/public/_headers`
cross-origin-isolates the app's origin, without which ORT silently runs one WASM thread; `require-corp` then
rejects any cross-origin subresource, so the jsDelivr branch that used to serve the runtime is gone
and cannot come back on its own. It existed because the default `onnxruntime-web` entry asks for the
jsep (WebGPU/WebNN) binary, which is 25.02 MiB — 0.02 over Cloudflare's per-file limit. The app
requests `executionProviders: ['wasm']` and needs none of jsep, so `detectorSession.ts` and
`@rails49/detector/browser` both import
**`onnxruntime-web/wasm`**, whose 12.42 MiB binary fits. Those specifiers must stay identical: two
specifiers are two module instances, and the
`ort.env.wasm` set here would not be the one the detector's session reads. Two versions would be
two instances as well, and worse, the WASM files copied from the UI's install would not match the
JavaScript bundled from the detector's: `@rails49/detector` takes `onnxruntime-web` as a peer
dependency, so the UI's own dependency decides the one version (ADR 0019). `ui/ortAssets.ts` holds
the reasoning and the copy targets; `tests/ortAssets.test.ts` holds the chain to them.

**Only two ORT files are copied** — the binary and `ort-wasm-simd-threaded.mjs`, its Emscripten
glue, which ORT resolves against `wasmPaths` exactly like the binary. Everything else in ORT's
`dist/` reaches the browser through Rollup; globbing the directory put 44 MB of webgl, webgpu and
node builds in the bundle that nothing could fetch. `@rails49/detector` sets **no** default
`wasmPaths` and throws if none is set: a library cannot know the app's base path — the old `/ort/`
guess was a 404 under the `/ui/` base this app used to have, and is right today only by coincidence
of `base` being `/` — and `vite.config.ts`'s `dropUnfetchableOrtWasm` removes the copy ORT
would otherwise fall back to — so an unset path fails on a hashed filename with no clue attached.

`rr-editor-view.ts` used to carry a byte-identical copy; it went with the v4 reduction (#19).
**Do not reintroduce it there** — the duplication was a standing hazard, and nothing in the reduced
editor needs inference.

Vite copies the model into the bundle only if `@rails49/detector/model` resolves to a file, so
builds and typechecks must keep working with no model present — `0.0.1` carries none, and a linked
checkout may have none. Without it the live view starts, shows the no-model banner and reports every sensor
`unknown`.

## L1 lives in `occupancy.ts` (#231)

`occupancy()`, `SensorState` and `UnknownReason` are the UI's, not `@rails49/detector`'s
(ADR 0019). Sensors are authored in the editor and training never reads them, so the per-sensor
answer belongs with the app that reports it, and ADR 0005's bias toward occupied is a rule about
that report. What L1 builds on stays in the package: the `Detection` shape and `carWidthPx`, the
width it substitutes for the predicted one. `covers`, the strict point-in-oriented-box test, sits
beside `occupancy()` because nothing else calls it.

It is pure and total — one state per sensor, always — so the live view hands `rr-viewer`'s sensor
markers one answer and never builds an `unknown` itself.

## Camera drift lives in `driftSession.ts`, and the two views answer it differently (#89)

`ui/src/driftSession.ts` is the drift path's `detectorSession.ts`: the sole place that holds a
canvas for it. `@occupancy/drift` takes a `GrayPlane` and not an `ImageData` on purpose — the
benchmark is a Node program and a first-class consumer, so making the browser's type the boundary
would lock out the thing that proves the check works — which leaves somebody to do the decoding, and
this is that somebody. It exports `openDriftCheck(archive)`, `grabPlane(source, w, h)` and
`planeFromBytes(bytes)`.

**One image defines the pose: `images[0]`, the first thumbnail in the strip** (#118). What shipped
first made every image a reference and scored the minimum over them, which had a hole — an image
captured from a moved camera and kept anyway (the editor warns, it never blocks) joined the reference
set, so the drifted pose then scored ~0 and the refusal never fired again. One accepted warning
permanently widened the accepted pose.

Position 0 closes it, and **the reorder control is what keeps the choice legible rather than hidden**:
dragging a thumbnail to the front re-points the comparison, and because the editor shows *every*
image's drift against the reference, every number on screen moves when you do. A rule keyed on
something invisible — the oldest filename, say — would be safer against accident and much harder to
understand or correct. That trade was made deliberately; see #118's resolution.

**References are decoded at their native resolution, and that is load-bearing.** `displacementPx` is
reported in the frame of the *first* reference, so handing the check pre-shrunk images silently
rescales every number — while the tolerance is expressed in `camera.resolution` pixels. The check
clamps to its own working resolution internally; letting it do that is what keeps the number meaning
one thing.

**The tolerance is a fraction of a track width, and `maxDriftPx(dpt)` here is the only place that
multiplies.** `MAX_DRIFT_TRACK_FRACTION` (0.25), a constant beside it, times the layout's DPT — which *is* pixels per
track gauge — gives the tolerance in the frame the sensors were authored in. A fraction rather than a
pixel count because the failure is geometric: occupancy breaks when a sensor stops sitting on the car
it reads, and both boundaries for that (falling off the box, sliding onto a neighbouring track's car)
sit near one whole track width, so a quarter track is a ~4x margin. The same *pixel* count would mean
five times as much misalignment at DPT 18 as at DPT 90. `null` DPT yields `null` and the verdict is
withheld: those sensors already read `unknown` / `no-calibration`, and a fabricated tolerance would be
a second wrong answer in a quieter voice.

> This replaced an absolute `max_drift_px` of 0.5 — the check's own quantum. That number conflated a
> **detection floor** with a **tolerance**: it was unreachable without precision mounting and said
> nothing about when occupancy actually breaks. The check resolves far less than the tolerance
> accepts, and should.

**`DriftSession` carries one `refName`.** With a single reference, `DriftResult.refIndex` is always 0
and callers ignore it; what they want to name is the image the measurement was taken against.

**The live view refuses L1 and keeps L0** (#94). Past `maxDriftPx(dpt)` every sensor reads
`unknown` / `drift` — `occupancy()` takes a `drifted` flag and builds those states, so no view
assembles an unknown-map of its own — while the detector goes on running and the dashed boxes go on
being drawn. The boxes are computed *in the live frame* and are true of it; what a moved camera
invalidates is their mapping onto sensors authored in the archive's frame. Sensor diamonds visibly
off the track beside correct boxes is the clearest available statement of why the view is refusing.
Occupancy is machine-consumable, so withholding it is the honest response where a banner alone is
not — the banner is for the human, and it carries the displacement in **both pixels and track
widths**, the image matched, and a **"classify anyway" override**. The override is not sticky across a
remount: a new session should start by telling the truth again.

**`rr-stats-bar` carries the alignment continuously, and the split from the banner is the point.** The
banner is an *event* — it appears when something is wrong. Alignment is a *continuous measurement*,
and someone aiming a camera has to watch it move: a number that only appeared once it was already too
large would leave them adjusting a mount blind, and "how much margin is left" is the question the
banner cannot answer. The row shows measurement against tolerance, like a gauge with a red line, and
renders `—` rather than `0.0` before the first sample — this is the one readout where a zero is a
claim rather than an initial value. No row at all when no tolerance resolves.

Drift is sampled on an interval (`DRIFT_SAMPLE_INTERVAL_MS`, 3 s), never per frame — a check measures
**~0.27 s** against the single 1920x1080 reference on the 2017 i7 in Chrome (~0.13 s to build its
spectra once, dominated by resampling rather than by FFTs), and it measures something that changes on
the timescale of somebody knocking a tripod. Both figures were ~7x and ~3x worse when every archive
image was a reference; #118's single reference bought that back as a side effect of a correctness fix. The sample is **not awaited by the loop**: the
check yields to the host between references, which is what its async signature was reserved for, so
the loop keeps drawing and keeps reporting the *previous* verdict while the next is computed.
Sampling continues while refusing — putting the camera back is the fix, and a gate that stopped
measuring the moment it fired could not see it happen.

> ⚠️ **The yield primitive is `MessageChannel`, and it was measured, not assumed.** `lib/drift` first
> yielded with `setTimeout(0)`; browsers clamp a timer nested more than five deep in a
> non-foreground page to roughly a second, and these yields are nested by construction, so the same
> 0.53 s of arithmetic took **6 s** wall-clock in a backgrounded tab — the exact case a phone puts the
> live view in. `MessageChannel` is not subject to timer throttling. Do not "simplify" it back.

**The editor measures every image and blocks nothing** (#95, #118) — the `MIN_DPT` precedent exactly.
The row above the viewer has four states, and only one of them is amber:

| state | when |
| :--- | :--- |
| `.reference` | position 0 — "zero drift by definition", plus how to change it |
| `.checking` | a measurement in flight |
| `.steady` | measured, inside the tolerance — the number, stated |
| *(amber)* | measured, past the tolerance — the warning |

**`.steady` exists because the reference is user-movable.** A row that appeared only past the
tolerance would let a reorder re-point the pose with nothing on screen moving, which is exactly the
silence #118 was about. And position 0 says "reference" rather than reading `0.0 px`: "zero because it
*is* the reference" and "measured and found steady" are different claims, and only the first is true
there.

Measurements are held in memory and never stored: a drift verdict is derived, v4 stores no derived
state (#6), and the archive's images already *are* the pose record. An image with no row has **not
been measured** (or its measurement failed) — which the render distinguishes from measuring zero.

`ui/src/driftMeasurements.ts` holds them (#167). The editor tells it the image filenames on every
update and nothing else; it works out what changed itself:

* **a different `images[0]`** → every measurement against the old reference is dropped and every
  image is measured again. A reorder, a delete of position 0, and an undo or redo of either all look
  the same from here, which is the point: no path has to remember to say so.
* **a new filename** → that image alone is measured. Appending cannot move position 0.
* **a filename gone** → its row is dropped, and measured again if an undo brings it back.

Each result is tagged with the reference it was measured against and dropped if that is no longer
the reference. Images are measured one at a time, whether or not the layout is calibrated — the pixels
need no DPT — but no row shows until a DPT resolves, since a fraction of a track width needs a track
width and the calibration gate already has the labeler's attention. `driftVerdict` in
`driftSession.ts` turns a measurement and a DPT into the numbers the row and the live view's refusal
both print.

## Diagnostics reads the model against the labels (#87)

`ui/src/diagnostics.ts` is the scoring, and it is pure — same reason `geometry.ts` is: jsdom lays
nothing out, so anything left in a Lit element is untestable. Rules that are decisions rather than
implementation:

* **It is not in `@rails49/detector`.** That package's root is the car-box geometry both sides of
  the model need. Scoring belongs to whoever is evaluating, and that is one view in one app today —
  the package's own interface note says to add a `./node` entry point "when something wants to score
  a corpus offline, not before", and the same restraint applies to the scoring itself.
* **Matching is confidence-ordered greedy assignment over oriented-box IoU**, not nearest centre.
  The case that decided it is in the tests: a box lying *across* a car sits at zero centre distance
  and reads as a perfect match, where overlap correctly calls it a phantom over a missed car.
* **`duplicate` is a separate kind from `phantom`, and finding out why is what this view was for.**
  Its first run against a real archive showed the detector emitting two or three boxes per car — 48
  duplicates against 29 genuine phantoms on `cars-0-10`. Both are false positives and a scorer counts
  them alike, but they are different faults: a phantom is the model seeing a car in the ballast, a
  duplicate is nothing having deduplicated the output. Collapsing them reports "77 boxes over
  nothing" and sends the reader looking in the wrong place. A duplicate **carries the label it
  duplicates** so the crop can frame both — that is not a claim it matched; the kind says otherwise.

  **The cause was found and fixed** (#107): `end2end`'s `TopK` selects the top 300 slots and
  suppresses nothing, at fp32 and INT8 alike. `@rails49/detector`'s decode now suppresses duplicates
  before returning L0, so this count should read near zero against a current model — **keep the kind
  anyway**. It is the only thing that would show the suppression regressing, and it distinguishes
  the two faults that a single "false positive" number cannot.
* **The polygon IoU is `@rails49/detector`'s**, not this module's. It moved down when the decode
  became a second consumer, which is the bar that package sets for promoting anything; two copies of
  a winding rule is exactly how a matcher and a suppressor come to disagree about what overlaps.
* **Matching is width-normalized**, the same substitution `occupancy()` makes and for the same
  reason: a label's width is *derived* from DPT rather than authored, so scoring the predicted width
  would charge the model against no ground truth. The raw ratio is reported, never matched on.
* **`AGREE_IOU` is 0.7, deliberately not mAP50's 0.5.** At 0.5 a box half the car's length scores as
  agreement — two equal-width rectangles sharing half their length have exactly IoU 0.5 — and nobody
  looking at that picture would say the model agreed. It is a legibility threshold; no published
  figure depends on it, and it is **not** the automated model gate SPEC says not to invent.
* **The vocabulary is "agreed", never "correct" or "accurate".** This measures one model against one
  archive's labels. rails49/detector's `SPEC.md` § Accuracy makes a generalization estimate a property of a held-out
  protocol over a corpus that does not exist yet.
* **`KIND_COLOR` and `LABEL_INK` live here**, not in three components' `static styles`: the same
  four hues are chips, table cells, scorecard tiles **and** ink passed to `rr-viewer` as a value, so
  they cannot come from a stylesheet. Ground truth draws **neutral white** rather than the editor's
  pink, because pink and the missed-car red are indistinguishable on a layout photograph (#86) —
  every hue on the image belongs to a verdict, and a miss (which has no box) colours its label.

## What the three views draw, and why the viewer holds all of them

`rr-viewer` takes the editor's authored objects (`calibrationPoints`, `sensors`, `cars`), the
live view's per-frame answers (`detections` for L0, `sensorStates` for L1), and the diagnostics
view's per-object inks (`carInks`, `detectionInks`) — and computes none of it.
Rules the code depends on:

* **The inks are parallel arrays, and a short one reads as "no override".** So the live view passes
  nothing and gets today's appearance exactly. A `Detection` is the model's output and a colour is
  the caller's opinion of it; putting the opinion inside the data would make the viewer's input
  something no detector produces.
* **A detection's ink moves `--car-ink` and `--detection-fill` together** (`carMarker.ts` §
  `detectionInk`). One without the other is a coloured wash inside a pink outline. **`renderCar`
  refuses an ink when the class is non-conforming**: that warning is a fact about the archive, and
  letting a verdict about some model overwrite it would cost the labeler the one signal telling them
  to fix it.

* **`sensorStates: null` is not an empty map.** `null` is the editor, where a sensor is being placed
  rather than answered, and the diamond keeps its authored amber. An empty map would be a live view
  that answered no sensor, which `occupancy()` cannot produce — it is total.
* **Shape carries identity, colour carries state.** A diamond is a sensor whatever it reads, so
  `data-state` moves only the `--sensor-ink` literal and the whole symbol recolours together (the
  same one-override mechanism `.car.unknown-class` uses). Red is `occupied` and green is `clear`,
  mirroring prototype signalling and SPEC's deliberate bias where a failure shows occupied.
* **A detection draws at the model's own width, an authored car at the DPT-derived one.** L0 is the
  pose exactly as emitted; substituting the constant would draw a box the model never produced and
  hide the error the raw one shows. L1 *does* substitute it — inside `occupancy()`, where a sensor
  is tested. That is why `renderDetection` takes a `Detection` and `renderCar` takes a DPT, and why
  both live in `carMarker.ts`: a detection is the same object seen from the other side, and giving
  it its own module would mean a second copy of the ink.

`ui/src/geometry.ts`'s `carWidthPx` is **re-exported from `@rails49/detector`, not implemented**.
It was a second copy of the same arithmetic until the live view started drawing detections beside
labels; two copies would let a sensor read `occupied` while sitting visibly outside its rectangle.
