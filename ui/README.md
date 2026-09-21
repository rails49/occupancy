# UI

Web app for configuring track occupancy detection, plus a live view for real-time observation.

Everything runs client-side: `.r49` archives are opened and saved through the file picker, and
classification runs in the browser via ONNX Runtime. There is no backend.

* **`../SPEC.md`** — what the system is *for*, and the requirements it is working toward. Covers the
  whole project, not just this package. Much of it is not built yet; treat it as the target, not a
  description.
* **`CLAUDE.md`** — build, test, and deploy mechanics, and the invariants an edit can break.
* **This file** — the component reference: what exists today, and each component's interface.

## Naming conventions

### Custom element prefix: `rr-`

All custom elements use the `rr-` prefix (**r**ail**r**oad).

- The HTML spec requires a hyphen in custom element names, to distinguish them from future standard
  elements.
- `rr-` does not collide with common library prefixes (`sl-` for Shoelace, `md-` for Material).
- Registrations are `rr-<noun>` or `rr-<noun>-<qualifier>`: `rr-app`, `rr-viewer`, `rr-editor-view`.

### File naming

| Kind | Convention | Example |
|---|---|---|
| Lit custom element | `rr-<name>.ts` | `rr-viewer.ts` |
| SVG template module | `<name>.ts` | `carMarker.ts` |
| Utility / service | `<name>.ts` | `capture.ts` |
| Test file | `<name>.test.ts` in `tests/` | `tests/marker.test.ts` |

Non-element modules use plain camelCase filenames with no prefix.

---

## Component hierarchy

```
rr-app                          ← shell: owns the archive and the view mode
├── rr-header                   ← app bar: status slot, mode control, source link, settings gear
│   └── rr-settings-dialog      ← layout metadata + required-metadata gate (sl-dialog)
├── rr-editor-view              ← editor mode; images, DPT readout, calibration points, sensors, cars
│   ├── rr-toolbar              ← vertical icon bar (file ops + undo/redo)
│   ├── rr-tool-palette         ← active tool, and the calibration gate on the labeling ones
│   ├── rr-viewer               ← SHARED: media + SVG overlay; reports pointer gestures
│   │   ├── calibrationMarker.ts ← module, not an element: the labelled crosshair
│   │   ├── sensorMarker.ts     ← module: the labelled diamond, recoloured by L1 state
│   │   └── carMarker.ts        ← module: the authored chord + rectangle, and the L0 box
│   ├── rr-thumbnail-bar        ← horizontal image selector strip
│   ├── rr-calibration-dialog   ← asks for a point's x/y/z in mm (sl-dialog)
│   ├── rr-sensor-dialog        ← asks for a sensor's optional name (sl-dialog)
│   └── rr-context-menu         ← right-click verbs on one object (sl-menu)
├── rr-live-view                ← live mode; owns the detector and the L0→L1 loop
│   ├── rr-stats-bar            ← FPS / cars / occupied / inference / drift overlay
│   └── rr-viewer               ← SAME component, video source instead of img
│       ├── sensorMarker.ts     ← the diamond, coloured by occupied / clear / unknown
│       └── carMarker.ts        ← renderDetection: the dashed L0 box
└── rr-diagnostics-view         ← diagnostics mode; sweeps the archive, owns the results
    ├── rr-diagnostics-report   ← scorecard, sortable per-image table, crop strip
    │   └── rr-viewer           ← SAME component, one crop per finding (zoom rect)
    └── rr-diagnostics-queue    ← one disagreement at a time, on one image
        └── rr-viewer           ← SAME component, zoomed to the finding
```

