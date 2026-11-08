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

Two more refusals the editor states out loud are at the **image add** (#255, #260). A picked or
captured JPEG's EXIF orientation tag is set to 1 in the bytes the archive holds — the browser
applies that tag and the detector's readers do not — and an image whose stored array is portrait is
then refused rather than rotated, recording nothing and naming the file in a toast. An image whose
stored array is not the size `camera.resolution` declares is refused the same way, naming both
sizes, once anything in the archive is positioned in those pixels; while nothing is, the image sets
the resolution instead. The invariant is that the editor labels the array a downstream reader gets,
so every add — a capture through `addPrepared`, a pick through `addPickedFiles` — goes through
`prepareImage` first, and the size `camera.resolution` takes is measured on the prepared bytes. The
size rule is the session's — `requiredImageSize` answers it, and `addRefusal` words it, because the
message names the file the user picked. `../SPEC.md` § Images states all three rules, why rotating
in the browser was rejected, and why an image of another size is not something the screen can show.

The **track tool** (#284, #317) does what `../SPEC.md` § Track centerlines says; this section
holds what the code keeps true, and which module keeps it.

`trackFit.ts` is the rule, pure. A `Fit` is a start pose and a length and a curvature per part.
`buildLine` takes the clicks with their marks and returns a `Built`: the line, or a refusal and its
reason (`behind`, `tight`, `off-straight`). It builds the whole line on every call and reads nothing
but the clicks, so the same clicks and marks give the same line on screen, in the archive and on
reload, and in either order. A click marked `straight` starts a straight gap; the last click's mark
is not read. A run of neighbouring straight gaps is fitted first (`fitStraight`, total least
squares) and refused if a click lies more than the tolerance off it. Next to a run, `joinCircle`
finds the circle through the two nearest free clicks that touches the run, no tighter than the
minimum radius, within a half turn between the two clicks, and touching the run between the
nearest free click and the run's second click; where there is none, the free gap ends at the foot
of the run's end click. When the circles at both ends of a one-gap run would touch it in the wrong
order, neither is used. The other free clicks take their headings in `headings`, after Akima
(1970), and each free gap is the equal-chord `biarc` between its clicks. The refusals are checked
on the whole line: two neighbouring clicks at one pixel, or a click not ahead of the click before
it along either click's heading, or a run that ends before it starts, is `behind`; an arc tighter
than the minimum radius is `tight`. The constants are `TRACK_FIT`, in gauges: tolerance 0.1 G,
minimum radius 10 G, start distance 1 G. `fitOptions` converts the first two through DPT, and
`insertAt` the start distance; none is stored. `fitNodes` makes a node of the start and of each
part's end, and cuts an arc into equal pieces of at most 90°, which the format's curve between
nodes follows closely. That curve is `@rails49/r49`'s `segment` (FORMAT.md § Node), which
`track.ts` draws and hits through.

`trackChain.ts` holds the gestures. `lineOf` is `buildLine` and `fitNodes` together, giving a
`Track` or the refusal; `refitLine` and `recordLine` do the same for an edit with no chain live,
and refuse through the session. `markedClick`, `withClickAt`, `withClickIn` and `withoutClick` are
the click edits, and keep the marks: an inserted click takes the mark of the click before it, so a
straight gap becomes two, and a deleted click's two gaps become one, straight only if both were.

The click sets in `tests/clickSets/` are part of the rule's regression suite
(`tests/trackFit.test.ts`). Today there is one set, synthetic. A set is a `gauge`, `lines` of clicks
in track order, and a `note` saying where the clicks came from; a set recorded in the editor is a
drop-in file in the directory. The test holds, on every set and on synthetic lines from
`tests/trackClicks.ts`, that the line passes through every click, has no kink, and is the same for
the clicks reversed; that on lines of twelve clicks or more a move, insert or delete changes at most
three gaps on each side; and, on marked lines, that each run is straight and within the tolerance
of its clicks, a curve meets it tangentially, and each refusal happens.

Every entry a track chain writes, a click or a move or delete of a click, writes the line's `clicks`
with their marks in stored order and the `nodes` of their line, as one `layout` entry. A click or
edit the rule refuses writes nothing. A chain continued from a line's first click draws the line
reversed, so the click it goes on from is last (`TrackChain.view`), and puts each new click at the
front of the stored clicks; the line is the same either way. A double-click on the click the chain
goes on from (`EditSession.doubleClick`, `TrackChain.straighten`) asks for the next gap to be
straight. The chain holds that as view state, drawn as a square on its last click, and the next
click writes the mark with itself as one entry; a refused click keeps it, and the end of the chain,
a delete or a change under the chain drops it. `TrackChain.preview` builds the line with a click at
the pointer on every pointer move and writes nothing.

The chain keeps the line from before each entry it wrote, so an undo restores it, and the chain
ends only once every entry it wrote is undone (`TrackChain.settle`). While a chain is live every
click goes on its end, even on a sensor or near another line, and a click within the grab radius
of that end adds nothing. With no chain live (`trackTool`, sharing its lookup with `trackHover`), a
click on a line's first or last click continues it; on a click between them it notifies
`MIDDLE_CLICK`; within `TRACK_FIT.startDistance` of a line it inserts a click at the pointer into the
gap `nearestGap` finds, or notifies `NO_CLICKS` on a line with no clicks; anywhere else it starts a
chain. A drag while a chain is live grabs only a click of the traced line; `TrackChain.hold` draws
the line of the moved clicks, or the last line the rule took, and the release moves the click as
one entry or is refused. With no chain live a drag grabs any line's click, or a press within the
start distance of a line inserts a click and drags it (`_grabInsert`); `_dragLine` writes the line
on every pointer move inside one history gesture, keeps the last line the rule took where it
refuses, and on release writes the rebuilt line or, where refused, the line as it was. The line a
drag holds is `heldLine`. Right-click on a traced click other than the one the chain goes on from
opens Delete click and Delete line and the chain goes on; elsewhere it ends the chain. With no
chain live the menu on a line's gap offers Make straight or Make free (`markGap`), and Delete line.
Deleting one of a line's last two clicks, or the line, ends a chain on it.

The traced or held line draws in place of its stored line, which `rr-editor-view` leaves out of the
viewer's `tracks`. `renderTrack` and `renderPendingTrack` draw the rails and the centerline from the
nodes, a dot per click, and a square at each end of a straight gap (`squareAt`); the pending line is
blue, and a straight mark on its last click draws that click square. `renderTrackCues` draws the
ring on the click the chain goes on from, the preview dashed blue or red where refused, the ring on
an end dot under the pointer and a faint dot where a click would insert. With no chain live the end
dots are hollow (`hollowEnds`). Under another tool `trackDetail` is false and a track draws as its
centerline alone.

A refusal is the one thing the tool says no to. `EditSession.refusal` is set by a refused click,
drag, insert, delete or mark change, which writes nothing and puts a dragged click back, and is
cleared by the next click or edit, the end of the chain or a tool change; the session also toasts
`refusalText` through `subscribeNotices`. `trackHint` is one of three sentences: with a refusal, why
and what to do; while tracing, how to click, mark a straight and end; otherwise, how to start,
continue or change a line. `rr-editor-view` shows it under the DPT bar while the track tool is
selected and DPT resolves, with the preview's refusal in place of the session's while a preview
follows the pointer.

The rule never looks at the photo: it knows the clicks, their marks and one shape rule, a line of
straights and arcs tangent at every join with no radius under `TRACK_FIT.minRadius`. The tolerance
has one job, how far a click of a straight run may lie off it. The tool never marks a gap straight
on its own.

Lines and clicks have no id, so a menu carries the line's first node or the click's pixel and checks
it is still there, and the reveal after an undo lights the changed clicks by pixel. Under any other
tool the track grabs nothing.

The picker takes **several files in one pick** (#262), and the pick — not the file — is the unit:
`addPickedFiles` prepares and judges each file in filename order, hands what survives to
`EditSession.addImages` as **one** history entry, and returns one notice naming everything it
refused, so forty photographs with one 0.5x shot among them cost one Cmd+Z and one toast. The size
the pick is held to is `requiredImageSize`, or, in an archive where nothing is positioned, the first
file the pick accepts — which is the same answer, since that file is the one `addImages` takes
`camera.resolution` from (#254). Each file keeps its own name because the corpus is indexed by those
names outside this program; the collision fallback is the session's, beside the other rules about
what the archive holds (#256).

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
* **Cmd/Ctrl+S is Save and Cmd/Ctrl+Shift+S is Save As**, in the editor view with an archive open
  (#326). The key cancels the browser's Save Page even when a field has focus. It saves nothing on
  a key repeat. It saves nothing from inside an open dialog either, since a dialog's fields commit
  on blur or Enter.

## Every manifest mutation goes through `history.record`

Each `EditSession` owns one `EditHistory` (`src/history.ts`). **Any code that changes
`ManifestData` must run inside `history.record(label, target, mutate)`** — in the session, each write
picks its own target.

Nothing enforces this. A component that reaches into `.archive` directly still typechecks, still
renders, and leaves a stack that is *wrong* rather than merely short: undo then reverses the edit
before it, which is worse than having no undo. Rules, from entries being scoped snapshots:

* **Declare the subtree you actually touch** (`layout`, one `image`, or the `images` array, whose
  entry also holds `camera.resolution`).
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

The car tool and the track tool share the chain (`chain.ts`, #284): `EditSession` runs click, undo,
redo, right-click and drags the same way for both. The rules below are the car's; the track
tool's are under [What the editor builds](#what-the-editor-builds).

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
  sensor point needs no DPT to draw, but #31 asked for both. The **track** tool is gated because the
  rule's constants are in gauges. `needsDpt` is per tool in
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
* `srcObject` is set only when the stream changes (#343). Lit sets an object-valued property on every
  render and each set restarts the video's load, so the binding goes through `live()`.
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
loads `DETECTOR_MODEL_URL`. **Two views open a session through it**: the live view's local result
source (`localModelResultSource.ts`, #330), which runs it per camera frame, and
`rr-diagnostics-view` over an archive's stills.

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
builds and typechecks must keep working with no model present — a release may carry none
(`docs/SYSTEM.md` § The model), and a linked checkout may have none. Without it the live view starts, shows the no-model banner and reports every sensor
`unknown`.

## L1 lives in `occupancy.ts` (#231)

`occupancy()`, `SensorState` and `UnknownReason` are the UI's, not `@rails49/detector`'s
(ADR 0019). Sensors are authored in the editor and training never reads them, so the per-sensor
answer belongs with the app that reports it, and ADR 0005's bias toward occupied is a rule about
that report. What L1 builds on stays in the package: the `Detection` shape and `carWidthPx`, the
width it substitutes for the predicted one. `covers`, the strict point-in-oriented-box test, sits
beside `occupancy()` because nothing else calls it.

It is pure and total — one state per sensor, always — so the live view hands `rr-viewer`'s sensor
markers one answer and never builds an `unknown` itself. Its one caller in the live path is
`localModelResultSource.ts` (#330); the view passes `drifted` and `dpt` in and reads the map back.

**`occupied` carries `confidence`, and the covering `detection` only where there is one.** Geometry
over L0 answers with a box; a classifier answers with P(occupied) and no box at all (ADR 0022), so
the number is the part every occupied state has and the box is the extra. `clear` still carries
nothing.

**`unknown` has two shapes, and that is a compile-time check.** A cause *this page* found is one of
the closed `UnknownReason` set, which `sensorMarker.ts` words in a total `Record` — adding a cause
is a type error there. That set includes the two causes this page finds about a service: its answer
cannot be read (`no-service`), or it named no state for a sensor (`not-reported`). A cause an
occupancy service found arrives as `serviceReason` and is shown as sent (#331): this page cannot
enumerate the service's causes, and rewording them would be inventing a vocabulary for somebody
else's measurement.

## Frames and results come from sources (#330)

`rr-live-view` owns a loop; it no longer owns a camera or a model. The loop asks a **frame source**
for a frame and then a **result source** for that frame's L0 and L1, both declared in
`ui/src/liveSources.ts`:

* `FrameSource` — `start()`, `stop()`, `next()`, plus the `stream` `rr-viewer` shows and the
  `settings` the drift rows record. `next()` resolves with the next frame to run on and with `null`
  once the source has stopped, which is the loop's **one** way out. It is also the loop's pacing:
  the camera waits one animation frame per frame, exactly as the `requestAnimationFrame` loop in the
  view did, and a service would wait on its poll instead. A source that resolved synchronously would
  spin the loop in microtasks and starve every timer on the page.
* `ResultSource` — `open()` answers with the message to show or `null`, `close()` releases the model,
  and `resultFor(frame, { drifted, dpt })` answers with L0, L1 and an optional inference time.
  It **never rejects**: a frame that fails is one frame, and the loop must keep running and report
  `unknown` for it rather than freezing the last answer on screen. The loop does not bet the session
  on that contract either — a rejection is logged and the frame skipped, because a loop that died
  there would leave the last answers on screen for the rest of the session. `open()` after a
  `close()` is a **new session**, not a reversal: a source the app holds across mounts is handed
  back on the next one.

**Nothing is acquired for a session that is over.** The camera is awaited before the loop starts, and
the permission prompt is a dialog the user can walk away from — so `connectedCallback` re-checks
`isConnected` before opening the result source or the drift check, and `cameraFrameSource` stops a
stream granted after its `stop()`. An unstopped track holds the camera until the page is reloaded.

The two implementations are the local ones. `cameraFrameSource.ts` holds the `MediaStream` and reads
the frame back out of the `<video>` **`rr-viewer` mounted** — the viewer is what the user is looking
at, and a second element would decode the same stream twice; it is handed a getter because `@query`
resolves after the first render and the camera is acquired before it. `localModelResultSource.ts`
holds the detector's lifetime, the inference time and the load error, and is the only caller of
`occupancy()` in the live path.

**What stays in the view is its own judgement**: the drift check and the refusal, the three notices,
the recording, `_dpt` — resolved once from the archive, so #166 stays one fix — the frame rate, and
showing the source's error and inference time. None of it changes with what is answering, which is
the whole point: a video file or a service (#286, #331, rails49/detector#64) reaches the same gate.

**A source may show a picture, and may bring its own layout** (#331). Two optional fields carry
that, and both exist because a service is one object answering both halves:

* `SourceFrame.src` is an object URL `rr-viewer` shows through its `src`. The **source** created it
  and the source releases it; the view holds only what to show, and nothing reads pixels back out of
  the viewer. A stream source sets nothing and `FrameSource.stream` is the handover as before.
* `ResultSource.layout` is the sensors, the `resolution` and the DPT the answers are about, and it
  is a **getter the view reads every frame**. A service re-reads its manifest whenever its event
  stream reconnects, and a sensor that moved has to reach the viewer along with the state keyed on
  it. With a layout present the view takes sensors, resolution and DPT from there instead of from
  `archive` — which is why an unsaved edit in the editor cannot move what the live view draws.

**`SourceFrame.fresh: false` is a turn that carried no new picture.** The service answered, and the
answer held no frame: it has none, or the request failed. The last picture stays up, the rate reads
**0** rather than the last measurement, no drift sample is grabbed from it — there are no new pixels
to measure — and the answers that came with it are written as usual. That last part is the point:
every sensor reads `unknown` with the source's reason instead of the previous frame's answers
freezing on screen, which is the failure mode #341 named for a source that cannot answer.
`FrameResult.notice` is the reason, rendered as a notice and cleared by the next answer, and
`FrameResult.detections` **absent** means no L0 was published at all — no boxes and no car count —
where an empty list means a model looked and found none.

**Service mode is sources handed in with no archive** (#331, `_judging`). In it the view runs no
drift check and shows no drift banner, recorder, alignment readout, or model and DPT notices, and the
stats bar shows Cars only with L0 and never Inference: the service publishes states this page cannot
withhold (drift in service mode is #336). The camera path, with or without an archive, is as it was.
Opening or creating an archive leaves a service behind in `rr-app`. The source's `open()` error is
still shown either way, in the words that fit who failed.

**`sources` is read on connect.** The loop, the drift check and the result source's lifetime all hang
off one mount; swapping a source mid-session would mean tearing down and rebuilding all three, and a
different source is a different session.

**`ResultContext` is live, and that is load-bearing.** `drifted` is a *getter* over the view's
refusal, so a source reads it when it is about to answer rather than when it was called. Drift is
sampled beside the loop and lands whenever the check finishes, so a sample that lands while this
frame is being inferred refuses *this* frame — which is what the gate did while the loop and the
model were one file. Destructuring `drifted` in a parameter list reads it on entry and costs the
refusal a frame; `tests/rr-live-view.test.ts` is what catches that.

**One object may be both sources.** A service answers with a frame and its results together, so #331
hands the same object in twice; a frame may carry data only its own source reads, which is why
`SourceFrame` is a floor and not a ceiling.

The frame check used to have an image branch, reading `rr-viewer`'s `getImageElement()`. It is gone:
the live view never sets `src`, so it could not run. `getImageElement()` itself stays on the viewer
with no caller.

`tests/rr-live-view.sources.test.ts` drives the view with **fake** sources — each result reaching the
viewer and the stats bar, `drifted` and `dpt` reaching `resultFor`, leaving the view stopping both,
and (since #331) a source shaped like a service: the picture through `src`, the layout re-read every
frame, a turn with no new frame, and none of the page's own notices — and
`tests/rr-live-view.test.ts` is unchanged but for the `SensorState` shape, which is the evidence that
the camera and the shipped detector still behave the way they did through the same loop. jsdom decodes no video, so the camera
path is driven there with a stand-in `<video>` and measured by hand in Chromium.

## An occupancy service is found at `/live` and read in one place (#331)

The page asks `/live/archive/manifest.json` once, when `rr-app` connects. **Only a JSON content type
counts as a service**: the deployed copy answers every unknown path with 200 `text/html`, so
`response.ok` alone would find one on a static host. Any other answer, and any network failure, is no
service and the page is what it has always been, with no toast. `liveContract.ts`'s `findService`
returns the **`Response`**, not a boolean, so #333 can read its `ETag` and open the manifest it
already fetched.

`/live` is one constant and not a setting. A cross-origin service is out of scope, everything the app
fetches comes from origin anyway (ADR 0006), and a base somebody could type would be a second way for
the page to be wrong about what it is watching.

**`liveContract.ts` is the only file that names the wire.** The paths, the part names (`json` and
`frame`), the field names, the version and the five-second timeout are there, and `readLatest` is one
function over `response.formData()` — the browser already has a multipart parser, and the hand-rolled
one in rails49/control#950 exists only because WebKit refused that type there. If `formData()` turns
out to fail on a real iPhone (#331's human step) that function is the one place that changes. It
throws a `LiveError` naming what was wrong, and the payload is validated field by field: this is the
network, and a field of the wrong type otherwise reaches a sensor marker or a box drawn at `NaN`.

**`occupancyService.ts` is one object that is both sources.** The service answers a frame and that
frame's L1 together, so two sources would mean two requests for one answer and L1 that could belong
to a different frame than the picture under it. The rules it keeps:

* **It never rejects.** Every failure — a non-2xx, an answer that is not the multipart form (this
  page's own HTML from a proxy whose service is down), a malformed body, a wrong version, a request
  with no answer in five seconds, a frame that will not decode — becomes one answer in which every
  sensor reads `unknown` (`no-service`) under the notice "Cannot reach the occupancy service". The
  detail goes to the console, and it asks again after about a second. The frame it hands over is the
  one already on screen, marked `fresh: false`.
* **An answer with only the `json` part is the service having no frame.** The picture on screen
  stays, with no boxes, under the notice "No picture from the camera", and each sensor reads
  `unknown` with the reason the service sent for it. `LIVE.md` has the service wait about a second
  before answering so, and has `after` wait up to about a second for a new frame, so the service
  paces the loop and this object adds no pause of its own.
* **A frame is new when its id *differs* from the last, not when it is greater.** The id is the
  service's token, sent back as `after` unchanged, never parsed or ordered — so a service that
  restarted and numbered from scratch recovers on its next answer rather than being ignored for the
  rest of the session. An answer repeating the id is not a frame and it asks again.
* **`next()` resolves only once the frame has decoded**, so asks cannot outrun a slow device. Each
  object URL is released when the next frame replaces it on screen, and on leaving. Nothing reads
  pixels back out of `rr-viewer`: the frame goes in through `src`.
* **L1 on screen comes only from `latest`**, so it always belongs to the frame shown. One
  `/live/events` connection is held and **no message is read from it** — L1 arriving there would be
  about another frame. What the stream is for is the *connect*: every connect after the first
  re-reads the manifest, because occupancy-service#7 drops every event client after a save and a
  connect is therefore the full list of sensors. A failed re-read keeps the held manifest, which was
  true a moment ago. A connection that closed for good — which a non-200 answer does, and
  `EventSource` does not retry — is reopened after a few seconds.
* **The manifest is the service's**, validated by `R49Archive.setManifest`, and it is what
  `ResultSource.layout` reports. So an unsaved edit in the editor cannot move what the live view
  draws, and a sensor the manifest does not have is not drawn and so is not answered.

**The service is left behind by New and Open, for good.** Both pass through `rr-app._open`, and
`_leftService` also ignores a manifest answer that arrives afterwards. Only a reload finds the
service again.

`bin/live-stub.mjs` is a stand-in service for checking this by hand on a device, and serves the built
page from the same origin because `/live` has to be. It is not the service — rails49/occupancy-service
is — and `README.md` § Checking the live view against a service has the commands.

## Camera drift lives in `driftSession.ts`, and only the live view measures it (#89, #252)

`ui/src/driftSession.ts` is the drift path's `detectorSession.ts`: the sole place that holds a
canvas for it. `@occupancy/drift` takes a `GrayPlane` and not an `ImageData` on purpose — the
benchmark is a Node program and a first-class consumer, so making the browser's type the boundary
would lock out the thing that proves the check works — which leaves somebody to do the decoding, and
this is that somebody. It exports `openDriftCheck(archive)`, `grabPlane(source, w, h)` and
`planeFromBytes(bytes)`.

**One image defines the pose: `images[0]`, the first thumbnail in the strip** (#118). What shipped
first made every image a reference and scored the minimum over them, which had a hole — an image
captured from a moved camera and kept anyway joined the reference
set, so the drifted pose then scored ~0 and the refusal never fired again. One accepted warning
permanently widened the accepted pose.

Position 0 closes it: dragging a thumbnail to the front re-points the comparison. Since the editor
stopped showing drift, nothing on screen shows that change (ADR 0020).

**References are decoded at their native resolution, and that is load-bearing.** `displacementPx` is
reported in the frame of the *first* reference, so handing the check pre-shrunk images silently
rescales every number — while the tolerance is expressed in `camera.resolution` pixels. The check
clamps to its own working resolution internally; letting it do that is what keeps the number meaning
one thing.

**The tolerance is a fraction of a track width, and `maxDriftPx(dpt)` here is the only place that
multiplies.** `MAX_DRIFT_TRACK_FRACTION` (0.5), a constant beside it, times the layout's DPT — which *is* pixels per
track gauge — gives the tolerance in the frame the sensors were authored in. A fraction rather than a
pixel count because the failure is geometric: occupancy breaks when a sensor stops sitting on the car
it reads, and both boundaries for that (falling off the box, sliding onto a neighbouring track's car)
sit near one whole track width, so half a track is the most that can still be read as the pose. The
same *pixel* count would mean five times as much misalignment at DPT 18 as at DPT 90. `null` DPT
yields `null` and the verdict is withheld: those sensors already read `unknown` / `no-calibration`,
and a fabricated tolerance would be a second wrong answer in a quieter voice.

**The fraction is a reading, not a derivation.** The geometry above bounds it from above and says
nothing about where inside that bound to sit. What fixed it is the ceiling rig: one step of the check
is 0.257 of a track width there, so the 0.25 this replaced sat *below* the smallest non-zero reading
the check can report, and 18 of 32 frames from a camera nobody had moved were refused. 0.5 admits one
step and still refuses two. The readings, the derivation and what the session did not measure are in
[`docs/research/drift-tolerance-measured.md`](research/drift-tolerance-measured.md); the value is
provisional until the occupancy service's check has run
([rails49/occupancy-service#12](https://github.com/rails49/occupancy-service/issues/12)).

> This replaced an absolute `max_drift_px` of 0.5 — the check's own quantum. That number conflated a
> **detection floor** with a **tolerance**: it was unreachable without precision mounting and said
> nothing about when occupancy actually breaks. A tolerance should sit above what the check can
> resolve, not on it — and 0.25 of a track width turned out to repeat that mistake on a 48 MP
> frame, where it fell under the quantum again.

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

**The editor measures no drift** (ADR 0020).

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