> **The editor authors calibration points, sensors and cars.** v3's point-marker
> placement and two-point calibration dragging were removed in the v4 reduction
> ([#19]); v4 stores neither. [#27] added the provisioning — `rr-viewer`
> reporting pointer gestures in image pixels, and `geometry.ts` holding the
> car-width, rectangle and hit-testing arithmetic — and [#28] gave it its first
> consumer: click a pixel, type its world coordinate, and the point is written as
> one `layout` history entry. [#30] added the drag — the same point moves, and
> the whole gesture costs exactly one entry. [#29] added the right-click: a
> context menu on the object under the cursor, carrying delete, which is why the
> editor needs no delete mode. [#31] added the **tool palette** and the
> **calibration gate** — while DPT is `null` the labeling tools are disabled and
> the reason is stated — and **sensor authoring** on top of the same shared
> paths: click to place, click or the menu to name, drag to move, menu to delete.
> [#32] added **car authoring**: two clicks on the visible ends write one span
> per image, drawn as a chord inside the translucent width rectangle that DPT
> derives — which is what the gate exists for. [#33] made those clicks a
> **chain**: every click after the first ends one car and starts the next, a
> rubber band shows the chain in flight, right-click ends it, a coupling renders
> as one shared handle that drags both cars, and undo is intercepted by the
> chain it would otherwise reach past. [#35] added **reclassify**, the context
> menu's submenu generated from the authored vocabulary. [#36] added the
> **completeness affordance**: a `labeled_complete` checkbox for the image on
> screen, a badge per image in the thumbnail bar, and one history entry per
> toggle — plus the decision that **deleting a car clears the flag**, recorded
> with its reasoning in `../SPEC.md` § Labeling completeness. [#41] made the
> media and the overlay resolve to **one box** at every window size, so an object
> no longer drifts off the pixel it names as the window is resized. [#43] refused
> the **first** click of a new chain when it lands inside a car already labelled
> on that image, so a second box cannot be stacked on the same vehicle. [#37]
> finished the reveal: an undo or redo now **highlights the object it changed**,
> and the toolbar names the image when the edit lands on one the user is not
> looking at. [#44] added **zoom**: a drag on empty image draws a rect to zoom
> to and pans once zoomed, Shift-drags anywhere, and one transform above both
> the media and the overlay keeps every screen-pixel tolerance and world-pixel
> size correct with no arithmetic changed.
>
> [#19]: https://github.com/rails49/occupancy/issues/19
> [#27]: https://github.com/rails49/occupancy/issues/27
> [#28]: https://github.com/rails49/occupancy/issues/28
> [#29]: https://github.com/rails49/occupancy/issues/29
> [#30]: https://github.com/rails49/occupancy/issues/30
> [#31]: https://github.com/rails49/occupancy/issues/31
> [#32]: https://github.com/rails49/occupancy/issues/32
> [#33]: https://github.com/rails49/occupancy/issues/33
> [#35]: https://github.com/rails49/occupancy/issues/35
> [#36]: https://github.com/rails49/occupancy/issues/36
> [#37]: https://github.com/rails49/occupancy/issues/37
> [#41]: https://github.com/rails49/occupancy/issues/41
> [#42]: https://github.com/rails49/occupancy/issues/42
> [#43]: https://github.com/rails49/occupancy/issues/43
> [#44]: https://github.com/rails49/occupancy/issues/44
> [#48]: https://github.com/rails49/occupancy/issues/48
> [#49]: https://github.com/rails49/occupancy/issues/49
> [#52]: https://github.com/rails49/occupancy/issues/52
> [#7]: https://github.com/rails49/occupancy/issues/7
> [#82]: https://github.com/rails49/occupancy/issues/82
> [#85]: https://github.com/rails49/occupancy/issues/85
> [#87]: https://github.com/rails49/occupancy/issues/87
> [#94]: https://github.com/rails49/occupancy/issues/94
> [#95]: https://github.com/rails49/occupancy/issues/95
> [#118]: https://github.com/rails49/occupancy/issues/118
> [#139]: https://github.com/rails49/occupancy/issues/139
> [#148]: https://github.com/rails49/occupancy/issues/148
> [#149]: https://github.com/rails49/occupancy/issues/149

## State and data flow

There is no Lit context and no shared store. `rr-app` holds the single `R49Archive` and passes it
down as the `.archive` property; children report upward with bubbling `rr-*` custom events:

```
        .archive ↓                    ↑ rr-* events (bubbles: true, composed: true)
rr-app ─────────── rr-editor-view ─────────── rr-viewer / rr-toolbar / rr-thumbnail-bar
   │
   └─────────────── rr-live-view ───────────── rr-viewer / rr-stats-bar
```

* **`rr-app` owns:** the archive, the **undo history**, the view mode, the status string, and file
  new/open/save.
* **`rr-editor-view` owns:** the current image index, blob URLs for the images, **the active tool**,
  the **chain in progress** (`EditorMode`, plus the cursor the rubber band follows), the click that
  is waiting on a coordinate or a name, and what the context menu is open on. It mutates the archive
  through image add/remove/reorder, through calibration-point placement, edits and deletion, sensor
  placement, naming, drag and deletion, and through car placement, drag and deletion — each wrapped
  in `history.record` (or in one `beginGesture` per drag). It also owns the one control that sets
  `labeled_complete`, which is the only place in the format a human asserts something about absence.
  A chain in progress is **view state**: an
  anchor writes nothing until the click that closes a car on it, so abandoning one leaves both the
  manifest and the stack untouched — however many cars the chain already wrote, since each of those
  is its own committed entry. **The zoom is view state too** ([#44]): a rect of the authored frame
  it hands the viewer, `null` for fit. It records nothing, it survives an image change and a live
  chain, New and Open drop it, and a **reveal pans to keep what an undo changed on screen** —
  panning at the same zoom level where the changed objects fit, and fitting where they do not.
* **`rr-live-view` owns:** the camera stream, the detector, and the detection loop. It never
  mutates the archive.
* **`rr-diagnostics-view` owns:** one sweep of the archive — a detector session, blob URLs, the raw
  detections per image, the confidence floor, and which image (if any) is being reviewed. It never
  mutates the archive either; diagnostics is read-only by construction, so nothing it shows can
  change what it is measuring. The sweep runs at a **confidence floor far below the shipped
  threshold** and filters afterwards, which is what makes the threshold control free: re-scoring is
  pure arithmetic where re-running inference is twenty seconds of WASM.
* **Only two views load a model, and they load it the same way.** Both go through
  `detectorSession.ts`, which is the one place `ort.env.wasm.wasmPaths` is set and the one place the
  model URL is read. The CNN is retained and retrainable
  but nothing loads it ([#7], [#85]): L1 is a pure function of L0, so the per-sensor answer is a
  geometric consequence of the detector's boxes and there is nothing for a second model to say.

Lit does not observe mutations *inside* `R49Archive`, so handlers that edit the manifest in place
call `this.requestUpdate()` explicitly.

**Every manifest mutation goes through `history.record`** (see `history.ts`), so an edit made by
reaching into `.archive` directly leaves an undo stack that is wrong rather than short. Children
report a recorded edit upward with `rr-history-change`, which is what re-renders the toolbar's
enabled state.

---

## Component reference

### `rr-app`

Application shell. Owns the archive and routes between the two views.

**Internal state** (no public properties): `_archive`, `_history`, `_viewMode` (`'editor' | 'live'`),
`_status`, `_binding`. Starts with no archive loaded and no binding.

**Handles:** `rr-view-toggle`, `rr-layout-change`, `rr-file-new`, `rr-file-open`, `rr-file-save`,
`rr-undo`, `rr-redo`, `rr-history-change`, `rr-notify`.

`rr-notify` is a child's transient message, toasted here because this is where toasts live. It is
raised at `warning`, never `danger`: everything that reaches it is the editor **declining** to
author something, which is the editor working rather than failing.

**Keyboard:** Cmd/Ctrl+Z and Cmd+Shift+Z / Ctrl+Y, bound on `window`, **editor view only**. The
handler bails when a field has focus, testing `event.composedPath()[0]` rather than `event.target` —
Shoelace inputs are custom elements, so `target` is retargeted to the host and the naive check would
hijack Cmd+Z mid-typing. A press with a drag still live returns nothing (see `history.ts`), and
`_undo`/`_redo` already do nothing when the stack hands back no entry.

* `rr-file-new` and `rr-file-open` **confirm before discarding unsaved changes** (`_history.isDirty`),
  since replacing the archive takes the undo stack with it. **Closing or reloading the tab is guarded
  by the same predicate** ([#49]): a `beforeunload` listener registered in `connectedCallback` beside
  the keydown one, permanently, with `isDirty` checked at fire time. It calls `preventDefault()` *and*
  sets the legacy `returnValue`, and shares nothing with `_confirmDiscard()`, which answers with a
  boolean `beforeunload` cannot use — all it may do is cancel and let the browser ask, in wording
  nobody can set. Together these are the destructive acts undo cannot cover.
* `rr-file-save` marks the history position saved rather than clearing it — undoing past a save is
  legitimate, because the bytes on disk are unaffected.
* Undo and redo reveal what they changed, in the order the invariant states ([#37]): `selectImage`
  on the **pending** entry's image, then the apply, then `syncFromArchive(filename, highlights)`,
  which lights the objects the entry touched. `undoImage`/`redoImage` go down with the labels so the
  editor can qualify the tooltips.
* **Undo is offered to the editor first** ([#33]): `_undo` awaits `rr-editor-view.interceptUndo()`
  and stops there when it returns true. A live chain is a wall undo cannot cross, and only the editor
  knows one is live — so the protocol is one question asked here rather than chain state pushed up.
  Redo is not offered: only undo is state-dependent (`../SPEC.md` § Undo and redo).

* `rr-file-new` builds an empty **v4** manifest — layout `'New Layout'`, scale `N`, resolution
  1920×1080, empty calibration points and no sensors. It **clears the binding**: the new archive is
  emphatically not the file that was open.
* `rr-file-open` and `rr-file-save` go through `persistence.ts`, which owns the choice between
  overwriting a file and downloading a new generation ([#48]). The binding is set **only once the
  bytes parse** — a binding to a file that failed to load would aim the next save at an archive this
  session never held.
* `rr-file-save` `export()`s and hands the bytes to `writeArchive`, with `detail.rebind` from the
  toolbar meaning Save As. A dismissed picker returns early: nothing written, nothing marked, no
  toast. Everything else marks the history saved, including a download — the fallback did write a
  file, and refusing to mark it would leave a phone permanently dirty. The toast names the verb and
  the file, because "Saved to disk" would hide which of the two things just happened.
* The **stem** is the binding's, falling back to `layout.name` for an archive that has never been
  saved. It does not follow a later rename: the file's identity is the file, and `layout.name` is
  metadata stored inside it.
* The header's status carries the bound filename in a `.bound-file` span **only when a handle
  exists** — that is exactly when Save would overwrite it. A binding without a handle names no file
  that exists yet. The span is styled in `rr-app` because slotted content is this component's DOM.
* It also carries the layout's **scale** in a `.layout-scale` span ([#52]), read out of the manifest
  on every render so a scale changed in the settings dialog is the one shown. It is stated **only
  once a manifest has been read**: the `N` the render falls back to is a placeholder giving
  `rr-settings-dialog` something to render against — it matches that component's own default but is
  not bound to it — and is an answer no archive gave, so with nothing open the header names no scale
  rather than inventing one.
* **Saving does not validate calibration.** The v3 check read `{p0, p1, size_mm}` structurally, which
  v4 has not — calibration is a list of points that legitimately starts empty, so "uncalibrated" is a
  state the editor reports rather than an error to refuse a save over.

Feedback is a Shoelace `sl-alert` toast (`_notify`), not `alert()`.

---

### `rr-header`

Top app bar. Renders the mode control, the status slot, a source link, and the settings gear; hosts
`rr-settings-dialog` and opens it imperatively via its `show()` method.

The source link is an `sl-icon-button` with an `href`, so it renders as an anchor rather than a
button: `target="_blank"` opens the repository in a new tab and leaves this page — and the archive
held in memory with it — untouched. The `rel` is Shoelace's, not ours (it emits
`noreferrer noopener` on the anchor for any `target`), so the test asserts it there rather than on
the host, where a `rel` attribute would be inert. The URL is a module constant, not a property; the
element's interface is unchanged by it.

The mode control is a **segmented control, not a toggle** ([#87]). Two modes could cycle on one
button because "the other one" is unambiguous; three cannot — from Live, a user wanting Diagnostics
would have to guess whether the button steps forward or back, and one destination ends up two clicks
away with nothing on screen saying which. So every mode is one click, and the control marks the mode
you are **in** rather than showing the icon of where you would go next.

| Property | Type | Description |
|---|---|---|
| `viewMode` | `ViewMode` (`'editor' \| 'live' \| 'diagnostics'`) | Which mode is marked current |
| `layout` | `object` | Passed through to `rr-settings-dialog` |
| `requiredMissing` | `readonly MissingRequirement[]` | Passed through; non-empty makes the dialog a gate |

| Slot | Content |
|---|---|
| `status` | Status text; falls back to "Occupancy UI" |

**Emits:** `rr-view-change` — `{ mode: ViewMode }`. Clicking the current mode emits nothing.

---

### `rr-settings-dialog`

Layout metadata, in an `sl-dialog` with a single "Layout" tab: name, scale (from `VALID_SCALES`),
camera height, description, and contact. It is also the **required-metadata gate** ([#139]).

| Property | Type | Description |
|---|---|---|
| `layout` | `{ name?, scale, description?, contact?, calibration? }` | Current layout; defaults to scale `N`. `calibration` is read, never spread back |
| `requiredMissing` | `readonly MissingRequirement[]` | What the layout still owes, from `requiredMetadata.ts`. Non-empty ⇒ the dialog opens itself and refuses to close |

**Methods:** `show()`, `hide()`.

**Emits:** `rr-layout-change` with `{ layout: Partial<Layout> }` — one changed field per event —
and `rr-camera-height-change` with `{ camera_height_mm: number | undefined }`.

**The gate opens itself and will not be dismissed while `requiredMissing` is non-empty**: every exit
(`close-button`, `keyboard`, `overlay`) arrives as `sl-request-close` and is cancelled there, and the
footer button is disabled. One rule covers both cases SPEC names — a new archive has no camera
height, so New trips it; an archive already carrying everything opens straight through and this
dialog never appears. There is no "was this a create?" flag: the state of the manifest is the
trigger. Enforcement is here rather than in the schema because a required *field* would fail every
archive predating it, while a required *dialog* migrates one on its first edit.

The camera height leaves on its **own** event because it lives inside `calibration`, and spreading
that object from here would carry a copy of `points` with it — stale the moment anything else edits
them. An emptied field emits `undefined`, never `0`: absent means "unknown", which the fit has a
defined fallback for, whereas `0` would be a camera at layout zero.

Text fields fire on **`sl-change`** (blur or Enter), not `sl-input`. Per keystroke, each character
would become its own undo entry, so Cmd+Z would chew backwards through a name one letter at a time.
One entry per editing session is the unit the user perceives.

The "Ref Size (mm)" input is gone: it wrote v3's single `size_mm`, and v4's calibration points each
carry their own world coordinate instead.

Classifier selection is **not implemented**: there is no classifier tab, and the
`rr-classifier-change` event named in the source JSDoc is never fired. Classifier config comes from
`models/config.json` at runtime and is deliberately not stored in the manifest.

---

### `rr-toolbar`

File actions and undo/redo. A column at the side of the editor, and **a row at or below
`COMPACT_MAX_HEIGHT_PX`**, where it and the tool palette share a strip along the top instead
([#42]). See `layout.ts`.

| Property | Type | Description |
|---|---|---|
| `canUndo` | `boolean` | Enables the undo button |
| `canRedo` | `boolean` | Enables the redo button |
| `undoLabel` | `string \| null` | Phrase for the tooltip — "Undo delete image", or "Undo delete car — img_3.jpg" when the entry lands on another image. **Arrives qualified**: `rr-editor-view` composes it, since only it knows which image is on screen |
| `redoLabel` | `string \| null` | As above, for redo |

**Emits:** `rr-file-new`, `rr-file-open`, `rr-undo`, `rr-redo` (no detail), and `rr-file-save` with
`{ rebind: boolean }` — true for a **Shift-click, which means Save As** ([#48]).

Save As is a modifier rather than a sixth button for two reasons. The button count is load-bearing:
`layout.ts` measures `COMPACT_MAX_HEIGHT_PX` from *five* toolbar buttons and three palette ones, so a
sixth would need that breakpoint re-measured. And on a browser without the File System Access API,
Save As does exactly what Save does — a visible control there would be a second button needing an
explanation for why it changes nothing. The tooltip carries the discoverability, and **names the
modifier only where the browser can honour it**.

The buttons are not a duplicate of the keyboard shortcuts. Their **disabled state** is the only
signal separating "the stack is empty" from "the undo landed on an image you are not looking at",
and touch devices have no Cmd+Z at all.

The v3 labeling tools (`track`, `train`, `coupling`, `other`, `delete`, `calibrate`) and the
`rr-tool-select` event they fired are gone, along with `activeTool` and `disabled`. **The palette
did not come back here**: [#31] gave it its own element, `rr-tool-palette` below, so file actions and
tool selection stay separable.

---

### `rr-tool-palette`

Selects the active tool, and carries the **calibration gate**.

| Property | Type | Description |
|---|---|---|
| `tool` | `EditorTool` (`'calibration' \| 'sensor' \| 'car'`) | The active tool. The editor owns it |
| `calibrated` | `boolean` | Whether DPT resolves. False disables every gated tool |

**Emits:** `rr-tool-select` `{ tool }`. Nothing is emitted for a disabled tool, or for the tool that
is already active.

**While `calibrated` is false the sensor and car tools are disabled and the reason is stated.** The
reason names **DPT** rather than the width rectangle. The rectangle is why the *car* tool is gated —
car width is derived rather than stored, so an uncalibrated archive cannot draw what tells a user
whether a label covers the car — but a sensor is a single point and would draw fine uncalibrated, so
blaming the rectangle would put a false reason on the one tool whose gating is a deliberate
deviation. Calibration itself is never gated: it is the tool that *produces* the DPT.

The reason lives in the page (`.gate-reason`), not in the buttons' tooltips: a disabled
`sl-icon-button` takes no pointer events, so a tooltip on one never opens. The gate is on **existence, never completion** (`../SPEC.md`
§ Labeling Workflow) — two points at a nonzero separation, which is exactly "`getDPT` returns a
number" — and it opens and closes live, so an undone calibration disables the tools again.

> The sensor tool is gated with the car tool at [#31]'s request, one step beyond `../SPEC.md`
> § Labeling Workflow ("sensors can be placed at any time"). `needsDpt` is per tool in the source, so
> that is one flag to flip if it is revisited.

The `car` tool authors a two-click span through `rr-editor-view` ([#32]); this element only says
which tool a click means.

At or below `COMPACT_MAX_HEIGHT_PX` the palette lies down beside the toolbar in a strip along the
top ([#42]), and the gate reason moves from under the buttons to beside them — at the same size,
wrapped to a short measure, because a disabled control's stated reason has to stay legible at the
size the control is hardest to reach at. See `layout.ts`.

---

### `rr-sensor-dialog`

Asks for a sensor's **optional** name. Opened imperatively with `show(name, { id })`, like
`rr-calibration-dialog`, because the value it starts from belongs to the gesture.

**Emits:** `rr-sensor-name-commit` `{ name: string | null }`. `null` is "no name" — a cleared field
is how a name is *removed*, and the editor writes that as the absence of the key rather than as `""`.

Naming is separate from placing, because a sensor with no name is complete: consumers key on `id`,
and `name` is optional passthrough that is never auto-generated (`../SPEC.md` § Occupancy Output).
The dialog shows the id it is naming, which is what the editor displays in its place.

---

### `rr-thumbnail-bar`

Horizontal strip of image thumbnails, with drag-and-drop reordering. It also **shows which images
are labeled complete** — a green check badge, bottom-left — because scanning a set for what is left
to label is the workflow and must not require selecting each image in turn.

The badge is a **readout, not a control**: `labeled_complete` is asserted through `rr-editor-view`'s
own checkbox for the image on screen, so a click aimed at selecting an image cannot assert
completeness by landing a few pixels off. See `SPEC.md` § Labeling completeness.

| Property | Type | Description |
|---|---|---|
| `images` | `string[]` | Image URLs (blob URLs) |
| `complete` | `boolean[]` | `labeled_complete` per image, parallel to `images`; short reads as incomplete |
| `selectedIndex` | `number` | Currently selected image; `-1` for none |

**Emits:** `rr-image-select` `{ index }`, `rr-image-delete` `{ index }`, `rr-image-add`
`{ source: 'camera' | 'file' }`, `rr-image-reorder` `{ from, to }`.

---

### `rr-viewer` ⭐ shared by both views

Displays media — image or video — under an SVG marker overlay, and reports pointer gestures in
image pixel coordinates.

| Property | Type | Description |
|---|---|---|
| `src` | `string \| null` | Image URL (editor mode) |
| `stream` | `MediaStream \| null` | Video stream (live mode) |
| `calibrationPoints` | `readonly CalibrationPoint[]` | Crosshairs to draw; empty in the live view |
| `sensors` | `readonly Sensor[]` | Diamonds to draw. Per **layout**, so the same list draws over every image; the live view passes the same list |
| `sensorStates` | `ReadonlyMap<string, SensorState> \| null` | L1 per sensor, keyed by `id`. **`null` is the editor** — nothing is reading these sensors, which is not the same as reading them and finding nothing |
| `detections` | `readonly Detection[]` | L0 for this frame: dashed oriented boxes at the model's **own** predicted width. Empty in the editor |
| `cars` | `readonly CarLabel[]` | Car spans to draw: a chord inside its width rectangle. Per **image**, so switching images swaps the whole list; empty in the live view |
| `pendingCar` | `PendingCar \| null` | The **rubber band** — `{ anchor, to }` for the chain in flight. The one thing here that is not in the manifest; empty in the live view |
| `highlight` | `ViewerHighlight \| null` | The objects a reveal is pointing at — `{ cars, sensors, calibration }`, ids for the first two and **indices** for the third. Already resolved by `rr-editor-view`; the viewer draws it and decides nothing. `null` in the live view |
| `zoom` | `Rect \| null` | The region of the **authored frame** on screen ([#44]). `null` is fit — the absence of a zoom, which is exactly what this element drew before the property existed. View state the editor owns; never in the manifest and never in the history. `null` in the live view |
| `zoomPreview` | `Rect \| null` | The rect being dragged out — zoom's counterpart to `pendingCar`. Drawn in the overlay with a screen-constant stroke, never as an HTML box on the glass |
| `dpt` | `number \| null` | The scale the **world-sized** symbols are drawn at. `null` falls them back to `symbolSize` |
| `resolution` | `{ width, height }` | `camera.resolution` — the frame every coordinate is **authored** in. Not the viewBox: the viewBox is the media's own size, and this is scaled onto it |

**Emits:** `rr-pointer-down`, `rr-pointer-move`, `rr-pointer-up`, `rr-pointer-cancel`
(`ViewerPointerDetail`), `rr-pointer-contextmenu` (`ViewerContextMenuDetail`), `rr-media-frame`
(`ViewerMediaFrameDetail`, once per media load) and `rr-viewport` (`ViewerViewportDetail`, whenever
the measured viewport changes size). All seven fire in both `src` and `stream` mode. They are declared in `HTMLElementEventMap`, so a listener anywhere up
the tree gets the detail typed without a cast.

| Detail field | Type | Description |
|---|---|---|
| `point` | `Point` | Position **in image pixels** — the SVG viewBox frame, never screen coordinates |
| `imagePxPerScreenPx` | `number` | Converts a screen-space tolerance to image pixels; feeds `geometry.ts`'s `HitTolerance` |
| `originalEvent` | `PointerEvent` / `MouseEvent` | For `pointerId`, `buttons`, and modifier keys |

**Zoom is one transform above both children** ([#44]). `zoom` is applied to a layer carrying the
media *and* the SVG, so the two stay **one box by construction** rather than by two transforms being
kept in sync — the same argument [#41] settled, one level up. Because `getScreenCTM()` walks up
through that layer, `imagePxPerScreenPx` and `symbolSize` become zoom-aware with no arithmetic
changing anywhere: annotations stay a constant **screen** size, sensors and car rectangles stay a
constant **world** size, and a grab radius stays a fingertip at any zoom. Do **not** implement zoom
by moving the SVG viewBox and transforming the media separately. The measured viewport is reported
as `rr-viewport` because the editor needs the same number for the zoom cap and cannot measure a box
it does not own.

`ViewerMediaFrameDetail` is `{ media, frame, aspectMismatch }` — what the image or video turned out
to be (`naturalWidth`/`videoWidth`), what the archive declares, and whether the two are different
**shapes**. Only the viewer ever learns the first number, and `camera.resolution` is one value for
the whole archive while the images are per image, so nothing else can notice a re-cropped or
re-encoded photo. `rr-editor-view` turns a mismatch into the `.frame-warning` bar.

**Coordinates are converted with `createSVGPoint` + inverse `getScreenCTM()`**, never by subtracting
`getBoundingClientRect()` by hand: the rect ignores the letterbox that `preserveAspectRatio` creates,
so the hand-rolled version is correct only while the viewport happens to match the image's aspect
ratio, and drifts silently as soon as it does not. `imagePxPerScreenPx` comes off the same matrix for
the same reason. Where no CTM is available — jsdom, a detached element — **nothing is emitted**
rather than a coordinate derived from a missing transform.

`point` may fall **outside** the image bounds: the overlay covers the letterbox bars, and a captured
drag keeps reporting after the pointer leaves the element. Clamping is the consumer's call.

**Pointer capture is taken on `pointerdown`** and released on up or cancel, so a drag that wanders
off the element still delivers its end. `pointercancel` is reported as its own event rather than
folded into `up`, because a consumer that commits an edit on `up` must not commit a gesture the
browser took away.

**The overlay is now the hit target** — `pointer-events` on the SVG went from `none` to `auto`. That
makes the `touch-action: none` already on the same rule *effective*, where before touches fell
through to the `<img>`/`<video>` underneath: pinch-zoom over the media is suppressed on touch
devices, and dragging the photo no longer starts the browser's native image drag. Deliberate — the
labeling surface has to own its gestures — but it is the one user-visible consequence of the change,
and the labeling device is a phone.

**It still authors nothing** — `calibrationPoints` is drawn from the manifest and never written here,
and `detections`/`sensorStates` are computed by `@occupancy/detector` and handed down. `interactive`, `activeTool`, `calibration`, and the four events that
mutated (`rr-marker-add`, `rr-marker-move`, `rr-marker-delete`, `rr-calibration-move`) were removed
in the v4 reduction and do not come back — v4 has neither point markers nor a draggable `{p0, p1}`
pair. The viewer reports where the pointer is; deciding what that means is the editor's job, and the
arithmetic it needs is in `geometry.ts`. The right-click is **not** `preventDefault()`ed here, since
whether the native menu is suppressed depends on editor state: `rr-editor-view` suppresses every
right-click it hears, and `rr-live-view` does not listen at all.

**Methods:** `getVideoElement()`, `getImageElement()` — `rr-live-view` uses these to feed the
detector the live frame source.

**Why one component for both modes.** `<img>`/`<video>` and the SVG both **cover the container**,
and both fit their content into it by the same rule — `object-fit: contain` against
`preserveAspectRatio="xMidYMid meet"` — over a viewBox that is the media's **own** pixel grid. Two
boxes fitted by one rule over one box are one box, which is what makes a marker land on the pixel it
names in either mode. Sizing either from anything else is what let objects drift off the photograph
as the window was resized ([#41]): the media used to lay out at its *natural* size, which stops
growing once the container is bigger than the photograph while the overlay keeps growing, and the
viewBox used to be `resolution`, which letterboxes differently as soon as an image's shape is not
the declared one.

The authored frame reaches that grid through the `g.frame` scale (`geometry.ts` § `overlayFit`), so
everything drawn and every coordinate emitted stays in `resolution`'s frame — the frame the manifest
is written in (`SPEC.md` § Output encoding). For a photograph of the declared shape at any pixel
count the scale is uniform and nothing changes; where the shapes disagree there is no correct
mapping, because nothing records how the photo was cropped, so the frame is **stretched** to cover
the photograph and `rr-media-frame` says the mapping was a guess. That stretch is non-uniform, so
the screen-constant annotations stretch with it — left visible rather than compensated for, since
the archive is inconsistent and a symbol that looked right would argue otherwise. **Pointer
coordinates come from that group's CTM**, not the SVG's.

One visible sizing change comes with it: a photograph smaller than the pane is now **upscaled** to
fill it, where the media used to stop at its natural size. The labeler aims at car ends, and a
postage stamp is harder to aim at than a soft enlargement.

**Scaling — two kinds, and mixing them up misdraws everything.** A `ResizeObserver` recomputes
`symbolSize = SYMBOL_SIZE_SCREEN_PX / ctm.a` off the same transform the pointer path uses, keeping markers, crosshairs,
car endpoint handles and every **label** a constant *screen* size at any zoom or window size. A
**sensor's diamond** is not one of those: it is drawn one **track width** across, which in image
pixels *is* `dpt` (`geometry.ts` § `trackWidthPx`), so it shrinks with the photograph exactly as the
cars around it do. A **car's width rectangle** is the same kind of size, 2.09 track widths of it,
which is what makes a sensor's footprint comparable to a car's.

With `dpt` null the diamond falls back to `symbolSize` and the width rectangle is **not drawn at
all** — a car with no derived width has none to claim, where a sensor with no size would simply be
unfindable. An archive can carry both and no calibration, since a calibration point can be deleted
at any time; the chord and its handles keep every car visible and grabbable meanwhile.

**Cars are drawn first**, under the crosshairs and diamonds: their rectangles are the only area
fills on the overlay, and a calibration point or a sensor sitting on a car must not be tinted over.
The shared coupler handles go over the cars they join, and the rubber band over those — a chain in
flight has to stay legible on the train it is being added to.

**Couplings are derived here, not passed in** ([#33]). `geometry.ts`'s `couplerPoints` reads them off
`cars` — exact coincidence, the same rule the hit-test grabs by — so a coupling renders as **one**
shared handle and the cars underneath leave their own handles off at that end. Two circles stacked on
one pixel would only ever *look* like one, and could not say they are shared. Nothing about a
coupling is stored, and nothing needs to be: dragging the handle moves every end under it.

**A car's class warning is derived here too** ([#35]), for the same reason a coupling is: it is a
property of the label this component was handed and of a build-time constant, so there is nothing for
a parent to compute or to keep in sync. `vocabulary.ts`'s `isKnownClass` decides, `carMarker.ts`
draws it. The live view passes no cars, so nothing there is affected.

**The measurement happens in `firstUpdated()` as well as in the `ResizeObserver`.** The observer's
callback defers through `requestAnimationFrame`, and a frame that never arrives — a hidden pane, a
background tab, an occluded window — used to leave every screen-constant symbol at its initial ratio,
drawing crosshairs and labels at whatever size the *image* pixels happened to be. jsdom reports every
rect as zero, so the suite cannot catch that; it was found by measuring a live page.

---

### `geometry.ts`

The editor's geometry, as pure functions. A module rather than anything inside a component, and that
placement is the point: jsdom neither lays out nor paints, so arithmetic living in a Lit element is
covered by nothing and nothing is coming to cover it (#109), while the same arithmetic here is
covered today.

| Export | Description |
|---|---|
| `trackWidthPx(dpt)` | Track width in image pixels — which **is** DPT, since `getDPT` returns px/mm × gauge_mm. A sensor is drawn one of these across |
| `sensorDiameterPx(dpt, imagePxPerScreenPx)` | The diameter a sensor is **drawn** at: one track width, or the screen-constant size with no DPT. The renderer and the hit-test share it, so what you see is what you can grab |
| `SYMBOL_SIZE_SCREEN_PX` | Size of a screen-constant symbol (markers, crosshairs, labels), in screen pixels |
| `carWidthPx(dpt)` | Car width in image pixels: `dpt × STANDARD_WIDTH / STANDARD_GAUGE` — 2.09 track widths |
| `carCorners(p0, p1, dpt)` | The four corners of the oriented rectangle, in polygon order from the `p0` side |
| `carCovering(scene, at)` | The car whose rectangle covers a pixel, or `null` — a claim about the **image**, off the same scene, asked only by the car tool's first click ([#43]). Boundary is inside; no DPT means no rectangle, so nothing covers |
| `carUnderPointer(scene, at, tolerance)` | The car a **gesture** aimed at a pixel means, or `null` — the same rectangle **floored at a fingertip**, which is what the context menu opens on ([#45]). First in scene order where several cover |
| `hitTest(scene, at, tolerance, kinds?)` | The `HitTarget` under an image-pixel coordinate, or `null`. `kinds` narrows what is looked *for*, defaulting to all of them |
| `HitScene` | `{ cars, sensors, calibrationPoints, dpt }` — everything grabbable for one image of one layout, plus the scale the world-sized ones are drawn at |
| `HitTarget` | `car-endpoint` / `coupler` (both carrying `ends`), `sensor` (`id`), `calibration` (`index`) |
| `HitKind` | `car-endpoint` / `sensor` / `calibration` — a kind that can be *found*; a coupler is derived, never searched for |
| `HitTolerance` | `{ screenPx, imagePxPerScreenPx }` |
| `dragHandles(hit, scene)` | The points a grab moves — **a list**, one per object, and two or more for a coupler |
| `DragHandle` | `{ ref, from }`: what it addresses, and where it sat at pointer-down |
| `HandleRef` | `calibration` (`index`), `car-end` (`id`, `end`), `sensor` (`id`) — never an object reference |
| `dragTo(handle, delta)` | Where that handle lands, in whole image pixels |
| `samePoint(a, b)` | Whether two pixels are the same pixel — the **one** encoding of the coincidence rule, shared by the hit-test, the renderer and the staleness guards |
| `couplerPoints(cars)` | Every pixel where two or more car ends meet, once each, in scene order — the couplings a renderer draws one shared handle per |
| `isCoincident(at, points)` | Whether `at` is exactly one of them |
| `coupledEnds(car, couplers)` | `CoupledEnds` for one car: which of its ends a shared handle covers |
| `CoupledEnds` | `{ p0, p1 }` — passed to `renderCar` so it draws no handle there |
| `DEFAULT_GRAB_RADIUS_SCREEN_PX` | The grab radius every tool uses, in screen pixels — one number, because it describes the pointing device. A **floor**, not a cap: a sensor is grabbable across its whole drawn symbol, and so is a car |
| `CLICK_SLOP_SCREEN_PX` | How far a pointer may travel between press and release and still be a click. Smaller than the grab radius: this is tremor, not aim |
| `isClick(from, to, tolerance)` | Whether a finished gesture was a click rather than a drag |
| `placeLabel(at, text, fontSizePx, offsetPx, frame)` | Where a symbol's label goes so it does not run off the frame — up and to the right, flipped inwards at the top or right edge |
| `clampToViewport(at, size, viewport, margin)` | Moves a box so it stays inside the viewport, keeping `margin` from every edge. The one function here in **screen** coordinates — it places the context menu on the glass. A box bigger than the viewport pins to the near edge |
| `Size` | `{ width, height }` — a box on the screen, as opposed to `FrameSize`, which is the image |
| `LabelPlacement` | `{ x, y, textAnchor, dominantBaseline }` — the SVG attributes that place the label |
| `estimateLabelWidthPx(text, fontSizePx)` | An **estimate** of a monospace label's width: character count × 0.6em |
| `FrameSize` | `{ width, height }` — the image bounds, `rr-viewer`'s `resolution` |
| `overlayFit(media, frame)` | `{ sx, sy, aspectMismatch }` — how the authored frame maps onto the media's own pixel grid, which is what the overlay's content group is scaled by. Uniform for a photograph of the frame's shape at any pixel count; the identity while nothing is loaded |
| `OverlayFit` | `{ sx, sy, aspectMismatch }` |

**Both constants come from `@occupancy/config`.** The scale ratio cancels out of the width formula —
a car is 2.09 track-widths wide in **every** scale — so no scale lookup belongs anywhere in `ui/`,
and no gauge arithmetic is reimplemented here.

**The grab radius is in screen pixels**, converted with the `imagePxPerScreenPx` that `rr-viewer`
puts in every pointer event. A grab radius is a property of the mouse and the finger, not of the
photograph: an 8-megapixel image and a 720p one must feel the same.

**Nearest wins**, whatever its kind; an exact tie goes to the denser geometry (car ends, sensors,
calibration points, in that order). Only handles are hit — the body of a car is not grabbable,
because the only edits a span supports are to its two ends.

**Three questions, deliberately not one.** `hitTest` is *what can this gesture grab*.
`carCovering` is *is this pixel already labelled* — a claim about the **image**, which only the car
tool's first click asks. `carUnderPointer` is *which car is this gesture aimed at* — a claim about
the **pointer**, which the context menu asks ([#45]). The last two are the same rectangle measured
the same way (in the span's own frame, so a diagonal car is tested across its axis and not across a
bounding box; the boundary counts as inside), and they differ in the fingertip **floor**, which only
the pointer's question carries: widening the image's question would refuse a chain start across a
band of demonstrable background, and in a yard photo that band is the gap between parallel tracks.

**`kinds` narrows the search, not the answer.** Nearest-wins has already discarded everything the
winner beat, so a caller that filtered a `car-endpoint` out of the *result* would find nothing where
the user can see a sensor a few pixels further off. It is not a filter on the scene either — the
excluded objects are still there for the next question to find.

**A coupler is exact coincidence, not proximity.** Nothing about a coupling is stored; it is two or
more car ends at the identical pixel, which chaining and the shared handle both guarantee by writing
the same value. Fusing endpoints that merely look close would move geometry the user never joined.
`hitTest` and `couplerPoints` apply that one rule to the pointer and to the renderer, so what draws
as a coupling is exactly what grabs as one.

**A drag is a list of handles, not the thing under the cursor.** `dragHandles` is where that
conversion happens, and it is why one history entry can cover several objects. Every handle carries
the position it had at pointer-down, and `dragTo` applies the same delta to each: measured from the
press so the grab offset survives — grabbing a point three pixels off-center must not teleport it
under the cursor — and identical across handles so a coupler's ends land on the *same* pixel, which
is what keeps them coupled. Rounded, because a handle names a pixel.

**A label flips inwards rather than being clipped.** `placeLabel` prefers up and to the right, and
draws on the inside — to the left near the right edge, below near the top — when it would otherwise
run past the frame. Only the axis that overflows flips, and only when the other side actually fits: a
frame narrower than the label overflows either way, and flipping there would trade a clipped tail for
a clipped head, losing the leading digits that identify the point. The symbol itself never moves;
a calibration crosshair still names its exact pixel on the edge.

**The width behind that decision is an estimate, and is named one.** Nothing here measures text:
`measureText` and `getBBox` need layout, jsdom performs none, and a rule depending on them would be
untestable — which is the reason this module exists. Every editor label is monospace and its content
is known, so `estimateLabelWidthPx` is character count × 0.6em, erring slightly wide, which is the
safe direction for a flip test. It is not a box the glyphs are guaranteed to sit inside. The rule
lives here rather than in a renderer because the sensor symbol carries a name in the same frame
against the same edges: its geometry differs, this decision does not.

---

### `calibrationMarker.ts`

The calibration point's own SVG, as a module for the same reason `carMarker.ts` is one. **Both exports
must be used together** — styles in the host's `static styles`, the renderer once per point.

| Export | Type | Description |
|---|---|---|
| `renderCalibrationPoint(point, index, size, frame, highlighted?)` | `(CalibrationPoint, number, number, FrameSize, boolean?) => SVGTemplateResult` | A crosshair centered on `point.px`, a small circle at the exact pixel, and a `text` label carrying the world coordinate. `size` is in image pixels — `rr-viewer`'s `symbolSize`, so the crosshair is constant on screen; `frame` is its `resolution` |
| `calibrationMarkerStyles` | `CSSResult` | Crosshair and label colors, non-scaling strokes, and the label's own outline |

There are no `<defs>` and so no third export: a crosshair is two lines, and nothing is reused.

A calibration point is drawn **unlike anything else in the editor** by requirement (`../SPEC.md`
§ Reference points) — it must not be confusable with the sensor symbol, which is why that one is a
closed amber diamond and this one is two cyan crossing arms. The
crosshair also names the exact pixel, which a boxed icon does not. The label rounds to one decimal:
coordinates are typed by hand today, but a dragged point will not be, and float noise in a label
reads as a bug in the editor.

Points carry **no `id`** — nothing references one individually — so `index` (position in
`layout.calibration.points`) is the only handle a gesture has, and it is rendered as
`data-calibration-index`.

**`frame` is only the label's business.** The label sits up and to the right by default and would be
clipped on a point near the top or right edge, so it flips inwards; the decision is `geometry.ts`'s
`placeLabel`, shared with `sensorMarker.ts` rather than inlined here, and made from an
*estimated* label width because nothing can measure text. `text-anchor` and `dominant-baseline` are
therefore set **per element** and are deliberately absent from `calibrationMarkerStyles` — a
stylesheet rule beats a presentation attribute and would pin every label to one corner. The crosshair
ignores `frame` entirely: it names an exact pixel, wherever that pixel is.

---

### `vocabulary.ts`

The authored class taxonomy, read as a tree. A pure module for the same reason `geometry.ts` is one,
and the **only place in `ui/` that a class name comes from** — every value here is derived from
`detector.vocabulary` in `config.yaml`, reached through the generated `@occupancy/config`, so adding
a subtype there and running `pnpm config:generate` changes the editor's menu with no code edit.

| Export | Description |
|---|---|
| `rootClass(vocabulary?)` | The taxonomy's single root — the class every new car is created as. Throws unless there is exactly one |
| `classChoices(vocabulary?)` | The root's children as a nested `ClassChoice[]`, each carrying its full dotted `class`, its `name`, and its own children |
| `isKnownClass(cls, vocabulary?)` | Whether a stored class names an entry. Segment by segment, the same rule the exporter maps with: `stock` matches `stock.loco` but never `stockyard` |
| `VocabularyNode` | One mapping in the taxonomy: subtypes by name, mixed with the node's own properties |
| `ClassChoice` | `{ class, name, children }` |

Two rules it encodes, each wrong somewhere if reimplemented:

* **A nested object is a subtype; anything else is a property.** `width_mm` is an optional per-class
  width override sitting beside subtypes in the same mapping, and telling the two apart structurally
  is what avoids a reserved list of key names.
* **The stored class is always rooted, and the root is never shown.** A label maps to the longest
  entry of `detector.classes` that is a segment-prefix of its class, so an unrooted `loco.steam`
  matches nothing and is **dropped from the export** — the unlabeled-car-as-background failure the
  completeness rule exists to prevent.

Conformance is checked **here and not at parse time**: `class` is a plain string at the format layer
(`../SPEC.md` § Format), because a format that refused to open files because someone pruned
`config.yaml` would punish config edits. So a non-conforming class is a visible warning in the editor
(`rr-viewer` marks the car red and names the class) and a fatal error in the training exporter later.

---

### `sensorMarker.ts`

The sensor's own SVG, with the same shape and the same rules as `calibrationMarker.ts`. **The exports
must be used together** — styles in the host's `static styles`, the renderer once per sensor.

| Export | Type | Description |
|---|---|---|
| `renderSensor(sensor, size, frame, highlighted?)` | `(Sensor, SensorSymbolSize, FrameSize, boolean?) => SVGTemplateResult` | A diamond centered on the sensor, a filled core at the exact pixel, and a `text` label. `frame` is `rr-viewer`'s `resolution`; `highlighted` adds `highlight.ts`'s class |
| `SensorSymbolSize` | `{ diameterPx, labelPx }` | **Two independent sizes.** `diameterPx` is a *world* size — one track width, so the diamond shrinks with the photograph; `labelPx` is a *screen* size, from the viewer's `symbolSize` |
| `sensorLabelText(sensor)` | `(Sensor) => string` | The sensor's `name`, or its `id` when it has none |
| `sensorMarkerStyles` | `CSSResult` | Diamond and label colors, the translucent fill, non-scaling strokes |

**Amber diamond against the crosshair's cyan arms**, and the difference is shape as much as colour: a
sensor and a calibration point are different objects with different tools, and `../SPEC.md`
§ Reference points requires them to be unmistakable. The symbol also *closes* around its pixel rather
than extending arms, because a sensor is a single query point and nothing about it implies an extent.

**The diamond is one track width across**, not a constant size on screen — the only honest sense of
how big a sensor is comes from the track it sits on, and a car is 2.09 of the same unit, so the two
are directly comparable on the photograph. The **label is a screen size**, because it is annotation
about the sensor rather than a measurement of it: a name scaled to the track is illegible at the
DPT 18–19 the fixture corpus sits at. The centre dot has a **floor** (`MIN_CORE_RADIUS_PX`): it names
the pixel the sensor *is*, and 12% of an 18-pixel diamond is not a visible dot.

**An unnamed sensor is labelled with its `id`.** Names are optional, free text, not unique, and never
auto-generated (`../SPEC.md` § Occupancy Output): an invented "Sensor 3" is indistinguishable from a
name a human chose and stops matching as sensors come and go. A blank name is treated as no name.

`frame` is the label's business only, exactly as for the crosshair, and through the same
`placeLabel`.

---

### `carMarker.ts`

The car's own SVG, with the same shape and the same rules as the two markers above. **The exports
must be used together** — styles in the host's `static styles`, the renderers over the scene.

| Export | Type | Description |
|---|---|---|
| `renderCar(car, size, coupled?, warning?, highlighted?)` | `(CarLabel, CarSymbolSize, CoupledEnds?, CarWarning \| null, boolean?) => SVGTemplateResult` (`CoupledEnds` is `geometry.ts`'s) | The translucent width rectangle, the chord between the two ends, and a handle at each **free** end. The group carries `data-label-id`, `unknown-class` when a warning is given, and `highlight.ts`'s class when a reveal points at it |
| `renderCoupler(at, size)` | `(Point, CarSymbolSize) => SVGTemplateResult` | The **one shared handle** a coupling renders as — half again the size of a free end's, ringed so it reads as a joint |
| `renderPendingCar(pending, size)` | `(PendingCar, CarSymbolSize) => SVGTemplateResult` | The **rubber band**: the car the next click would write, dashed, rectangle and all |
| `CarSymbolSize` | `{ dpt, handlePx, labelPx }` | The **DPT the rectangle is derived from** — not a width — plus screen-constant handle and warning-label sizes |
| `CarWarning` | `{ text, frame }` | A class the vocabulary does not name: the offending class, and the image bounds the label flips inside |
| `PendingCar` | `{ anchor, to }` | The chain in flight: the end already clicked, and where the pointer is |
| `carMarkerStyles` | `CSSResult` | Rectangle, chord, handle, coupler and band colours; the translucent fill; the band's dashes; non-scaling strokes |

**The rectangle is why the car tool is gated on calibration.** Two clicks say where the ends are and
nothing about whether the label covers the car; the width does, and the width is *derived* from DPT
rather than stored — 2.09 track widths, in every scale (`geometry.ts` § `carWidthPx`). So it is
feedback, not decoration, and the fill is translucent because it is read **against the car
underneath it**.

**The DPT is passed, not a width.** The derivation lives in `geometry.ts` and a caller handing over
a number would be a second place to get the 2.09 wrong. `null` is a real state — a calibration point
can be deleted at any time — and it means no rectangle: the chord and the two handles still draw, so
the labels already authored stay visible and grabbable.

**Magenta**, against the crosshair's cyan and the diamond's amber, and picked to be rare in a
photograph of a layout. Three objects, three tools, three meanings; `../SPEC.md` § Reference points'
requirement that they be unmistakable extends to this one.

**A coupling renders as one handle, and the cars get out of its way** ([#33]). The caller derives the
couplings with `geometry.ts`'s `couplerPoints` and tells each car which of its ends is covered;
`renderCoupler` then draws the shared handle once, however many ends meet there. Nothing about the
coupling is *stored* — it is still only the coincidence — but it is drawn, because one handle is the
promise the drag keeps.

**A class the vocabulary does not name draws red and says so** ([#35]). `class` is a plain string at
the format layer and is deliberately **not** validated when an archive is parsed (`../SPEC.md`
§ Format) — a format that refused to open files because someone pruned `config.yaml` would punish
config edits — so the editor is where non-conformance becomes visible, and the exporter is where it
becomes fatal. The whole symbol changes ink rather than gaining a badge (the label is *wrong*, not
annotated), the offending class is drawn beside the car's midpoint because a typo is the likely
cause, and the car is still drawn whole because the archive still opens. This is the one text a car
carries, hence the one place `carMarker.ts` needs a frame — the label flips inwards at an edge
through the same `placeLabel` the sensor's name uses.

**The band is dashed, and it draws the whole car.** A chain in flight is view state and must never
read as a label that has been written, hence the dashes; and it shows the derived width rectangle
rather than a bare line, because that rectangle is the only feedback that a label covers the car and
seeing it *before* the click is worth more than seeing it after. Before the pointer moves it is the
anchor twice over — one handle, a collapsed rectangle — which is the feedback that the first click of
a chain landed.

**Handles are a screen size, the rectangle is a world size.** A handle is where the pointer grabs,
so it belongs to the mouse; the rectangle measures the car. Same split as `SensorSymbolSize`.

---

### `rr-calibration-dialog`

Asks for a calibration point's world coordinate in millimetres — the second half of the gesture whose
first half is a click on the image.

**Properties:** none. It is opened imperatively, because the values it starts from belong to the
gesture rather than to any parent state.

**Methods:** `show(world?, { mode? })` — `mode` is `'place' | 'edit'` and changes wording only;
`hide()`.

**Emits:** `rr-calibration-commit` with `{ world: WorldPoint }`. Cancelling emits nothing, which is
what keeps a dismissed dialog out of the manifest *and* out of the undo stack.

The fields are written imperatively in `show()` rather than value-bound: reopening on the same
coordinate after the user typed something else would otherwise leave the stale text, since the
binding sees no change. A blank field is **refused, not read as zero** — the origin is a real
position in the layout's frame, so defaulting to it would place a point somewhere specific with
nothing saying so. Enter commits, which is how a three-field numeric form is typed.

`show()` deliberately does not await `sl-dialog.show()`: that promise resolves on `sl-after-show`,
i.e. when the opening animation finishes, and the caller is waiting only for the fields.

---

### `rr-context-menu`

The right-click menu: a short list of verbs acting on one object. It is why the editor needs no
delete mode at all — deleting is a verb on the thing under the cursor rather than a mode the user
enters and must remember to leave (`../SPEC.md` § Right-click is state-dependent).

**Properties:** none. Opened imperatively, like `rr-calibration-dialog` and for the same reason: what
it shows belongs to the gesture that opened it. Nothing is rendered while it is closed.

**Methods:** `show(at, items)` — `at` is a `ScreenPoint` in **client** coordinates, `items` is
`ContextMenuItem[]`; resolves once the rows are in the DOM. `hide()`. `open` is a read-only getter.

| Type | Shape | Description |
|---|---|---|
| `ContextMenuItem` | `{ id, label, items? }` | `id` is reported on selection and never shown; `label` is what the user reads; `items` nests a **submenu**, to any depth |
| `ScreenPoint` | `{ x, y }` | Named apart from `Point` on purpose — every other editor position is in **image** pixels; a menu is placed on the glass |

**Emits:** `rr-context-menu-select` with `{ id }`. Dismissing emits nothing.

**It knows nothing about what the object is.** The editor hit-tests, names the verbs, and interprets
the selection; this element renders rows and reports which one was chosen. That is what lets cars,
sensors and the reclassify submenu ([#35]) plug into the same menu as they arrive.

**A row with children is opened, never chosen.** It carries no `value` — only `data-id` — so a stray
selection cannot report an id that names no verb, and a nested selection is reported by the child's
own id. One click reports **one** selection however many menus it bubbles through: a nested `sl-menu`
and the outer one share this element's listener, and a second report would be a second history entry
for one gesture.

**Dismissal is on the document**, in the capture phase: a press anywhere outside the element (tested
with `composedPath()`, which sees through the shadow boundary) and Escape. A menu the user has to aim
at in order to close is worse than no menu. The listeners are added on `show()` and dropped by
`hide()`, which `disconnectedCallback()` calls — a document listener outliving the element would
swallow presses for the rest of the session.

**The dismissing press is swallowed** (`stopPropagation` + `preventDefault` in the capture phase), as
it is for a native menu. Without that it reaches `rr-viewer` underneath and the editor reads it as a
click, placing a calibration point behind the menu the user was only closing.

**Position** is written as `--menu-x` / `--menu-y` on the host, which `position: fixed` styles read.
`updated()` measures the rendered menu and runs it through `geometry.ts`'s `clampToViewport` so it
stays inside the window — in the element only because that is where the measurement is; the
arithmetic is in `geometry.ts`, where a test can reach it. With an unmeasured menu (jsdom, every rect
zero) the clamp is the identity and the menu lands at the cursor.

---

### `rr-editor-view`

Orchestrates the editor: images, a DPT readout, the active tool, calibration, sensor and car
authoring, the right-click menu, and the per-image completeness flag.

| Property | Type | Description |
|---|---|---|
| `archive` | `R49Archive \| null` | |
| `history` | `EditHistory \| null` | The undo stack; every mutation below runs through it |
| `canUndo` / `canRedo` | `boolean` | Passed through to `rr-toolbar` |
| `undoLabel` / `redoLabel` | `string \| null` | The pending edits' phrases. **Qualified here** before they reach `rr-toolbar` |
| `undoImage` / `redoImage` | `string \| null` | The image each pending entry lands on, or `null` for a layout-scoped one. Compared against the image on screen to qualify the tooltip — "delete car — img_3.jpg" ([#37]) |

**Emits:** `rr-history-change` after recording an edit, and `rr-notify` (`{ message }`) when the
**car tool** refuses a click for landing inside a car already labelled ([#43]) — a refusal that said
nothing would read as a broken editor, and `rr-app` owns the toast.

**Methods:**

* `syncFromArchive(revealFilename?, highlights?)` — rebuilds the blob URLs, optionally selects an
  image, ends any chain in progress, and **lights what the entry changed**. Called by `rr-app`
  *after* undo or redo has applied. `highlights` are the entry's candidates, held as the history gave
  them and **resolved on every render** — by `id` for a car or sensor, by pixel for a calibration
  point, which has no id — so an object the apply removed lights nothing, and an edit arriving while
  the glow is up cannot leave it on a renumbered crosshair. The glow comes off again after
  `HIGHLIGHT_DURATION_MS`, and on an image change, an archive change or disconnect.
* `selectImage(filename)` — moves the selection and nothing else. Called by `rr-app` *before* the
  snapshot lands, which is the order the navigation invariant states: select, apply, highlight
  ([#37], `../SPEC.md` § Undo and redo).
* `interceptUndo()` — `Promise<boolean>`. `rr-app` offers every undo here first, because **a live
  chain is a wall undo cannot cross** and only this component knows one is live ([#33]). See
  *Chaining* below.

* **Layout.** A fixed 78px sidebar beside a flexible main column — and at or below
  `COMPACT_MAX_HEIGHT_PX` a wrapping strip along the top above it, because the sidebar's two
  elements need 571px stacked and a short window does not have it ([#42], re-measured in [#53]). The strip **reflows
  rather than scrolls**: the column was already scrollable, but a flat green strip advertises
  nothing and the platform's overlay scrollbar stays hidden until a scroll has begun, so the tool
  palette — which decides what a click means — read as simply absent. The scroll is kept underneath
  it as a floor, since the host clips and a strip that somehow outgrows the window must not become
  unreachable. See `layout.ts`.
* Creates blob URLs for every image in the manifest, revoking the previous set on reload.
* Image add (camera or file), delete, and reorder go through the corresponding `R49Archive` methods,
  each wrapped in `history.record` with target `images`. Deletion passes `retain` so the image's
  bytes survive for undo.
* **Camera-drift readout, one row per image** ([#95], [#118]). Every image is measured against the
  archive's **reference image — `images[0]`, the first thumbnail** — and the row above the viewer shows
  the result for the image on screen. Four states: `.reference` at position 0 ("zero drift by
  definition", plus how to change it), `.checking` while a measurement runs, `.steady` for a
  measurement inside `maxDriftPx(dpt)`, and an amber warning past it. The warning names the
  displacement in pixels *and* track widths; **nothing is blocked**, exactly as with a below-`MIN_DPT`
  DPT.

  `.steady` is not decoration: the reference is **user-movable** by dragging the strip, so a row that
  appeared only on failure would let a reorder re-point the pose with nothing on screen moving. For the
  same reason a reorder re-measures the whole archive, an add measures only the new image (appending
  cannot move position 0), and a delete re-sweeps only when position 0 went.

  The bar says explicitly that **labeling this image is unaffected** — a car span is authored on the
  image's own pixels, so the training data derived from it is self-consistent whatever the camera did;
  what is off is the per-*layout* sensor and calibration overlay. An uncalibrated layout resolves no
  tolerance and shows no row at all. The check runs
  unawaited, with a neutral "checking…" row meanwhile, and warnings are keyed by filename **in memory
  only** — a verdict is derived, v4 stores no derived state, and the archive's images already are the
  pose record. A first image finds no references and earns no warning: "nothing to have drifted from"
  is not "checked and found steady". Cleared wholesale when the archive changes, since a filename
  means nothing on the next one.
* **Calibration authoring.** A **click** in the viewer — `rr-pointer-down` then `rr-pointer-up`
  within `CLICK_SLOP_SCREEN_PX`, on the same `pointerId` — is hit-tested against the layout's
  calibration points with `DEFAULT_GRAB_RADIUS_SCREEN_PX`. A hit opens `rr-calibration-dialog`
  prefilled on that point; a miss opens it blank and remembers the clicked pixel, **rounded to a
  whole pixel** — a click has no sub-pixel precision to store. The commit writes the point as
  **exactly one `history.record` entry targeting `layout`**, labelled "place calibration point" or
  "edit calibration point", and undo reverses it. Nothing is written until the coordinate arrives, so
  a dismissed dialog leaves both the manifest and the stack untouched.
  * Everything is decided at **pointer-down** — the hit-test, the handles the gesture will move, and
    the history entry it will commit — so no motion event re-decides anything and the entry's
    snapshot predates the first moved pixel. The **press** position is what a click uses: where the
    user aimed, and where a drag grabs.
  * The hit-test scene contains the layout's calibration points and sensors and the **current
    image's** cars — the three objects this editor creates. That split is the per-image/per-layout
    rule as a gesture sees it: switching images swaps the cars and leaves the sensors.
* **Dragging** ([#30]). A press on a calibration point followed by motion past `CLICK_SLOP_SCREEN_PX`
  moves it, and the DPT readout follows live, mid-gesture. The history entry is opened at
  pointer-down and committed at pointer-up, **never per motion event**, so a drag across the image is
  one Cmd+Z and not two hundred; a drag returned to its origin records **nothing**, suppressed by
  value comparison in `EditHistory` rather than by trusting that the user meant it.
  * The gesture moves a **list** of handles from `dragHandles`, which is what lets one entry cover
    more than one object: a drag on two coincident car ends moves both, as **one** entry, so a
    coupling survives the edit. The entry's **target follows what was grabbed** — a car end is in
    one image record, a sensor and a calibration point in `layout` — because that is the subtree the
    gesture writes, and mis-declaring it is the one class of bug scoped snapshots admit.
  * `dragging` is **sticky**: a gesture that moved never falls through to the click path, even if it
    ended back inside the slop. Without it every swipe over the image would place a point, and the
    labeling device is a phone.
  * A press arriving mid-drag is read by its `pointerId`. A **different** one is a second finger and
    is ignored. The **same** one cannot be — a pointer does not go down twice without going up — so
    it means the previous gesture's end never arrived, and it closes that gesture instead of being
    ignored. Without that, one swallowed `pointerup` (`rr-viewer` emits nothing when it has no
    transform) would leave the editor deaf to every press *and* undo dead for the session.
    `disconnectedCallback` closes an open gesture for the same reason: `rr-app` replaces this element
    on the view toggle. Both **commit** what moved rather than reverting it — the objects visibly
    moved and undo covers that; a silent revert would be the editor deciding it knew better.
  * `rr-pointer-cancel` puts every handle back at its starting pixel and closes the entry against an
    unchanged subtree, so a gesture the browser took away records nothing — and is restored even
    when no history is attached.
  * **Pointer capture** is `rr-viewer`'s (it takes it on `pointerdown`); what the editor owes it is
    not bailing on coordinates outside the image, so a drag that leaves the viewer still commits.
  * An edit remembers the **pixel** as well as the index. Points carry no `id`, so if an undo lands
    while the dialog is open and slides that index onto a different point, the commit is dropped
    rather than applied to whatever now sits there.
* **Right-click, and delete** ([#29]). `rr-pointer-contextmenu` is dispatched on the editor's state —
  a `switch` over the `EditorMode` union — because right-click is state-dependent by design
  (`../SPEC.md` § Right-click is state-dependent): **idle** opens the menu and **placing-car** ends
  the chain.
  * The **idle** branch opens `rr-context-menu` at the cursor: **delete** for a calibration point,
    **name and delete** for a sensor, **delete and reclassify** for a car. Empty image opens nothing,
    and neither does an object with no verbs — a list of disabled rows is a worse answer than the
    absence of one.
  * **A car is named by its body, not by a handle** ([#45]). The subject is resolved in two steps,
    **topmost drawn first**: `hitTest` at `DEFAULT_GRAB_RADIUS_SCREEN_PX` for **sensors and
    calibration points only**, then `carUnderPointer` for the area. Car ends are not asked about at
    all — a coupler's shared handle is two cars at one pixel, so a hit there must fall through to the
    area or right-clicking a joint would open nothing. That is why the rows carry no direction and no
    car id any more: the gesture names one car, and the middle car of a train is reached by its own
    rectangle rather than through a joint. Sensors and points win because they are drawn over the
    cars, and a sensor inside a car's rectangle is the normal case. Where two cars cover the pixel —
    the zero-area seam of a coupling, or an archive's overlapping cars — the **first in scene order**
    wins.
  * The menu's rectangle is **floored at a fingertip** while `carCovering`'s is not. A car drawn with
    no rectangle at all (`getDPT` returning `null`, which an undo can cause) would otherwise be one
    you can see and cannot delete.
  * **Reclassify is a submenu generated from `detector.vocabulary`** ([#35]), through
    `vocabulary.ts`. A new car is the taxonomy's root and refinement is an occasional act, not a
    mode, which is what a submenu says and a persistent picker would not. The **root is never
    rendered** — its children are — and it is nonetheless required in the stored class, so the rows
    carry the full dotted class (`stock.loco.steam`) in the row id. Selecting one is **one `image`
    entry**. A taxonomy that is only a root offers no reclassify row at all.
  * **A row is a verb; the subject holds the object.** `delete` and `reclassify:<class>`, neither
    ever shown, and the same rows whatever the subject is — the menu was opened on one object and
    resolved it then, because the user may have moved on by the time they pick. A row that only
    *opens* a submenu carries `reclassify-group:<class>` instead — its own prefix, so it can neither
    be mistaken for a verb nor collide with the row inside it that selects the same subtype.
  * The **placing-car** branch ends the chain and opens nothing. The chain's cars stay: each is its
    own committed entry, and only the anchor — which is view state — goes.
  * **The browser's own menu is suppressed here, not in `rr-viewer`**, and for every right-click the
    viewer reports rather than only the ones that open something: inside the labeling surface a
    right-click is the editor's gesture whatever it lands on, and over empty image it will end a
    chain. `rr-live-view` shares the viewer and does not listen, so its right-click stays the
    browser's.
  * A right-click **during a drag** opens nothing: the object under the cursor is mid-gesture, and
    verbs naming a position the user has not settled on would act on geometry about to change.
  * **Only the primary button authors.** `rr-pointer-down` and `-up` are ignored unless
    `originalEvent.button <= 0`, because a right-click arrives through those same events: without the
    filter the press that opens the menu also runs the click path and puts the calibration dialog up
    behind it. One `pointerId` covers every mouse button, so the filter on `-up` is also what keeps
    the release of a secondary button from committing a left drag still in progress. Touch and pen
    report button 0.
  * The press that **dismisses** the menu is swallowed by `rr-context-menu` and never reaches the
    viewer, so closing a menu over empty image does not place a point.
  * Delete is **one `history.record` entry targeting `layout`**, and undo restores the point with its
    coordinate intact — an entry is a snapshot, so there is no per-object restore to author. The
    subject is resolved when the menu opens and carries its **pixel** for the same reason an edit
    does: an undo landing while the menu is up can slide the index onto another point, and a subject
    that moved is dropped rather than deleted from underneath the user. **Sensor** and **car**
    subjects need no such guard: each carries an `id`, so the subject names it exactly however the
    list is replaced underneath — the delete is a filter by id, not a splice by position. A car's is
    scoped to its **image** rather than to `layout`, because cars are per image.
* **The active tool, and the gate** ([#31]). `rr-tool-palette` reports `rr-tool-select`; this
  component holds the tool and dispatches a click on it. A **placement in progress wins outright** —
  the second click of a car is what completes it. Otherwise a click on **empty image** runs the tool
  (calibration opens the dialog, sensor places a point, car takes an anchor) and a click **on an
  object** edits that object *whatever the tool is*, because the thing under the cursor is less
  ambiguous than the mode: a coordinate for a calibration point, a name for a sensor, and **nothing
  at all** for a car end, whose position is the drag's business and whose class is the menu's.
  * The gate is enforced in `willUpdate`, not at the one place a point is deleted: **the DPT can also
    vanish through an undo**, which `rr-app` applies straight into the archive with no handler here
    seeing it. A gated tool is demoted to calibration; placing a second point re-enables it. An
    archive **opens in calibration mode**, and a new archive resets the tool rather than inheriting
    the last one.
* **Sensor authoring** ([#31]). A click with the sensor tool writes `{ id, x, y }` into
  `layout.sensors` as **one `history.record` entry targeting `layout`** — unnamed, which is a
  complete sensor: consumers key on `id`, and `name` is never auto-generated. The `id` is a
  `make_id` snowflake, so it is unique within the layout by construction. Sensors carry **no
  provenance**: no model can propose where a human wants an answer.
  * Naming goes through `rr-sensor-dialog`, opened from a click on the sensor or from the menu's
    "Name sensor…". A commit of `null` **removes** the key; retyping the same name records nothing,
    suppressed by `EditHistory`'s value comparison. The sensor is re-found by `id` at commit, so one
    deleted while the dialog was open is simply gone.
  * Drag and delete reuse the calibration paths unchanged — that is the point of `dragHandles` and of
    the menu knowing nothing about its subject. Both are one `layout` entry.
* **DPT readout** (`.dpt-bar`). `getDPT()` to one decimal, or "Not calibrated" with a warning style
  when it returns `null` — a real v4 state, reported rather than blocked on, and now with the click
  that fixes it. Two further states:
  * **Fit residual** (`getDPTResidual()`), shown only once the fit is over-determined — more than two
    coplanar points. Below that the fit reproduces its input exactly, so a zero would claim an
    agreement nothing checked. It is what makes a mis-typed coordinate visible instead of silently
    absorbed into the scale.
  * **Below `MIN_DPT`**, the bar takes the `below-minimum` warning style and says so. It **blocks
    nothing** — the six fixture archives sit at DPT 18–19, under the threshold of 20, and must stay
    openable and editable.
* **Frame mismatch** (`.frame-warning`), from the viewer's `rr-media-frame`. Shown only when the
  loaded image is a different **shape** from `camera.resolution`, naming both sizes — the two
  numbers are what says which half is wrong, since a re-cropped photo and a mis-typed resolution
  read identically otherwise. Labels on such an image are drawn through a stretch and are
  approximate. It **blocks nothing**, like a below-minimum DPT, and it is cleared when another image
  is selected: the next image reports its own size when it decodes, and one that never decodes must
  not inherit this verdict.
* **Car authoring** ([#32]). **Two clicks on the visible car ends**, and the straight chord between
  them: no snapping, because v4 stores no track to snap to, and the photograph is what shows the
  labeler where the car actually is. The first click takes an **anchor** and writes nothing; the
  second writes `{ id, class: 'stock', provenance: 'human', p0, p1 }` into that image's `labels` as
  **one `history.record` entry targeting `{ kind: 'image', filename }`**. The `id` is a `make_id`
  snowflake from its own node id — label ids and sensor ids are separate namespaces — and
  `proposed_by` is **absent**, which the schema requires on a human label.
  * Width is **derived, never stored**: `rr-viewer` gets `dpt` and draws 2.09 track widths of
    rectangle around the chord. That rectangle is the whole reason calibration gates this tool.
  * The anchor is **view state**: abandoning a chain — right-click, a tool change, an image change,
    a lost DPT, a new archive — writes nothing and records nothing.
  * A click **inside a car already labelled on this image** starts nothing while idle, and says so
    through `rr-notify` ([#43]) — a refusal that did nothing visibly would read as a broken editor.
    It generalises the older rule that a click on an existing car **end** starts nothing, from the
    handle out to the whole width rectangle (`carCovering`): both exist so a second box cannot be
    stacked on the vehicle being aimed at, and the end handle now gives the **same reason** — the
    hit-test routes that click elsewhere, but to the user it is one rule. Under another tool a car
    end stays silent: nothing to explain, since no car was being authored. Abutting cars are what chaining is for, and a chain's
    *second* click lands wherever it is aimed, existing end included. Only the click that **starts**
    a chain is checked; a drag may still take an endpoint into another car, and an archive that
    already contains overlapping cars opens and edits unchanged.
  * Endpoints **drag** and the menu **deletes** the car whose body it was opened on, through the same
    paths as everything else, keyed by label `id`. Deleting one car of a train leaves no residue — a
    train is derived from coincident endpoints, so nothing else names the car that went.
* **Chaining a train** ([#33]). The clicks do not stop at two: **every click after the first is
  simultaneously the end of the current car and the start of the next**, so a train is one run of
  clicks. The coincidence a train is derived from is exact because the same pixel is written as one
  car's `p1` and handed straight on as the next one's `p0` — chaining does not record a train, it
  guarantees the coincidence. **Right-click ends the chain**; the next click starts a new one.
  * **One entry per car, never one for the train.** A mis-click on the last coupler of a twelve-car
    consist costs one car (`../SPEC.md` § Undo and redo), and undo does not invent an aggregate the
    format refuses to have.
  * A **rubber band** follows the pointer from the anchor, drawn by `rr-viewer` from `pendingCar`.
    It is what makes a live chain visible, and that visibility is what pays for right-click *and*
    undo meaning something else while one is in progress. The cursor is tracked **only** while a
    chain is live — every other gesture reads its position off the event that carried it.
  * A second click on the **anchor's own pixel** writes no car: a span with no length has no axis and
    no two ends to couple. The chain stays where it was.
  * **Undo is intercepted**, through `interceptUndo()`. While a chain is live it consumes every undo
    — the wall — so the reflexive "wrong place, undo" at the start of a train can never reach back
    into the previous one. Further along it undoes the last car's entry and walks the anchor back to
    where that car began, leaving the chain live one step shorter; at the chain's *start* it clears
    the anchor and drops to idle, touching no history. The anchor steps back **only if that undo
    actually removed the chain's car**: an edit made between two clicks sits on top of the stack, and
    reversing it is nothing to do with the chain.
  * A **coupling renders as one shared handle** and drags as one entry moving every end under it,
    which is what `dragHandles` was shaped for; `rr-viewer` derives the couplings from the cars it
    was handed.
* **Zoom** ([#44]). Two actions and a pan, over one nullable `Rect` of the **authored frame** handed
  to `rr-viewer`. `null` is fit. Nothing here writes to the manifest, so nothing here records a
  history entry — zoom is view state, which `../SPEC.md` § Undo and redo already named.

  | Gesture | Unzoomed | Zoomed |
  |---|---|---|
  | Plain primary drag from **empty image** | zoom to the rect drawn | pan |
  | **Shift** + primary drag, anywhere | zoom to the rect drawn | zoom to the rect drawn |
  | Primary drag on an **object** | moves it (unchanged) | moves it (unchanged) |
  | Right-click | menu / end chain (unchanged) | unchanged |

  * Plain drag is the gesture that has to work: touch reports the primary button, and the labeling
    device is a phone. Shift-drag is the desktop escape hatch for a frame with no empty pixel to
    start from — the same layering as Save As. Making the plain gesture state-dependent is a real
    cost, accepted on the grounds right-click already accepts it: the two states differ by something
    the image itself makes obvious. `EditorMode` and `EditorTool` gain **no** members; zoom is not a
    mode and the editor has none.
  * **Zoom to fit** is an `sl-icon-button` overlaid on the viewer, present **only while zoomed** —
    "show zoom bars as needed", applied to the one control there is. Escape does the same, and
    `rr-context-menu` swallows the Escape that dismissed it so one keystroke closes one thing. It is
    deliberately not a toolbar or palette button: `COMPACT_MAX_HEIGHT_PX` is measured from the
    current button counts with 19px to spare, and a sixth button puts [#42]'s reflow back in play.
  * **The cap is derived, not chosen**: one frame pixel per `DEFAULT_GRAB_RADIUS_SCREEN_PX` screen
    pixels, because coordinates are stored as whole pixels and past a fingertip-wide pixel further
    zoom buys precision the format cannot record. It also absorbs the accidental two-pixel drag with
    no second threshold. Sizing it needs the viewport, which arrives as `rr-viewport`. Panning
    clamps by `clampZoomRect` — inside the frame where the rect is smaller, centred where larger.
  * **What it survives.** An image change (the rect is in the per-layout frame, so it names the same
    region on every frame of the archive) and a **live chain** — chaining a consist while aiming at
    couplers is the case zoom earns its keep on, and zoom changes neither what is underneath the
    chain nor its geometry. New and Open drop it: a new layout is a new frame.
  * **A reveal must stay visible.** Undo may move the user but may never change something they
    cannot see, and selecting the entry's image does not cover being zoomed into one corner and
    undoing an edit in another corner of the *same* image. So a reveal takes the changed objects'
    bounding box and **pans at the same zoom level** where it fits, or falls back to fit where it
    does not (`geometry.ts` § `revealZoom`). Fitting on every reveal was rejected: a zoom that
    survives nineteen image changes and dies on every undo is not persistent.
  * The rect in flight is drawn by the viewer from `zoomPreview`, as the band was — never as an HTML
    overlay in screen coordinates.
* **Labeling completeness** ([#36]). A `.complete-bar` sits directly above the thumbnail bar with an
  `sl-checkbox` for the image on screen; every image's flag also goes to `rr-thumbnail-bar` as
  `complete`, so the state is readable per image without selecting it. Toggling it either way is
  **one `history.record` entry targeting `{ kind: 'image', filename }`**, and undo reverses it.
  Marking an image with **zero** cars complete is allowed and warns about nothing — it is an
  all-background sample.
  * `_onCompleteToggle` is the **only** place this component writes the flag `true`. It means "a
    human asserts that no car in this image is unlabeled", an assertion about *absence*, so nothing
    computed may stand in for it — see `../SPEC.md` § Labeling completeness.
  * **Deleting a car clears the flag**, in the same entry. A delete removes coverage and nothing can
    tell a label deleted off background from one deleted off a car still in the photograph, so the
    claim goes back to the human. The rule against setting it has a direction: setting is the claim
    only a human may make, clearing withdraws it and asks again. It costs no extra machinery — the
    flag lives in the same per-image snapshot the delete already targets, so one undo restores the
    car and the assertion together. **Only** deletion clears it: adding a car increases coverage,
    dragging an end moves a label under live width-rectangle feedback, and reclassifying changes
    what a car is called rather than whether it is covered.
* **It loads no model.** Marker CRUD and the per-marker classification display went with the v4
  reduction; the detector that replaced the classifier is the live view's alone. It passes the
  viewer no `detections` and a `null` `sensorStates` — the editor shows what a human authored.

---

### `rr-live-view`

Camera stream under the two layers of the occupancy output ([#85]).

| Property | Type |
|---|---|
| `archive` | `R49Archive \| null` |

* Opens the camera via `getCameraStream()` and runs a `requestAnimationFrame` loop, skipping frames
  until the video reports usable dimensions.
* **This is the occupancy contract, not a demo.** The detector runs **once per frame** — not once per
  sensor — and every sensor is derived from its output by pure geometry, which is `../SPEC.md`
  § Occupancy Output: L1 is a function of L0 and never calls a second model, so it cannot contradict
  the boxes drawn beside it and costs the same for three sensors or three hundred. What stood here
  before (the CNN at each sensor point, emitting marker glyphs) was § Testing and Demo, and it is
  gone.
* `detect` is asked to answer in **`camera.resolution`**, the frame sensors and labels are authored
  in. The capture's own pixel count, the model grid and the letterbox bars stay inside
  `@occupancy/detector`; nothing here scales a coordinate.
* **The loop runs whether or not a model loaded.** `occupancy()` is total, and with `detections:
  null` it answers every sensor `unknown` / `no-model` — a state SPEC names and the user needs to
  see. Suppressing the loop would leave the previous frame's answers on screen instead.
* Three banners, and each says what it costs: **no model** (every sensor `unknown`, with the command
  that builds one), **no calibration** (every sensor `unknown`, but *cars are still detected* —
  L0 needs no DPT), and **drift** (below). The calibration one is resolved when the archive arrives
  rather than in the loop, so a session where no frame ever runs still shows it.
* **Refuses to classify on camera drift, with an override** ([#94]). A drift check built from the
  archive's **reference image**, `images[0]` ([#118], `driftSession.ts`), is sampled every `DRIFT_SAMPLE_INTERVAL_MS` (3 s) rather
  than per frame, and a measurement past `maxDriftPx(dpt)` withholds **L1 only**: every sensor
  reads `unknown` / `drift`, while the detector keeps running and the L0 boxes keep being drawn. The
  boxes are true of the frame they were computed in; what a moved camera invalidates is their mapping
  onto sensors authored in the archive's frame — so diamonds off the track beside correct boxes is the
  statement of *why*. The banner carries the displacement in pixels and in track widths, the archive's
  reference image, and a **"classify anyway"** button; overridden, it keeps saying so. The override is per-session and does
  not survive a remount. Sampling continues while refusing, since putting the camera back is the fix.
  An archive with no images, or a check that fails to build, reports **"not being checked"** — never
  silence, which would read as "no drift found".
* Disposes the detector session and stops all camera tracks on disconnect; the drift check is dropped
  with it, which is also what keeps an in-flight sample from writing into a detached view.

---

### `rr-diagnostics-view`

The shipped detector run over an opened archive, read against the labels a human authored ([#87]).

| Property | Type |
|---|---|
| `archive` | `R49Archive \| null` |

* **This is the first thing that measures the artifact that ships.** The only figures that exist for
  the detector come from the training run's own validation split on `best.pt`; nothing has scored
  `detector_int8.ort`, whose quantisation is Conv-only because quantising the whole graph zeroed
  every score ([#82]). What this reports is **agreement between one model and one archive's labels**
  — not accuracy, and not a generalization estimate, which `../SPEC.md` § Accuracy makes a property
  of a held-out protocol over a corpus that does not exist yet.
* Sweeps images **sequentially**: one ORT session and one WASM heap, so concurrent `detect` calls
  would queue inside the session anyway while making the progress count meaningless and holding
  every decoded bitmap in memory at once.
* Runs inference at a confidence floor **far below** `DETECTOR_CONFIDENCE_THRESHOLD` and filters
  afterwards. That is what `detect`'s `minConfidence` override is for: running at the shipped
  threshold would discard exactly the boxes that answer "what would a lower threshold have caught?".
* **A missing model is fatal here**, unlike the live view. There, `occupancy()` is total and an
  honest `unknown` per sensor is still an answer; here the model's output is the entire content of
  the view and there is no partial result to show.
* Aborts an in-flight sweep and releases the session on disconnect, so switching modes mid-sweep
  does not leave twenty seconds of inference running against a detached element.

---

### `rr-diagnostics-report`

The document half: scorecard, one sortable row per image, a crop strip behind each row.

| Property | Type | Description |
|---|---|---|
| `diagnostics` | `ArchiveDiagnostics \| null` | Scored results; `null` before the first image |
| `imageUrls` | `ReadonlyMap<string, string>` | Blob URL per filename |
| `dpt` | `number \| null` | Layout DPT, for the crop rectangles |
| `resolution` | `Frame` | The authored frame every coordinate is in |
| `threshold` | `number` | Confidence floor currently applied |
| `sweeping` | `boolean` | True while inference is still running, so the numbers are partial |

**Emits:** `rr-diagnostics-threshold` — `{ value: number }`; `rr-diagnostics-review` —
`{ filename: string }`.

* **The wording is "agreed", never "accurate".** The percentage describes this archive against this
  model; a tile reading "accuracy" would be a claim nothing here can support.
* **`Duplicate` is its own tile and column, separate from `Phantom`.** A duplicate is a second box
  on a car that was already found; a phantom is a box over nothing. Both are false positives, but
  the first is a deduplication failure and the second a detection failure — and the shipped model
  produces mostly the first, which folding them together would hide.
* Images **not marked `labeled_complete`** are flagged in the row and counted in the legend: a
  phantom there may simply be a car nobody has labelled, so it is not evidence against the model.
  Nothing is filtered on the flag — hiding those images would hide real detections.
* Sorting by lowest confidence puts the **weakest** box first, because that is the one that decides
  where a threshold should sit.

---

### `rr-diagnostics-queue`

The judging half: one disagreement at a time, on one image.

| Property | Type |
|---|---|
| `image` | `ImageDiagnostics \| null` |
| `imageUrl` | `string \| null` |
| `dpt` | `number \| null` |
| `resolution` | `Frame` |

**Emits:** `rr-diagnostics-close` (no detail).

* Shows **exactly one finding**, zoomed to it. A surface that drew all of them would be the report
  again; the question here is whether *this* box is wrong, which needs the photograph legible.
* **Agreed findings are not in the queue** — there is nothing to judge about a box that matched, and
  including them would bury four disagreements among forty.
* `↓`/`↑` step (with `j`/`k` alongside), `z` toggles zoom, `Esc` returns to the report. The arrows
  are what the buttons name and what the tooltips teach; the vim pair is muscle memory for whoever
  has it.
* The zoom rect spans **label and detection together** (`diagnostics.ts` § `findingBounds`). Framing
  on one side lets a box that slid two car lengths off its label fall outside the crop meant to show
  the disagreement.

---

### `rr-stats-bar`

Overlay showing live detection stats: the two layers, what one inference cost, and how well the
camera still lines up with the archive.

| Property | Type | Description |
|---|---|---|
| `fps` | `number` | Frames per second |
| `cars` | `number` | **L0**: detections above the confidence threshold in this frame |
| `occupied` | `number` | **L1**: how many sensors read `occupied` |
| `inference` | `number` | Milliseconds in `detect` — preprocessing, session, decode. Not the whole frame: L1 is pure geometry, and folding it in would attribute the render to the model |
| `alignment` | `number \| null` | Estimated camera misalignment in `camera.resolution` pixels, or `null` before the first sample |
| `alignmentTolerance` | `number \| null` | What that is judged against — `maxDriftPx(dpt)`. `null` when no DPT resolves, and the row is then not rendered at all |

Both counts are shown because the pair is the readout: cars with no occupied sensor is either an
empty siding or a sensor in the wrong place, and one number cannot say which.

**The alignment row is an instrument, and that is why it is here rather than in a banner.** The live
view's refusal banner is an *event*; alignment is a continuous measurement, and someone aiming a camera
needs to watch it move — a number that only appeared once it was already too large would leave them
adjusting a mount blind, and "how much margin is left" is exactly what the banner cannot say. It shows
measurement against tolerance rather than a red/green dot, because the ratio is what is being judged.
`null` renders as `—`, never `0.0`: "not measured yet" and "measured, and the camera has not moved" are
different facts, and this is the one readout where a zero is a claim. Past the tolerance the row turns
amber, not red — the refusal banner is already red and carries the button that acts on it.

---

### `look.ts`

The look rules' values, as this UI expresses them ([#148], [#149]). Four rails49 UIs are bound to the
same six values and to nothing else; they are decided in `rails49/.github` and travel as a **copied
file, not a package**. `look/tokens.css` is that file verbatim, `look/README.md` records the commit
it came from, and `look/values.test.ts` asserts the two agree.

| Export | Description |
|---|---|
| `lookTokens` | `CSSResult`. Declares `--band`, `--band-ink`, `--rail`, `--rail-group` and `--rail-button` on `:host`. **Include it first** in the `static styles` of every component that draws chrome — `rr-header`, `rr-toolbar`, `rr-tool-palette`, `rr-editor-view` |
| `railButtonStyles` | `CSSResult`. The rail's buttons, as both elements that carry them draw them: `--rail-button` applied as a **floor rather than a size**, and a hover tint that does not move with the theme. Used by `rr-toolbar` and `rr-tool-palette` — the two halves of one rail — for the reason `compactStripStyles` is shared between the same pair |

The chrome keeps these values in **both themes**, which is the whole reason they are tokens: the band
was `--sl-color-primary-600` and moved with the Shoelace theme, and the rail was two hex literals
whose provenance was a comment reading "explicit dark green". A hover tint on either is
`rgba(255, 255, 255, 0.7)` rather than an `--sl-*` colour for the same reason.

`--rail-turns` is deliberately absent — a media query cannot read a custom property, so the reflow
height is `COMPACT_MAX_HEIGHT_PX` in `layout.ts` and the values test compares that number instead.

**The values test runs outside the required gate**, by ADR-0005: it is not under `tests/`, so
`pnpm test` and `bin/test.sh` do not run it. `pnpm --filter @occupancy/ui test:look` does.

---

### `layout.ts`

The height at which the editor's chrome reflows, and the rules the two elements that reflow with it
share. Not a stylesheet of general layout helpers — one agreement between three components.

| Export | Description |
|---|---|
| `COMPACT_MAX_HEIGHT_PX` | Window height at or below which the editor's sidebar reflows into a horizontal strip. `640` — the look rules' `--rail-turns`, not this repo's number (#148); see `look/README.md` |
| `compactStripStyles` | `CSSResult`. The turn itself — the rules `rr-toolbar` and `rr-tool-palette` state identically. **Append after the component's own rules**; it overrides them at equal specificity, so order is what makes it win |

Three components reflow together at this height — `rr-editor-view` turns its sidebar column into a
strip along the top, `rr-toolbar` and `rr-tool-palette` turn their own contents sideways to sit in
it — and they must switch at the same height or the reflow half-applies: **a horizontal strip
holding two vertical stacks is taller than the column it replaced**, which is the bug being fixed.

The value is interpolated into each component's `static styles`. A media query cannot read a custom
property, so this is the one place a shared constant cannot reach across on its own; the agreement
is asserted instead, in `tests/layout.test.ts`.

The breakpoint is set above the measurement rather than at it. Stacked, the sidebar is 571px in the
state that decides it — an archive open and **not yet calibrated**, so five toolbar buttons, three
palette buttons and the gate reason under them — and the header takes 60px above, making 631px the
window where the column exactly fills the space with nothing to spare ([#42], [#53]). That state
rather than the calibrated arrangement: an archive is uncalibrated before it is calibrated, so the
taller arrangement is the one a user meets first.

**The number is the look rules' `--rail-turns` since [#148], not this repository's to pick.** It moved
650 → 640 on the way in, which the derivation still clears — the margin over the 631px measurement
narrows to 9px, and the reflow still happens before the column runs out of window. A measurement that
ever exceeded it is a reason to raise the rules rather than to set a local number. See `look.ts`.

**The measurement moves when the column's density does.** [#53] cut the spacing and the sidebar went
from 721px to 571px, so the constant came down from `800` with it — a density change invalidates
the derivation, and a breakpoint left standing over a column that no longer has that shape reflows
a window the column would have fitted.

`compactStripStyles` exists because the breakpoint agreeing is not the whole hazard — two copies of
the rules *inside* the query could drift while all three components still switch at the same
height. `tests/layout.test.ts` asserts both.

---

### `highlight.ts`

The transient glow a reveal puts on the object an undo or redo just changed ([#37]). A module, and
one module for all three marker types, because it is **one signal**: "this is what moved". The class
and the styles are **used together**, like every other marker pair.

| Export | Description |
|---|---|
| `HIGHLIGHT_CLASS` | The class the three renderers put on their group |
| `highlightStyles` | `CSSResult`. The keyframes and the rule. **Used together with the class**, like every other marker pair — `rr-viewer` carries it last in `static styles` |
| `HIGHLIGHT_DURATION_MS` | 1400. Shared by the fade and by the timer in `rr-editor-view` that removes the class |

**White, and a glow rather than a colour change.** Each object type has its own ink by requirement
(`../SPEC.md` § Reference points), so a highlight in any of those colours would read as a fourth kind
of object; and a car drawn red because its class is unknown has to stay visibly red while it is lit.
`drop-shadow` follows the rendered shape, so there is nothing per-symbol to author.

Two consecutive reveals of the **same** object do not restart the animation — the class was never
absent between them — so the glow stays up and fades once, measured from the last of them. That is
the right reading of a held-down Cmd+Z walking back over one car.

---

### `capture.ts`

Camera helpers, shared by both views.

| Export | Description |
|---|---|
| `DEFAULT_CAMERA_CONSTRAINTS` | 1920×1080 ideal, rear-facing, no audio |
| `getCameraStream(constraints?)` | `getUserMedia` wrapper; returns a `MediaStream` |
| `captureFromCamera()` | Opens the camera, grabs one JPEG frame as a `Uint8Array`, and always stops the tracks — with a 5 s timeout |

---

### `persistence.ts`

Where a session's work goes when it is saved, and the two ways of putting it there ([#48]).

| Export | Description |
|---|---|
| `FileBinding` | `{ stem, handle? }` — the file this session writes back to. **A handle means Save overwrites; no handle means Save downloads a new generation.** |
| `SaveOutcome` | `{ kind: 'wrote' \| 'downloaded', binding, filename }` or `{ kind: 'cancelled' }` |
| `OpenedArchive` | `{ file, binding }` |
| `supportsFileSystemAccess()` | Whether a file can be written back in place |
| `fileStem(filename)` | `west-yard.r49` → `west-yard` |
| `timestampedName(stem, date?)` | `west-yard-20260802-1432.r49` — the download path's filename |
| `openArchive()` | Picker where one exists, file input everywhere else; `null` on dismissal |
| `writeArchive(bytes, binding, { rebind? })` | Writes, and reports which way |

A browser cannot write to a file handed to it through `<input type="file">`. Only the File System
Access API yields a writable handle, and that API is **Chromium desktop only** — not Firefox, not
Safari, and on no phone at all. Since `ui/CLAUDE.md` supports all three engines equally and the
labeling device is a phone, write-back is an enhancement over a download path that **stays
permanently**, never a replacement for it. This module exists so that split lives in one place.

`writeArchive` takes four routes, in order:

1. A bound handle, `rebind` false — **overwrite it, silently**. `createWritable` stages into a swap
   file and commits on `close()`, so an interrupted write cannot truncate the original. That
   atomicity is the whole safety net, by decision: no `.bak`, and no verification read, because
   re-parsing every image on every save costs more than the failure it would guard.
2. A bound handle whose write permission is **refused** — falls through to (4) rather than failing.
   A denied prompt must not cost the user a save, and a second dialog would be asking twice.
3. No handle (or `rebind`), API present — the **picker**, suggesting the binding's *plain* stem.
   Dismissal returns `cancelled`; the old binding stands.
4. No API — a **timestamped download**, returning the binding unchanged. A download binds nothing,
   so the next save asks the same question again.

Two rules that are easy to get backwards:

* **The timestamp belongs to the download path alone.** A written-back file keeps its name across
  every later overwrite, so a timestamp in the picker's suggestion would be a name asserting a save
  time the file no longer has — worse than no timestamp, because one invites trust. The format is
  coarse-to-fine and zero-padded precisely so a **lexical sort of the folder is a chronological
  one**, which is what makes the newest generation the one you can see rather than the one you have
  to remember.
* **Write permission is requested lazily, at the first save.** `showOpenFilePicker` grants read
  only. Asking at open time raises an "edit your file?" prompt before the user has edited anything,
  which invites a reflexive block; asking at Save puts it where its purpose is visible. A New layout
  never sees it, since the save picker grants readwrite outright.

The picker methods and the permission pair are declared as **narrow local interfaces**: they are
absent from `lib.dom` (unlike `FileSystemFileHandle` itself, which OPFS put there), and a
`window as any` here would be the cast that spreads.

---

### `history.ts`

The editor's undo stack. A plain module, not an element: `rr-app` owns one instance and passes it
down. It is deliberately **not** part of `@occupancy/r49`, which is a parser/serializer — an edit
history is an editing-session concept, coupled here to view state that means nothing to the training
exporter or to `lib/r49/tests/fixtures.test.ts`.

| Export | Description |
|---|---|
| `EditHistory` | `attach`, `record`, `beginGesture`, `undo`, `redo`, `markSaved`; `canUndo`/`canRedo`/`undoEntry`/`redoEntry`/`undoLabel`/`redoLabel`/`isDirty`/`size`/`bytes` |
| `HistoryTarget` | `{ kind: 'layout' }`, `{ kind: 'image', filename }`, or `{ kind: 'images' }` |
| `HistoryEntry` | What `undo`/`redo` return, so the caller can reveal what changed. Carries `highlights` |
| `HistoryHighlight` | One object an entry changed: `{ kind: 'car' \| 'sensor', id }` or `{ kind: 'calibration', px }` |
| `changedObjects(target, before, after)` | The diff behind `highlights`. Pure, and exported for its own tests |
| `revealTarget(entry)` | The image an entry must bring into view before it lands, or `undefined`. The navigation invariant in one function — `rr-app` and the chain's own undo both read it. Takes `null` too, since callers ask it of a *pending* entry |
| `HistoryGesture` | An open gesture. One method, `commit()`, returning whether an entry was recorded |
| `DEFAULT_HISTORY_BUDGET_BYTES` | 256 MB. A UI constant, **not** a `config.yaml` value — nothing outside `ui/` can read it |

Entries are **scoped snapshots** — `before`/`after` clones of the one subtree touched — so undo and
redo are one operation with the fields swapped, and there is no per-command inverse to author
wrongly. Retention is bounded by bytes rather than entry count, because entries range from a
kilobyte to a whole JPEG; eviction truncates the oldest end and never punches a hole.

**`record` brackets one mutation; `beginGesture` brackets a drag.** A drag mutates on every
pointer-move and must still be one Cmd+Z, so the snapshot is taken when the gesture opens
(pointer-down), the caller mutates freely, and `commit()` closes it (pointer-up). `commit()` returns
`false` — recording nothing — when the subtree came back byte-identical, which is how a drag returned
to its origin costs no entry. It is idempotent, because pointer-up and pointer-cancel can both arrive
for one gesture, and `attach` drops an open gesture with the archive it snapshotted.

That **one entry can cover several objects** falls out of the target being a subtree: a coupler drag
moves two cars inside one image record, and a single `{ kind: 'image' }` gesture already covers both.

Two guards follow. **Undo and redo are refused while a gesture is open** — the drag has already
mutated the manifest outside the stack, so applying an older snapshot over it would leave the commit
comparing against a `before` that never existed; the press ends first, and the next Cmd+Z behaves
normally. And `record` inside an open gesture **warns**: the gesture would record the same mutation a
second time.

Because that first guard makes an abandoned gesture expensive — undo would stay dead until the
archive is replaced — every caller owes it an ending. `rr-editor-view` closes one on a repeated
`pointerId` and on disconnect, and `attach` drops one outright. `commit()` pushes its entry **before
it yields**, so closing a stale gesture and opening the next one in the same handler records both.

**An entry knows what it changed**, and it is a *diff* of its own two snapshots rather than anything
the caller declared ([#37]). That is the only honest answer available here — the mutation is an
opaque callback — and it is the answer that stays right when one gesture moves two cars. Cars and
sensors are identified by `id`; a calibration point has none, so it is identified by the whole point,
which means a **moved** point comes back twice, once at each end of the move. Exactly one of those
exists once the snapshot has landed, and resolving that is `rr-editor-view`'s job. Because the diff
is symmetric, undo and redo light the same objects.

---

## Testing

Vitest in a **jsdom** environment, with `tests/<module>.test.ts` mirroring `src/<module>.ts`. Run
`pnpm test` from the repo root: it covers `lib/*` as well, and the UI consumes those packages as
TypeScript source.

`tests/setup.ts` supplies what jsdom lacks globally — `ResizeObserver`, `Element.animate`,
`matchMedia`, `URL.createObjectURL` — and individual test files stub the rest (`PointerEvent`, SVG
geometry, `getUserMedia`).

Two patterns are in use:

**Pure template modules** — render into a detached element and assert with vitest's `expect`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import { markerDefs, renderMarker } from '../src/marker.js';

it('renders a validation rect for a status', () => {
  const container = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  render(svg`${markerDefs()}${renderMarker({ id: '1', x: 0, y: 0, type: 'track', status: 'mismatch' }, 36)}`, container);
  expect(container.querySelector('.validation-rect')?.getAttribute('data-status')).toBe('mismatch');
});
```

Colors come from `markerStyles` via the `data-status` attribute — assert the attribute, not a
`stroke` attribute, which the markup does not carry.

**Components** — `@open-wc/testing` fixtures with its chai-style `expect`:

```typescript
import { fixture, html, expect } from '@open-wc/testing';
import '../src/rr-viewer.js';

it('renders <img> when src is set', async () => {
  const el = await fixture(html`<rr-viewer src="test.jpg"></rr-viewer>`);
  expect(el.shadowRoot!.querySelector('img')).to.exist;
});
```

**jsdom does not lay out or paint.** `getBoundingClientRect()` returns zeros and SVG geometry methods
are absent, so `rr-viewer`'s tests stub `createSVGPoint`/`getScreenCTM` per test. Assert DOM
structure, attributes, and emitted events — visual appearance cannot be verified here.

`capture.ts` has no tests yet.
