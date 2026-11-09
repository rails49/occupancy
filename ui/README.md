# UI

Web app for configuring track occupancy detection, plus a live view for real-time observation.

`.r49` archives are opened and saved through the file picker, and classification runs in the browser
via ONNX Runtime. There is no backend of this package's; where an
[occupancy service](../GLOSSARY.md#occupancy) answers at `/live` on the page's own origin, the live
view shows that service's frames and answers ([#331], `liveContract.ts`, `occupancyService.ts`) and
the page opens the archive that service serves and saves back to it ([#333],
`serviceArchive.ts`). The deployed site serves none, and the editor is client-side either way.

* **`../SPEC.md`** — what the system is *for*, and the requirements it is working toward. Covers the
  whole project, not just this package. Much of it is not built yet; treat it as the target, not a
  description.
* **`CLAUDE.md`** — conventions, coding standards and testing rules.
* **[`../docs/UI.md`](../docs/UI.md)** — how the modules work, and the invariants an edit can break.
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
rr-app                          ← shell: owns the editing session and the view mode
├── look-shell                  ← @rails49/look: the page
│   ├── look-band               ← UI name, layout name and scale, where Save writes, settings gear
│   └── look-rail               ← the views; in the editor, File, History and Tools
├── rr-settings-dialog          ← layout metadata + required-metadata gate (look-dialog)
├── rr-discard-dialog           ← Save, Discard changes or Cancel before New and Open (look-dialog)
├── rr-editor-view              ← editor mode; drives editSession.ts, the rules for one archive
│   ├── rr-viewer               ← SHARED: media + SVG overlay; reports pointer gestures
│   │   ├── calibrationMarker.ts ← module, not an element: the labelled crosshair
│   │   ├── sensorMarker.ts     ← module: the labelled diamond, recoloured by L1 state
│   │   ├── carMarker.ts        ← module: the authored chord + rectangle, and the L0 box
│   │   └── trackMarker.ts      ← module: a track's centerline and its two rails
│   ├── rr-thumbnail-bar        ← horizontal image selector strip
│   ├── rr-calibration-dialog   ← asks for a point's x/y/z in mm (look-dialog)
│   ├── rr-sensor-dialog        ← edits a sensor's id and optional name (look-dialog)
│   └── rr-context-menu         ← right-click verbs on one object (sl-menu)
├── rr-live-view                ← live mode; owns the L0→L1 loop, over a frame and a result source
│   ├── rr-stats-bar            ← FPS / cars / occupied / inference / L0 age / drift overlay
│   ├── rr-viewer               ← SAME component, video source instead of img
│   │   ├── sensorMarker.ts     ← the diamond, coloured by occupied / clear / unknown
│   │   ├── carMarker.ts        ← renderDetection: the dashed L0 box
│   │   └── trackMarker.ts      ← centerlines, while Details is open in service mode
│   └── rr-service-details      ← service mode's Details panel: a service's fields and patches
└── rr-diagnostics-view         ← diagnostics mode; sweeps the archive, owns the results
    ├── rr-diagnostics-report   ← scorecard, sortable per-image table, crop strip
    │   └── rr-viewer           ← SAME component, one crop per finding (zoom rect)
    └── rr-diagnostics-queue    ← one disagreement at a time, on one image
        └── rr-viewer           ← SAME component, zoomed to the finding
```

> **The editor authors calibration points, track, sensors and cars.** v3's point-marker
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
> size correct with no arithmetic changed. [#284] added the **track tool**, and
> sensors and car ends now land on the nearest centerline. [#298] made it fit
> straights and arcs to the clicks, with the clicks as the only handles, and
> [#317] builds the line through every click, with gaps the person marks straight.
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
> [#85]: https://github.com/rails49/occupancy/issues/85
> [#87]: https://github.com/rails49/occupancy/issues/87
> [#94]: https://github.com/rails49/occupancy/issues/94
> [#118]: https://github.com/rails49/occupancy/issues/118
> [#139]: https://github.com/rails49/occupancy/issues/139
> [#148]: https://github.com/rails49/occupancy/issues/148
> [#149]: https://github.com/rails49/occupancy/issues/149
> [#151]: https://github.com/rails49/occupancy/issues/151
> [#206]: https://github.com/rails49/occupancy/issues/206
> [#217]: https://github.com/rails49/occupancy/issues/217
> [#252]: https://github.com/rails49/occupancy/issues/252
> [#254]: https://github.com/rails49/occupancy/issues/254
> [#255]: https://github.com/rails49/occupancy/issues/255
> [#256]: https://github.com/rails49/occupancy/issues/256
> [#260]: https://github.com/rails49/occupancy/issues/260
> [#262]: https://github.com/rails49/occupancy/issues/262
> [#265]: https://github.com/rails49/occupancy/issues/265
> [#274]: https://github.com/rails49/occupancy/issues/274
> [#284]: https://github.com/rails49/occupancy/issues/284
> [#298]: https://github.com/rails49/occupancy/issues/298
> [#302]: https://github.com/rails49/occupancy/issues/302
> [#303]: https://github.com/rails49/occupancy/issues/303
> [#307]: https://github.com/rails49/occupancy/issues/307
> [#311]: https://github.com/rails49/occupancy/issues/311
> [#313]: https://github.com/rails49/occupancy/issues/313
> [#317]: https://github.com/rails49/occupancy/issues/317
> [#320]: https://github.com/rails49/occupancy/issues/320
> [#321]: https://github.com/rails49/occupancy/issues/321
> [#324]: https://github.com/rails49/occupancy/issues/324
> [#326]: https://github.com/rails49/occupancy/issues/326
> [#330]: https://github.com/rails49/occupancy/issues/330
> [#331]: https://github.com/rails49/occupancy/issues/331
> [#332]: https://github.com/rails49/occupancy/issues/332
> [#333]: https://github.com/rails49/occupancy/issues/333
> [#334]: https://github.com/rails49/occupancy/issues/334
> [#335]: https://github.com/rails49/occupancy/issues/335
> [#336]: https://github.com/rails49/occupancy/issues/336
> [#341]: https://github.com/rails49/occupancy/pull/341

## State and data flow

There is no Lit context and no shared store. `rr-app` creates one `EditSession` per archive on New,
on Open, and on finding an archive an occupancy service serves ([#333]) (`editSession.ts`,
ADR 0017), and passes it down as the `.session` property; the live and diagnostics views get its
`.archive`. Children report upward with bubbling `rr-*` custom events, and `rr-app` and the editor
both subscribe to the session:

```
        .session ↓                    ↑ rr-* events (bubbles: true, composed: true)
rr-app ─────────── rr-editor-view ─────────── rr-viewer / rr-thumbnail-bar
   │
   └─────────────── rr-live-view ───────────── rr-viewer / rr-stats-bar
```

* **`rr-app` owns:** the session, the view mode, the band and the rail, file new/open/save, and the
  occupancy service it found on this origin ([#331], [#333], `liveContract.ts` § `findService`). The
  check runs once at page start and is silent where there is no service; where there is one, the
  service is handed to `rr-live-view` as both of its sources **and** the archive it serves is opened
  and bound. New, Open and a picker Save As leave it behind for good — including an answer, or a
  load, that arrives after them.
* **The `EditSession` owns:** the archive and its **undo history**, the image on screen, **the
  active tool**, the **chain in progress**, and the open drag. Every manifest write the editor and
  the settings dialog make is one of its methods, and each goes through `history.record` (or one
  `beginGesture` per drag). A chain in progress writes nothing until the click that closes a car on
  it, so abandoning one leaves both the manifest and the stack untouched — however many cars the
  chain already wrote, since each of those is its own committed entry.
* **`rr-editor-view` owns:** blob URLs for the images and the order they are read in ([#333]: the
  image on screen first, one at a time, and what it could not read), the cursor the rubber band
  follows, the dialog or menu that is open and what it is open on, the highlight after an undo, and
  the thumbnails. It also owns the one control that sets `labeled_complete`, which is the only place in the
  format a human asserts something about absence. **The zoom is view state** ([#44]): a rect of the
  authored frame it hands the viewer, `null` for fit. It records nothing, it survives an image
  change and a live chain, New and Open drop it, and a **reveal pans to keep what an undo changed on
  screen** — panning at the same zoom level where the changed objects fit, and fitting where they do
  not.
* **`rr-live-view` owns:** the loop, the drift check and what it decides, the recording, the
  layout's DPT and the frame rate. **The frames and the answers are a source's** ([#330],
  `liveSources.ts`): a `FrameSource` hands over a frame and a `ResultSource` answers it, which is
  the camera and the shipped detector unless the view is given others. A source may bring its own
  layout, and then the view draws from that and not from the archive ([#331]). It never mutates the
  archive.
* **`rr-diagnostics-view` owns:** one sweep of the archive — a detector session, blob URLs, the raw
  detections per image, the confidence floor, and which image (if any) is being reviewed. It never
  mutates the archive either; diagnostics is read-only by construction, so nothing it shows can
  change what it is measuring. The sweep runs at a **confidence floor far below the shipped
  threshold** and filters afterwards, which is what makes the threshold control free: re-scoring is
  pure arithmetic where re-running inference is twenty seconds of WASM.
* **Only two views load a model, and they load it the same way.** Both go through
  `detectorSession.ts`, which is the one place `ort.env.wasm.wasmPaths` is set and the one place the
  model URL is read. The classifier is in rails49/detector
  and nothing loads it ([#7], [#85]): L1 is a pure function of L0, so the per-sensor answer is a
  geometric consequence of the detector's boxes and there is nothing for a second model to say.

Lit does not observe mutations *inside* `R49Archive`. The session tells its listeners after every
change, which is what re-renders the editor and the rail, including after a settings edit
(`editLayout`, `setCameraHeight`).

**Every manifest mutation goes through `history.record`** (see `history.ts`), so an edit made by
reaching into the archive directly leaves an undo stack that is wrong rather than short.

---

## Component reference

### `rr-app`

Application shell. Owns the editing session and routes between the views.

**Internal state** (no public properties): `_session`, `_viewMode`
(`'editor' | 'live' | 'diagnostics'`), `_binding`, `_service`. Starts with no session and no
binding; where this origin serves an occupancy service, both arrive from it ([#333]).

**Handles:** `look-view` and `look-press` from its own band and rail, `rr-layout-change`,
`rr-camera-height-change`, `rr-notify`.

`rr-notify` is a child's transient message, toasted here because this is where toasts live. A toast
shows its message as text, never as HTML. It is raised at `warning`, never `danger`: everything that
reaches it is the editor **declining** to author something, which is the editor working rather than
failing. It stays up until the user closes it ([#265]), or for the detail's `duration` in ms when it
gives one.

**Keyboard:** Cmd/Ctrl+Z and Cmd+Shift+Z / Ctrl+Y, and Cmd/Ctrl+S and Cmd/Ctrl+Shift+S for Save
and Save As, bound on `window`, **editor view only**. When Save runs is in `docs/UI.md` § Saving
([#326]). Undo and redo bail when a field has focus, testing `event.composedPath()[0]` rather than `event.target` —
Shoelace inputs are custom elements, so `target` is retargeted to the host and the naive check would
hijack Cmd+Z mid-typing. A press with a drag still live does nothing (see `history.ts`).

* New and Open **confirm before discarding unsaved changes** (`session.history.isDirty`),
  since replacing the archive takes the undo stack with it. **Closing or reloading the tab is guarded
  by the same predicate** ([#49]): a `beforeunload` listener registered in `connectedCallback` beside
  the keydown one, permanently, with `isDirty` checked at fire time. It calls `preventDefault()` *and*
  sets the legacy `returnValue`, and shares nothing with `_confirmDiscard()`, which answers with a
  boolean `beforeunload` cannot use — all it may do is cancel and let the browser ask, in wording
  nobody can set. Together these are the destructive acts undo cannot cover.
* Save marks the history position saved rather than clearing it — undoing past a save is
  legitimate, because the bytes on disk are unaffected.
* Undo and redo call `session.undo()` and `session.redo()`, which select the image the entry is on,
  apply it, and tell the editor what to highlight ([#37]). A live chain takes every undo ([#33]).

* New builds an empty **v4** manifest — layout `'New Layout'`, scale `N`, resolution
  1920×1080 until the first image replaces it ([#254]), empty calibration points and no
  sensors. It **clears the binding**: the new archive is
  emphatically not the file that was open.
* Open and Save go through `persistence.ts`, which owns the choice between the occupancy service,
  overwriting a file and downloading a new generation ([#48], [#333]). The binding is set **only
  once the bytes parse** — a binding to a file that failed to load would aim the next save at an
  archive this session never held.
* Save hands the **archive** to `writeArchive`, with `look-press`'s `shiftKey` meaning Save As. A
  dismissed picker returns early: nothing written, nothing marked, no toast. A refusal from the
  service says what the service said, up until it is closed, and marks nothing. Everything else
  marks the history saved, including a download — the fallback did write a file, and refusing to
  mark it would leave a phone permanently dirty. The toast names the verb and the file, because
  "Saved" would hide which of the three things just happened.
* **The history position is taken before the first request** and that position is marked, so an
  edit made while the save was in flight leaves the archive dirty. A Save pressed while one is
  running does nothing, and a toast stays up while it runs ([#333]).
* The **stem** is the binding's, falling back to `layout.name` for an archive that has never been
  saved — which an archive on a service always is. It does not follow a later rename: the file's
  identity is the file, and `layout.name` is metadata stored inside it.
* The band names where Save writes in a `look-reading`, and **only where that is something that
  exists**: the bound filename where there is a handle, "occupancy service" where the archive came
  from one and took an `ETag`. A download, and a read-only service, name nothing writable and stay
  quiet.
* At page start, with nothing open, it looks for an occupancy service and **opens the archive it
  serves** ([#333]): the check's `ETag` first, then `R49Archive.load` on the service's `archive/`
  base URL. An archive the person
  opened or created first wins, before the check answers and before the load does. No service, or a
  service that is not one, is silent. A manifest that will not load gets the failed-load toast.
  New, Open and a picker Save As leave the service behind for good.
* `look-band`'s `ui` is "occupancy"; look draws the mark and the UI name (org
  [ADR-0019](https://github.com/rails49/.github/blob/main/docs/adr/0019-the-band-starts-with-the-mark-and-the-ui-name.md), [#206]).
* `look-about` carries the layout's name and its **scale** as the detail ([#52]), read out of the
  manifest on every render so a scale changed in the settings dialog is the one shown. It is there
  **only once a manifest has been read**: with nothing loaded it would repeat the UI name, and the
  `N` the settings dialog renders against is a placeholder, an answer no archive gave.
* Loading is a toast, not band text.
* **Saving does not validate calibration.** The v3 check read `{p0, p1, size_mm}` structurally, which
  v4 has not — calibration is a list of points that legitimately starts empty, so "uncalibrated" is a
  state the editor reports rather than an error to refuse a save over.

Feedback is a Shoelace `sl-alert` toast (`_notify`), not `alert()`.

---

### The band and the rail

`rr-app` declares the chrome on [`@rails49/look`](https://github.com/rails49/look)'s elements, which
draw it; the app styles none of it, and `look-check` in `bin/test.sh` holds it to that. `look-gear`
opens `rr-settings-dialog`. There is no source link and no unsaved mark.

The rail's first group is the three views — Label, Live, Diagnostics — each one click away and the
current one marked ([#87]). A `look-view` event switches. Live and Diagnostics show the views alone;
the editor adds three command groups:

| Group | Commands | |
|---|---|---|
| File | `#file-new`, `#file-open`, `#file-save` (`Mod+S`) | A Shift-click on Save, or `Shift+Mod+S`, is Save As ([#48]) |
| History | `#edit-undo` (`Mod+Z`), `#edit-redo` (`Shift+Mod+Z`) | Disabled when the stack is empty |
| Tools | `#tool-calibration`, `#tool-track`, `#tool-sensor`, `#tool-car` | Only while a manifest is loaded, in the order they are used; the active tool is `pressed` |

Save As is a modifier rather than a button of its own: on a browser without the File System Access
API it does exactly what Save does. The tooltip **names the modifier only where the browser can
honour it**.

Undo and Redo are not a duplicate of the keys. Their **disabled state** is the only signal
separating "the stack is empty" from "the undo landed on an image you are not looking at", and
touch devices have no Cmd+Z at all. The tooltip names the edit, and the image when the entry lands
on one not on screen: "Undo delete car — img_3.jpg".

The tools are `tools.ts`'s `TOOLS`. The session holds the active tool; the rail reads it, whether
DPT resolves, and the image on screen from the session, and a press calls `session.selectTool`. **While DPT is unresolved the sensor and car tools are disabled, and
`GATE_REASON` is their tooltip.** It names **DPT** rather than the width rectangle: the rectangle
is why the *car* tool is gated, but a sensor is a single point and would draw fine uncalibrated.
Calibration itself is never gated: it is the tool that *produces* the DPT. The gate is on
**existence, never completion** (`../SPEC.md` § Labeling Workflow), and it opens and closes live.

> The sensor tool is gated with the car tool at [#31]'s request, one step beyond `../SPEC.md`
> § Labeling Workflow ("sensors can be placed at any time"). `needsDpt` is per tool in `tools.ts`.

At or below look's `TURN_HEIGHT_PX` the rail lies down as a strip along the top of the work pane
([#42]).

---

### `rr-settings-dialog`

Layout metadata, in a medium `look-dialog` with a single "Layout" tab: name, scale (from `VALID_SCALES`),
camera height, description, and contact. It is also the **required-metadata gate** ([#139]).
Below the tabs, a line links to [rails49/detector](https://github.com/rails49/detector), the source
of the AGPL-3.0 model and runtime the site serves ([#274]).

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

Classifier selection is **not implemented**: there is no classifier tab, and nothing loads the
classifier (ADR 0004).

---

### `rr-discard-dialog`

Asks what to do with unsaved changes before New or Open replaces the archive. Opened imperatively
with `ask()`, which resolves `'save'`, `'discard'` or `'cancel'`; closing the dialog any other way is
`'cancel'`. `rr-app` goes ahead after a discard, or after a save that leaves the history clean, and
stays otherwise.

---

### `rr-sensor-dialog`

Edits a sensor's **`id`** and its **optional** name ([#335]). Opened imperatively with
`show({ id, name }, { taken })`, like `rr-calibration-dialog`, because the values it starts from
belong to the gesture. `taken` is every sensor id in the layout — uniqueness is a property of the
layout, which the dialog cannot otherwise see; this sensor's own id may be among them.

**Emits:** `rr-sensor-commit` `{ id: string, name: string | null }`, both trimmed. The `id` has
already passed `sensorId.ts`'s rule, so the dialog commits nothing the session would refuse.
`name`'s `null` is "no name" — a cleared field is how a name is *removed*, and the editor writes
that as the absence of the key rather than as `""`.

**The id is judged and the name is not.** The id is what a controller knows the sensor by, so a
refusal from `sensorIdRefusal` appears under the field as the person types, and Save and Enter do
nothing until it is fixed. There is **no toast**: the field the refusal is about is on screen, and
the dialog stays open. Names stay free text and not unique, because a controller mapping keyed on a
name breaks the moment someone renames it (`../SPEC.md` § Occupancy Output).

Editing is separate from placing, because a sensor is complete the moment it is placed: it has a
generated `id`, which it keeps until a person changes it, and `name` is optional passthrough that is
never auto-generated.

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
`{ source: 'camera' | 'file' }`, `rr-image-reorder` `{ from, to }`. The `'file'` button opens one
picker for any number of files ([#262]); how many were chosen is `rr-editor-view`'s business, not
this bar's.

---

### `rr-viewer` ⭐ shared by both views

Displays media — image or video — under an SVG marker overlay, and reports pointer gestures in
image pixel coordinates.

| Property | Type | Description |
|---|---|---|
| `src` | `string \| null` | Image URL (editor mode) |
| `stream` | `MediaStream \| null` | Video stream (live mode) |
| `calibrationPoints` | `readonly ReferencePoint[]` | Crosshairs to draw; empty in the live view |
| `sensors` | `readonly Sensor[]` | Diamonds to draw. Per **layout**, so the same list draws over every image; the live view passes the same list |
| `sensorStates` | `ReadonlyMap<string, SensorState> \| null` | L1 per sensor, keyed by `id`. **`null` is the editor** — nothing is reading these sensors, which is not the same as reading them and finding nothing |
| `detections` | `readonly Detection[]` | L0 for this frame: dashed oriented boxes at the model's **own** predicted width. Empty in the editor |
| `cars` | `readonly CarLabel[]` | Car spans to draw: a chord inside its width rectangle. Per **image**, so switching images swaps the whole list; empty in the live view |
| `pendingCar` | `PendingCar \| null` | The **rubber band** — `{ anchor, to }` for the chain in flight. The one thing here that is not in the manifest; empty in the live view |
| `tracks` | `readonly Track[]` | The layout's tracks ([#284]), drawn under everything else. Per layout, so the same on every image. The live view passes the service's tracks while Details is open ([#332]), and none otherwise |
| `pendingTrack` | `Track \| null` | The line drawn blue ([#324]): the one a track chain is tracing, or one a drag of its click or an insert is changing. The editor leaves that line out of `tracks` |
| `trackCues` | `TrackCues \| null` | What the track tool draws over the tracks ([#324]): the ring on the traced line's end, hollow end dots when none is traced, and the preview or hover at the pointer. `null` under another tool |
| `trackDetail` | `boolean` | Whether tracks show their rails and click dots, or the centerline alone. The editor sets it while the track tool is chosen |
| `highlight` | `ViewerHighlight \| null` | The objects a reveal is pointing at — `{ cars, sensors, calibration, trackClicks }`, ids for the first two, **indices** for the third and pixels for the fourth. Already resolved by `rr-editor-view`; the viewer draws it and decides nothing. `null` in the live view |
| `zoom` | `Rect \| null` | The region of the **authored frame** on screen ([#44]). `null` is fit — the absence of a zoom, which is exactly what this element drew before the property existed. View state the editor owns; never in the manifest and never in the history. `null` in the live view |
| `zoomPreview` | `Rect \| null` | The rect being dragged out — zoom's counterpart to `pendingCar`. Drawn in the overlay with a screen-constant stroke, never as an HTML box on the glass |
| `dpt` | `number \| null` | The scale the **world-sized** symbols are drawn at. `null` falls them back to `symbolSize` |
| `resolution` | `{ width, height }` | `camera.resolution` — the frame every coordinate is **authored** in. Not the viewBox: the viewBox is the media's own size, and this is scaled onto it |

**Emits:** `rr-pointer-down`, `rr-pointer-move`, `rr-pointer-up`, `rr-pointer-cancel`,
`rr-pointer-leave` (`ViewerPointerDetail`), `rr-pointer-contextmenu` (`ViewerContextMenuDetail`),
`rr-pointer-dblclick` (`ViewerDoubleClickDetail`, after the pointer events of its two clicks), `rr-wheel`
(`ViewerWheelDetail`, without `preventDefault`), `rr-media-frame`
(`ViewerMediaFrameDetail`, once per media load) and `rr-viewport` (`ViewerViewportDetail`, whenever
the measured viewport changes size). All ten fire in both `src` and `stream` mode. They are declared in `HTMLElementEventMap`, so a listener anywhere up
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
and `detections`/`sensorStates` are computed by `@rails49/detector` and handed down. `interactive`, `activeTool`, `calibration`, and the four events that
mutated (`rr-marker-add`, `rr-marker-move`, `rr-marker-delete`, `rr-calibration-move`) were removed
in the v4 reduction and do not come back — v4 has neither point markers nor a draggable `{p0, p1}`
pair. The viewer reports where the pointer is; deciding what that means is the editor's job, and the
arithmetic it needs is in `geometry.ts`. The right-click is **not** `preventDefault()`ed here, since
whether the native menu is suppressed depends on editor state: `rr-editor-view` suppresses every
right-click it hears, and `rr-live-view` does not listen at all.

**Methods:** `getVideoElement()` — `cameraFrameSource.ts` reads the live frame back out of the
`<video>` this element mounted, rather than decoding the stream a second time ([#330]).
`getImageElement()` has no caller since the live view's frame check dropped its image branch, which
could not run: the live view never sets `src`.

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
**sensor's diamond** is not one of those: it is drawn two **track widths** across, and a track width in image
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
| `trackWidthPx(dpt)` | Track width in image pixels — which **is** DPT, since `getDPT` returns px/mm × gauge_mm. A sensor is drawn two of these across |
| `sensorDiameterPx(dpt, imagePxPerScreenPx)` | The diameter a sensor is **drawn** at: two track widths, or the screen-constant size with no DPT. The renderer and the hit-test share it, so what you see is what you can grab |
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

**Both constants are `@rails49/detector`'s**, and `ui/` reaches them only through `@rails49/detector`'s `carWidthPx`, which this re-exports. The scale ratio cancels out of the width formula —
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
| `renderCalibrationPoint(point, index, size, frame, highlighted?)` | `(ReferencePoint, number, number, FrameSize, boolean?) => SVGTemplateResult` | A crosshair centered on `point.px`, a small circle at the exact pixel, and a `text` label carrying the world coordinate. `size` is in image pixels — `rr-viewer`'s `symbolSize`, so the crosshair is constant on screen; `frame` is its `resolution` |
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
the vocabulary in `@rails49/r49`'s data file, read directly as `@rails49/r49/data.json`, so a
subtype added in an `@rails49/r49` release reaches the editor's menu at the next version bump, with
no code edit.

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
the vocabulary would punish vocabulary edits. So a non-conforming class is a visible warning in the editor
(`rr-viewer` marks the car red and names the class) and a fatal error in the training exporter later.

---

### `sensorMarker.ts`

The sensor's own SVG, with the same shape and the same rules as `calibrationMarker.ts`. **The exports
must be used together** — styles in the host's `static styles`, the renderer once per sensor.

| Export | Type | Description |
|---|---|---|
| `renderSensor(sensor, size, frame, highlighted?)` | `(Sensor, SensorSymbolSize, FrameSize, boolean?) => SVGTemplateResult` | A diamond centered on the sensor, a filled core at the exact pixel, and a `text` label. `frame` is `rr-viewer`'s `resolution`; `highlighted` adds `highlight.ts`'s class |
| `SensorSymbolSize` | `{ diameterPx, labelPx }` | **Two independent sizes.** `diameterPx` is a *world* size — two track widths, so the diamond shrinks with the photograph; `labelPx` is a *screen* size, from the viewer's `symbolSize` |
| `sensorLabelText(sensor)` | `(Sensor) => string` | The sensor's `name`, or its `id` when it has none |
| `sensorMarkerStyles` | `CSSResult` | Diamond and label colors, the translucent fill, non-scaling strokes |

**Amber diamond against the crosshair's cyan arms**, and the difference is shape as much as colour: a
sensor and a calibration point are different objects with different tools, and `../SPEC.md`
§ Reference points requires them to be unmistakable. The symbol also *closes* around its pixel rather
than extending arms, because a sensor is a single query point and nothing about it implies an extent.

**The diamond is two track widths across**, not a constant size on screen — the only honest sense of
how big a sensor is comes from the track it sits on, and a car is 2.09 of the same unit, so the two
are directly comparable on the photograph. The **label is a screen size**, because it is annotation
about the sensor rather than a measurement of it: a name scaled to the track is illegible at the
DPT 18–19 the fixture corpus sits at. The centre dot has a **floor** (`MIN_CORE_RADIUS_PX`): it names
the pixel the sensor *is*, and 12% of a 36-pixel diamond is not a visible dot.

**An unnamed sensor is labelled with its `id`.** Names are optional, free text, not unique, and never
auto-generated (`../SPEC.md` § Occupancy Output): an invented "Sensor 3" is indistinguishable from a
name a human chose and stops matching as sensors come and go. A blank name is treated as no name.

`frame` is the label's business only, exactly as for the crosshair, and through the same
`placeLabel`.

---

### `chain.ts`, `carChain.ts`, `trackChain.ts`

A chain is what the car tool and the track tool share ([#33], [#284]): each click adds one segment —
a car on the image on screen, or a gap of one track — as one history entry. `EditSession`
holds at most one live `Chain` and runs click, undo, redo, right-click and drags the same way for
both; each tool module supplies what differs.

| Export | Description |
|---|---|
| `Chain` | A live chain: `view()`, `atStart()`, `extend(px, scale)`, `settle()`. It keeps where it started and what it wrote, and reads the dot it goes on from out of the manifest |
| `ChainTool` | A tool's half of a click with no chain live: a `ChainHit` (a chain to start or continue, or an edit to run) or null, when the session asks the other objects |
| `ChainView`, `ChainContext`, `ClickResult` | What the editor draws of a chain; what a tool reads and writes through the session, including `snap`, `refuse` and `notify`; what a click asks the editor for |
| `NO_TRACK`, `NO_TRACK_NOTICE` | Why a sensor or car end was refused: no track within `SNAP_TRACK_WIDTHS` |
| `carTool`, `ALREADY_LABELED` | A free car end continues a chain, a coupling is refused with `ALREADY_LABELED`, a click on a car's body splits it, and empty image starts a chain |
| `trackTool`, `TrackChain` | A click on a line's first or last click continues it as a chain; on a click between them it notifies `MIDDLE_CLICK` ([#324]); within `TRACK_FIT.startDistance` of a line it inserts a click there ([#321]), or notifies `NO_CLICKS` on a line with no clicks; anywhere else it starts a chain ([#298]). Each click goes on the end the chain goes on from and writes the line's clicks with the nodes of their line (`lineOf`), as one entry; a click within the grab radius of that end adds nothing, and one the rule refuses writes nothing. A chain from a first click puts new clicks at the front of the stored clicks, and its `view()` draws the line reversed. `straighten(at, scale)` on the end asks for the next gap to be straight, which the next click writes with itself ([#320]). `hold`, `move` and `remove` take a click of the traced line, by stored index, while the chain is live: `hold` draws the line of the moved clicks, or the last line the rule took, and a move or delete builds the line again and writes one entry ([#303]). `atStart()` is true once every entry the chain wrote is undone |
| `trackHover`, `TrackHover` | With no chain live, what a click at the pointer would act on: an end dot (its pixel, and whether it is square) or an insert at the pointer; null on a middle dot, near a line with no clicks, and where a click starts a line ([#324]). `trackTool` decides from the same lookup |
| `TrackChain.preview`, `TrackPreview` | The next gap a click would add, from the end the chain goes on from, in the order traced: the nodes the rule builds, or a straight to the pointer with the reason it refuses. Null within the grab radius of that end ([#324]) |
| `trackHitAt`, `clickHitAt` | The line or the click under the track tool's pointer, within the grab radius |
| `lineOf`, `refitLine`, `recordLine`, `writeTrack` | Clicks with the nodes of their line (`buildLine`, `fitNodes`), or the rule's refusal; the same for an edit with no chain live, which refuses through the session; that edit written as one entry; and a line written at its index |
| `markedClick`, `withClickAt`, `withClickIn`, `withoutClick`, `insertAt` | The click edits, which keep the marks: a click inserted into a gap takes the mark of the click before it, and a deleted click's two gaps become one, straight only if both were. `insertAt` is the line within the start distance of the pointer and the gap a click there goes in ([#321]) |

---

### `trackMarker.ts`

A track's SVG ([#284], [#317]). The exports must be used together.

| Export | Type | Description |
|---|---|---|
| `renderTrack(track, size, highlighted?)` | `(Track, TrackSymbolSize, Point[]?) => SVGTemplateResult` | The centerline as one cubic per node pair, and with `size.detail` the two rails at ±G/2 and a dot per click, a square at each end of a straight gap. No rails when `size.dpt` is `null`. A click at a pixel in `highlighted` takes `highlight.ts`'s class, and is drawn without `size.detail` too |
| `renderPendingTrack(track, size, ring?)` | `(Track, TrackSymbolSize, boolean?) => SVGTemplateResult` | The line being traced or changed, blue ([#324]): rails, centerline and a dot per click, square at each end of a straight gap and on a last click marked straight. With `ring`, the last click has a ring twice a dot's size, square on a straight end |
| `renderTrackCues(cues, size)` | `(TrackCues, TrackSymbolSize) => SVGTemplateResult` | The preview of the next gap, dashed blue, red where refused; a green ring on an end dot under the pointer; a half-opacity dot where a click would insert ([#324]) |
| `TrackSymbolSize` | `{ dpt, strokePx, dotPx, detail, hollowEnds? }` | The DPT the rails are spaced by, screen-constant stroke and dot sizes, whether to draw the rails and dots or the centerline alone, and whether a line's two end dots are hollow |
| `TrackCues` | `{ tracing, preview, hover }` | Whether a line is traced, `TrackChain.preview`'s `TrackPreview`, and `trackHover`'s `TrackHover` |
| `trackMarkerStyles` | `CSSResult` | The green ink, blue for the line being traced or changed, red for a refused preview |

### `track.ts`

What the editor draws and hits on a track ([#284]): pure functions, tested in
`tests/track.test.ts`. A `Track` is a list of `TrackNode`s (`x`, `y`, `heading` in radians,
`atan2(dy, dx)` in image pixels). The curve between two nodes, a cubic Bézier, and the nearest
point on a track are `@rails49/r49`'s (`segment`, `pointAt`, `headingAt`, `nearestOnTrack`;
FORMAT.md § Node), and so is `wrapAngle`.

| Export | Description |
|---|---|
| `segments(nodes)` | `@rails49/r49`'s `segment` between each consecutive pair of nodes |
| `trackPath(nodes)` | An SVG path, one `C` per segment |
| `offsetPoints(nodes, offset)` | Sampled points `offset` px to the right of the line; negative is left |
| `hitTrack(tracks, at, radius)` | The line under the pointer: the one with a point nearest `at` within `radius`, or null |
| `hitClick(tracks, at, radius)` | The click under the pointer: the nearest one within `radius`, as a line and an index, or null |
| `nearestGap(track, at)` | The gap whose part of the line is nearest `at`, as the index of the click it starts from |
| `squareAt(clicks, i)` | Whether click `i` ends a straight gap, and is drawn as a square |
| `nearestOnTrack(tracks, at, maxPx)`, `SNAP_TRACK_WIDTHS` | `@rails49/r49`'s nearest point on any track, when it lies within `maxPx`, or null; and the reach sensors and car ends snap within, 1.5 track widths |

### `trackFit.ts`

Straights and circular arcs, tangent at every join, through the clicks traced along the middle of
a track ([#317]): pure functions, tested in `tests/trackFit.test.ts` against synthetic lines from
`tests/trackClicks.ts` and the click sets in `tests/clickSets/`. A click set is a `gauge`, `lines`
of clicks and a `note`; a set recorded in the editor is a drop-in file. A fit is a start pose and a
length and a curvature per part.

| Export | Description |
|---|---|
| `TRACK_FIT` | The rule's constants in gauges: the tolerance (0.1), the minimum radius (10) and the start distance (1). `fitOptions(dpt)` gives the first two in pixels, as `FitOptions` |
| `buildLine(clicks, opts)` | The line through two or more clicks with their marks, as a `Built`: `line` with the `Fit`, or `refused` with a `Refusal`. A click marked `straight` starts a straight gap. Each free click is on the line; each run of straight gaps is one straight within the tolerance of its clicks; the line is the same for the clicks and marks reversed |
| `Refusal` | `behind`, a click not ahead of the click before it; `tight`, an arc under the minimum radius; `off-straight`, a click of a straight run more than the tolerance off it |
| `fitNodes(fit)` | The fit as stored nodes: the start, each part's end, and an arc cut into equal pieces of at most 90° |
| `Fit`, `Part`, `Pose` | A start pose and its parts, each a length and a curvature (0 for a straight) |

### `trackHint.ts`

| Export | Description |
|---|---|
| `trackHint(trace, refusal)` | The track tool's hint, one of three sentences: with a refusal, why and what to do; while tracing, how to click, mark a straight and end; otherwise how to start, continue or change a line. Tested in `tests/trackHint.test.ts` |
| `refusalText(reason)` | The refusal sentence alone, which the session's notices toast ([#324]) |

### `sensorId.ts`

The rule for a sensor's `id`, in **one** place ([#335]). `rr-sensor-dialog` shows its refusal under
the field and `EditSession.editSensor` refuses the write, so a message a person reads and a write
the archive refuses are the same rule rather than two that can drift.

| Export | Description |
|---|---|
| `sensorId(text)` | The id a typed string means: the text with its **ends** trimmed. Inner spaces are kept — they are part of a name a controller may already use |
| `sensorIdRefusal(text, context)` | Why the trimmed text cannot be this sensor's id, as one sentence, or `null`. `context` is `{ current, taken }`: the id the sensor holds now, and every sensor id in the layout |
| `REFUSED_SENSOR_ID_CHARACTERS` | The six characters an id may not contain, for a test or a document to enumerate |
| `SensorFields` | `{ id: string, name: string \| null }` — a sensor's editable fields, which the dialog commits and the session writes |
| `SensorIdContext` | `{ current: string \| null, taken: readonly string[] }` |

Refused: a **blank** id, one another sensor in the layout **holds**, and any of `/ + # " < &` —
`+` and `#` are MQTT's wildcards and are illegal in a topic, `/` is its level separator and would
split one id into two levels, and `"`, `<` and `&` are markup in the Rocrail profile's XML. Every
other character is allowed. Matching is **case-sensitive**, because a controller tells `c3.a` and
`C3.A` apart.

**The sensor's own `current` id is never refused**, whatever it holds. This is the *editor's*
narrower rule and not the format's, which still allows any non-empty string: an archive authored
before this rule, or by another tool, can hold an id with a refused character, and it must still
open with that sensor's name editable. Refusing it would break the dialog on exactly the archives
that need fixing.

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
| `PendingCar` | `{ anchor, to, refused? }` | The chain in flight: the end already clicked, where the next click would land, and whether it would be refused (drawn red) |
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
§ Format) — a format that refused to open files because someone pruned the vocabulary would punish
vocabulary edits — so the editor is where non-conformance becomes visible, and the exporter is where it
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

Shows an archive's images and what is authored on them, and turns pointer, dialog and menu events
into calls on an `EditSession` (`editSession.ts`). The editing rules are the session's; this
element holds dialogs and menus and what they are open on, zoom and pan, the highlight after an
undo, and blob URLs, and re-renders on every change the session reports.

| Property | Type | Description |
|---|---|---|
| `session` | `EditSession \| null` | The archive being edited, created by `rr-app` on New and Open |

**Emits:** `rr-notify` (`{ message }`) when a click is refused, such as the **car tool** clicking
inside a car already labelled ([#43]), or when an image add is refused ([#255], [#260]) — one event
per pick, however many of its files were refused ([#262]). `rr-app` owns the toast. Each notice the
session sends (`subscribeNotices`: a track refusal, or what to do instead of a track click that did
nothing) goes up as `{ message, duration: 3000 }` ([#324]).

* Makes a blob URL for each image when it first appears in the image list and revokes it when the
  image goes. A new session revokes them all.
* **An added image is prepared before it is stored** ([#255], `exifOrientation.ts`), the same way
  for the file picker and for Capture from Camera — and for Live's Freeze ([#334]), which is why
  the three steps live in `imageAdd.ts` rather than here. A JPEG's EXIF orientation tag is set to 1 in the
  bytes the archive holds — that value alone, with no re-encode — so the browser and the detector's
  readers see one array; `imageSize` then measures those bytes, which is where `camera.resolution`
  comes from ([#254]). An image whose stored array is **portrait** is refused: nothing is recorded
  and `rr-notify` names the picked file. A square or landscape image is accepted, and one that does
  not decode is added as before. `../SPEC.md` § Images holds the rule and the reason.
* **It is then the size the archive declares, or it is refused** ([#260]). `session.requiredImageSize`
  is the rule — the declared `camera.resolution` once anything is positioned in those pixels, null
  while nothing is — and `sizeRefusal(name, size, required)` is the wording: `rr-notify` names the
  file and both sizes. The picker names the picked `file.name`; a capture has no picked name, so it
  names the `capture_<id>.jpg` the archive would have held. An image that does not decode has no
  size to judge and is added as before. Undo and redo restore bytes the archive already accepted and
  are not checked.
* **One pick adds several files** ([#262]). The picker is `multiple`, and `imageAdd.ts`'s
  `addPickedFiles` prepares
  and judges each file in **filename order** — numerically and against a fixed locale, so
  `shot9.jpg` precedes `shot10.jpg` and the order does not move with the browser's — then hands what
  survives to `session.addImages`: one history entry, "add images", and the first new image on
  screen. Each file keeps its own `file.name`, with the collision fallback the session's ([#256]).
  A refused file is left out and the rest of the pick is added; the refusals are joined into **one**
  `rr-notify`. The size the pick is held to is `session.requiredImageSize`, or the first file the
  pick accepts while nothing is positioned, which is the image `addImages` takes the resolution from
  ([#254]).
* **Thumbnails are small copies** ([#252], `thumbnail.ts`): each image is decoded once into a JPEG
  `THUMBNAIL_WIDTH` (256) px wide, after every full-size URL exists, and the strip gets those URLs.
  An image that does not decode shows its full-size URL in the strip.
* **No camera-drift readout** (ADR 0020). The live view keeps its check ([#94]).
* **Pointer input.** A **click** — `rr-pointer-down` then `rr-pointer-up` within
  `CLICK_SLOP_SCREEN_PX`, on the same `pointerId` — goes to `session.click` with the **press**
  position and the press's `imagePxPerScreenPx`. What comes back is a dialog to open
  (`rr-calibration-dialog` blank or prefilled, `rr-sensor-dialog`), a notice for `rr-notify`, or
  nothing. The dialog's commit calls `placeReferencePoint`, `editReferencePoint` or `editSensor`;
  a dismissed dialog calls nothing.
  * Motion past the slop makes the press a **drag**, decided once from the press position: Shift
    draws a zoom rect; otherwise `session.beginDrag` grabs whatever is under the press, and empty
    image zooms or pans. `dragging` is **sticky**: a gesture that moved never falls through to the
    click path, even if it ended back inside the slop. Without it every swipe over the image would
    place a point, and the labeling device is a phone.
  * A press arriving mid-drag is read by its `pointerId`. A **different** one is a second finger and
    is ignored. The **same** one cannot be — a pointer does not go down twice without going up — so
    it means the previous gesture's end never arrived, and it ends that drag instead of being
    ignored. Without that, one swallowed `pointerup` (`rr-viewer` emits nothing when it has no
    transform) would leave the editor deaf to every press *and* undo dead for the session.
    `disconnectedCallback` ends an open drag for the same reason: `rr-app` replaces this element
    on the view toggle. Both **commit** what moved rather than reverting it — the objects visibly
    moved and undo covers that; a silent revert would be the editor deciding it knew better.
  * `rr-pointer-cancel` cancels the drag: everything goes back and nothing is recorded.
  * **Pointer capture** is `rr-viewer`'s (it takes it on `pointerdown`); what the editor owes it is
    not bailing on coordinates outside the image, so a drag that leaves the viewer still commits.
* **Right-click** ([#29]). `rr-pointer-contextmenu` goes to `session.rightClick`, which ends a live
  chain or names the object a menu acts on; a click of the line a track chain traces, other than its
  last, is named and the chain goes on ([#303]). The editor opens `rr-context-menu` at the cursor with
  that subject's rows — **delete** for a reference point, **edit and delete** for a sensor,
  **delete and reclassify** for a car, **Delete click** and **Delete line** on a track's click, and on the rest of a track **Make straight** or **Make free** for the gap under the pointer and **Delete line** — and a chosen row calls `delete`, `deleteLine`, `markGap`, `reclassifyCar` or opens the
  name dialog. Empty image opens nothing.
  * **Reclassify is a submenu generated from the vocabulary in `@rails49/r49`'s data file** ([#35]), through
    `vocabulary.ts`. A new car is the taxonomy's root and refinement is an occasional act, not a
    mode, which is what a submenu says and a persistent picker would not. The **root is never
    rendered** — its children are — and it is nonetheless required in the stored class, so the rows
    carry the full dotted class (`stock.loco.steam`) in the row id. A taxonomy that is only a root offers no reclassify row at all.
  * **A row is a verb; the subject holds the object.** `delete` and `reclassify:<class>`, neither
    ever shown, and the same rows whatever the subject is — the menu was opened on one object and
    resolved it then, because the user may have moved on by the time they pick. A row that only
    *opens* a submenu carries `reclassify-group:<class>` instead — its own prefix, so it can neither
    be mistaken for a verb nor collide with the row inside it that selects the same subtype.
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
* **Track hint** (`.track-hint`, [#298], [#313]). Under the DPT bar while the track tool is selected and DPT
  resolves: `trackHint`'s sentence for the line being traced, or the session's `refusal`. While the
  preview follows the pointer, the reason the rule refuses a click there, or none ([#324]).
* **DPT readout** (`.dpt-bar`). `calibrationFit()`'s DPT to one decimal, or "Not calibrated" with a
  warning style when it is `null` — a real v4 state, reported rather than blocked on, and now with the click
  that fixes it. Two further states:
  * **Fit residual** (the same result's `residual`), shown only once the fit is over-determined — more than two
    coplanar points. Below that the fit reproduces its input exactly, so a zero would claim an
    agreement nothing checked. It is what makes a mis-typed coordinate visible instead of silently
    absorbed into the scale.
  * **Below `@rails49/detector`'s `MIN_DPT`**, the bar takes the `below-minimum` warning style and says so. It **blocks
    nothing** — the six fixture archives sit at DPT 18–19, under the threshold of 20, and must stay
    openable and editable.
* **Frame mismatch** (`.frame-warning`), from the viewer's `rr-media-frame`. Shown only when the
  loaded image is a different **shape** from `camera.resolution`, naming both sizes — the two
  numbers are what says which half is wrong, since a re-cropped photo and a mis-typed resolution
  read identically otherwise. Labels on such an image are drawn through a stretch and are
  approximate. It **blocks nothing**, like a below-minimum DPT, and it is cleared when another image
  is selected: the next image reports its own size when it decodes, and one that never decodes must
  not inherit this verdict.
* **Zoom** ([#44]). Three actions and a pan, over one nullable `Rect` of the **authored frame** handed
  to `rr-viewer`. `null` is fit. Nothing here writes to the manifest, so nothing here records a
  history entry — zoom is view state, which `../SPEC.md` § Undo and redo already named.

  | Gesture | Unzoomed | Zoomed |
  |---|---|---|
  | Plain primary drag from **empty image** | zoom to the rect drawn | pan |
  | **Shift** + primary drag, anywhere | zoom to the rect drawn | zoom to the rect drawn |
  | Mouse **wheel** | toward the screen zooms in about the pointer | in or out about the pointer; out to fit at most |
  | Primary drag on an **object** | moves it (unchanged) | moves it (unchanged) |
  | Right-click | menu / end chain (unchanged) | unchanged |

  * Plain drag is the gesture that has to work: touch reports the primary button, and the labeling
    device is a phone. Shift-drag is the desktop escape hatch for a frame with no empty pixel to
    start from — the same layering as Save As. Making the plain gesture state-dependent is a real
    cost, accepted on the grounds right-click already accepts it: the two states differ by something
    the image itself makes obvious. Zoom is not a tool.
  * **Zoom to fit** is an `sl-icon-button` overlaid on the viewer, present **only while zoomed** —
    "show zoom bars as needed", applied to the one control there is. Escape does the same, and
    `rr-context-menu` swallows the Escape that dismissed it so one keystroke closes one thing. It is
    deliberately not a rail command.
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
* **The reveal after an undo** ([#37]). After an undo or redo the session tells its listeners which
  objects the entry changed. The editor lights them for `HIGHLIGHT_DURATION_MS`, held as the history
  gave them and **resolved on every render** — by `id` for a car or sensor, by pixel for a reference
  point, which has no id — so an object the apply removed lights nothing, and an edit arriving while
  the glow is up cannot leave it on a renumbered crosshair. The glow also comes off on an image
  change, a new session, or disconnect.
* **Labeling completeness** ([#36]). A `.complete-bar` sits directly above the thumbnail bar with an
  `sl-checkbox` for the image on screen, which calls `session.setComplete`; every image's flag also
  goes to `rr-thumbnail-bar` as `complete`, so the state is readable per image without selecting it.
* **It loads no model.** Marker CRUD and the per-marker classification display went with the v4
  reduction; the detector that replaced the classifier is the live view's alone. It passes the
  viewer no `detections` and a `null` `sensorStates` — the editor shows what a human authored.

---

---

### `editSession.ts`

The editing rules for one archive, in a plain class with no DOM, so the rules are tested in
`tests/editSession.test.ts` without mounting the editor. `rr-app` creates one `EditSession` per
archive on New and Open and passes it to `rr-editor-view`. See ADR 0017.

It holds the archive, its `EditHistory`, the image on screen (by filename), the tool, the chain in
progress, and the open drag. **Every write goes through `history`**, and each write picks its own
history target. `subscribe(listener)` calls the listener after every change; after an undo or redo
it gets the objects the entry changed.

| Member | Description |
|---|---|
| `archive`, `history` | The archive and its undo stack |
| `image`, `imageIndex`, `tool`, `calibrated`, `chain` | What is on screen, the tool, whether DPT resolves, and the chain in progress as a `ChainView`: the dot its next segment starts from, and a track chain's line and trace |
| `car(id)`, `sensor(id)` | The car on the image on screen, or the sensor, with this id; undefined once it is gone |
| `selectTool`, `selectImage`, `endChain` | Changes to the editing state, none of them recorded |
| `tracks` | The layout's tracks ([#284]) |
| `refusal` | Why the last click or edit under the track tool was refused, a `Refusal`, or null; the hint says so until the next click or edit ([#313]) |
| `previewCar(point)` | Where a click would put the next car of a live car chain: the nearest track, or null when none is near |
| `previewTrack(point, scale)`, `hoverTrack(point, scale)` | What follows the pointer under the track tool ([#324]): the next gap a click would add to the traced line (`TrackChain.preview`), and with no chain live the end dot or insert a click would act on (`trackHover`). Each null otherwise |
| `heldLine` | The line a drag of one of its clicks, or an insert into it, is changing, or null ([#324]) |
| `click(point, scale)` | Writes, or returns what the editor must ask for: a reference point's world position, a sensor's fields, or a notice. Under the track tool with no chain live, a click within the grab radius of the click before it, which inserted a click or said what to do, with the tracks unchanged since, is the second click of a double-click: it writes and says nothing ([#324]) |
| `doubleClick(point, scale)` | After the two clicks of a double-click: on the click a live track chain goes on from, the next gap is to be straight (`TrackChain.straighten`, [#320]). Otherwise nothing |
| `beginDrag(point, scale)` | A `Drag` (`move`, `end`, `cancel`) on what is under the point, or null. Under the track tool a click comes first, then a press within the start distance of a line, which inserts a click and drags it ([#321]); the line is built again on every move, keeps its last valid shape where the rule refuses, and on `end` is written as one entry, or the click springs back and `refusal` says why. While a track chain is live only a click of its line is grabbed, and the chain takes the move on `end` ([#303]) |
| `rightClick(point, scale)` | Ends a live chain, or returns the `MenuSubject` a menu acts on. Under the track tool a click is `track-click` (Delete click, Delete line) and the rest of a line `track`, with the gap under the pointer and whether it is straight when the line has clicks. While a track chain is live a click of its line other than the one it goes on from is `track-click` and the chain goes on ([#303]) |
| `placeReferencePoint`, `editReferencePoint`, `editSensor`, `delete`, `deleteLine`, `markGap`, `reclassifyCar`, `setComplete` | The answers to a dialog, a menu row or the checkbox. `editSensor(id, { id, name })` writes a sensor's **both** fields as one entry, and writes nothing when `sensorId.ts` refuses the new id ([#335]). `deleteLine` takes a `track-click` subject and deletes its line; `markGap(subject, straight)` makes a `track` subject's gap straight or free. A `delete` or `markGap` the rule refuses writes nothing and sets `refusal` |
| `editLayout`, `setCameraHeight` | The settings dialog's edits, one `layout` entry each |
| `addImage`, `deleteImage`, `reorderImages` | The image list. Deleting the image on screen shows its neighbour. `addImage` may set `camera.resolution` (`SPEC.md` § Images, [#254]) |
| `addImages(images)` | A whole pick (`AddedImage[]`: `filename`, `bytes`, `size?`) as **one** entry, "add images", in the order given, showing the first ([#262]). A `filename` the archive already holds, or an earlier image of the same pick took, is stored under a generated `img_<id>` keeping its extension ([#256]) |
| `requiredImageSize` | The size an added image must be, or null while nothing is positioned and the next image sets `camera.resolution` instead ([#254], [#260]). The editor asks before it adds, and words the refusal |
| `undo`, `redo` | Select the image the entry is on, apply it, and report what changed |
| `subscribe(listener)` | Returns a function that stops it |
| `subscribeNotices(listener)` | Calls the listener with each toast the track tool asks for: a refusal's reason (`refusalText`), or what to do instead of a click that did nothing. Returns a function that stops it ([#324]) |

Points arrive in image pixels with the pointer event's `imagePxPerScreenPx`, which converts the
screen-pixel grab radius. The hit-test scene is the layout's reference points and sensors and the
**current image's** cars, so switching images swaps the cars and leaves the sensors.

* **The active tool, and the gate** ([#31]). The rail calls `selectTool`; the session holds the
  tool and dispatches a click on it. A **placement in progress wins outright** —
  the second click of a car is what completes it. Otherwise a click on **empty image** runs the tool
  (calibration opens the dialog, sensor places a point, car takes an anchor) and a click **on an
  object** edits that object *whatever the tool is*, because the thing under the cursor is less
  ambiguous than the mode: a coordinate for a calibration point, the two fields for a sensor, and **nothing
  at all** for a car end, whose position is the drag's business and whose class is the menu's.
  * The gate reads `needsDpt` in `tools.ts` and is checked after every change, not at the one place a
    point is deleted: **the DPT can also vanish through an undo or a drag**. A gated tool drops back
    to calibration and ends a live chain; placing a second point re-enables it. An
    archive **opens in calibration mode**, and a new archive's session starts on calibration rather
    than inheriting the last tool.
* **Reference points.** A click is hit-tested against the layout's points with
  `DEFAULT_GRAB_RADIUS_SCREEN_PX`. A hit asks the editor for a new world position for that point; a
  miss under the calibration tool asks for one for the clicked pixel, **rounded to a whole pixel** — a
  click has no sub-pixel precision to store. `placeReferencePoint` and `editReferencePoint` write the
  point as **exactly one `history.record` entry targeting `layout`**, labelled "place calibration
  point" or "edit calibration point". Nothing is written until the world position arrives.
* **Dragging** ([#30]). `beginDrag` grabs what is under the press and returns a drag. `move`
  writes the manifest, so the DPT readout follows live; `end` writes **one** entry, **never one per
  motion event**, so a drag across the image is
  one Cmd+Z and not two hundred; a drag returned to its origin records **nothing**, suppressed by
  value comparison in `EditHistory` rather than by trusting that the user meant it.
  * The gesture moves a **list** of handles from `dragHandles`, which is what lets one entry cover
    more than one object: a drag on two coincident car ends moves both, as **one** entry, so a
    coupling survives the edit. The entry's **target follows what was grabbed** — a car end is in
    one image record, a sensor and a calibration point in `layout` — because that is the subtree the
    gesture writes, and mis-declaring it is the one class of bug scoped snapshots admit.
  * `cancel` puts every handle back at its starting pixel and records nothing. A drag outside the
    image still writes: pointer capture is `rr-viewer`'s, and the coordinates are not clamped.
  * A drag writes to the image it began on, and undo and redo are refused while one is open.
  * An edit of a reference point takes the **pixel** as well as the index. Points carry no `id`, so
    if an undo lands while the dialog is open and slides that index onto a different point, the edit
    is dropped rather than applied to whatever now sits there.
* **Right-click, and delete** ([#29]). `rightClick` is state-dependent (`../SPEC.md` § Right-click
  is state-dependent): a live chain **ends** and nothing else happens; otherwise it returns the
  `MenuSubject` a menu acts on, or null over empty image.
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
  * `reclassifyCar` writes the full dotted class as **one `image` entry**.
  * A right-click during a chain ends it and names nothing. The chain's cars stay: each is its
    own committed entry, and only the anchor — which is view state — goes.
  * Delete is **one `history.record` entry targeting `layout`**, and undo restores the point with its
    coordinate intact — an entry is a snapshot, so there is no per-object restore to author. The
    subject is resolved when the menu opens and carries its **pixel** for the same reason an edit
    does: an undo landing while the menu is up can slide the index onto another point, and a subject
    that moved is dropped rather than deleted from underneath the user. **Sensor** and **car**
    subjects need no such guard: each carries an `id`, so the subject names it exactly however the
    list is replaced underneath — the delete is a filter by id, not a splice by position. A car's is
    scoped to its **image** rather than to `layout`, because cars are per image.
* **Sensor authoring** ([#31]). A click with the sensor tool writes `{ id, x, y }` into
  `layout.sensors` as **one `history.record` entry targeting `layout`** — unnamed, which is a
  complete sensor: consumers key on `id`, and `name` is never auto-generated. The `id` is a
  `make_id` snowflake, so it is unique within the layout by construction, and the sensor keeps it
  until a person edits it ([#335]). Sensors carry **no
  provenance**: no model can propose where a human wants an answer.
  * A click on a sensor asks the editor to **edit** it, as does the menu's "Edit sensor…".
    One Save is **one** entry covering both fields, so one Cmd+Z restores both ([#335]). A `name`
    of `null` **removes** the key; a Save that changes neither field records nothing, suppressed by
    `EditHistory`'s value comparison. The sensor is found by `id`, so one deleted while the dialog
    was open is simply gone.
  * **An id the rule refuses writes nothing**, judged by `sensorId.ts` here as well as under the
    dialog's field: the rule has to be true of the archive however the session is driven, not only
    of what the dialog let through. The id the sensor already holds is never refused, so a name
    stays editable on an archive holding an id this rule would refuse — the format still allows any
    non-empty string.
  * An id change makes the entry name **both** ids, since the highlights are a diff of its
    snapshots. The editor resolves them against the manifest as it stands, where exactly one is
    there, so the glow lands on the sensor the undo or redo left behind.
  * Drag and delete reuse the calibration paths unchanged — that is the point of `dragHandles` and of
    the menu knowing nothing about its subject. Both are one `layout` entry.
* **Car authoring** ([#32]). **Two clicks on the visible car ends**, and the straight chord between
  them. Each end lands on the nearest centerline within `SNAP_TRACK_WIDTHS`, and a click with none
  near is refused with `NO_TRACK` ([#284]). The first click takes an **anchor** and writes nothing; the
  second writes `{ id, class: 'stock', provenance: 'human', p0, p1 }` into that image's `labels` as
  **one `history.record` entry targeting `{ kind: 'image', filename }`**. The `id` is a `make_id`
  snowflake from its own node id — label ids and sensor ids are separate namespaces — and
  `proposed_by` is **absent**, which the schema requires on a human label.
  * Width is **derived, never stored**: `rr-viewer` gets `dpt` and draws 2.09 track widths of
    rectangle around the chord. That rectangle is the whole reason calibration gates this tool.
  * The anchor is **view state**: abandoning a chain — right-click, a tool change, an image change,
    a lost DPT, a new archive — writes nothing and records nothing.
  * A click **inside a car already labelled on this image** starts nothing while idle, and returns a
    notice for the editor to show ([#43]) — a refusal that did nothing visibly would read as a broken editor.
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
  * The editor draws a **rubber band** from `anchor` to the pointer, through `rr-viewer`'s
    `pendingCar`. It is what makes a live chain visible, and that visibility is what pays for
    right-click *and* undo meaning something else while one is in progress.
  * A second click on the **anchor's own pixel** writes no car: a span with no length has no axis and
    no two ends to couple. The chain stays where it was.
  * **A live chain takes every undo.** It consumes each one
    — the wall — so the reflexive "wrong place, undo" at the start of a train can never reach back
    into the previous one. Further along it undoes the last car's entry and walks the anchor back to
    where that car began, leaving the chain live one step shorter; at the chain's *start* it clears
    the anchor and drops to idle, touching no history. The anchor steps back **only if that undo
    actually removed the chain's car**: an edit made between two clicks sits on top of the stack, and
    reversing it is nothing to do with the chain.
  * A **coupling renders as one shared handle** and drags as one entry moving every end under it,
    which is what `dragHandles` was shaped for; `rr-viewer` derives the couplings from the cars it
    was handed.
* **Images.** Adding an image selects it; deleting the image on screen shows the one after it, or
  the one before when it was last; a reorder keeps the same image on screen. Each is one `images`
  entry, and a delete passes `retain` so the bytes survive for undo. Any change of image ends a
  live chain.
* **Undo and redo** ([#37]). Undo selects the image the pending entry is on, applies it, and reports
  the objects it changed — `../SPEC.md` § Undo and redo: undo may move the user, it may never change
  something they cannot see. A live chain takes every undo, as above. Redo does the same and ends a
  live chain. Both are refused while a drag is open.
* **Labeling completeness** ([#36]). `setComplete` writes the flag for the image on screen, either
  way, as **one `history.record` entry targeting `{ kind: 'image', filename }`**.
  Marking an image with **zero** cars complete is allowed and warns about nothing — it is an
  all-background sample.
  * `setComplete` is the **only** place the flag is written `true`, and the editor calls it only
    from the checkbox. It means "a
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

---

### `rr-live-view`

Camera stream under the two layers of the occupancy output ([#85]).

| Property | Type |
|---|---|
| `archive` | `R49Archive \| null` |
| `sources` | `LiveSources \| null` |

**Emits:** `rr-frame-add` (`FrameAddDetail`: `{ bytes, frameId }`) when **Freeze** is pressed
([#334]). `rr-app` owns the session and the toasts, so it is what adds the frame; this view holds no
session and says nothing about the outcome.

An occupancy service is handed in as **both** sources at once, by `rr-app`, with `service: true`
([#331]) — see `occupancyService.ts`. That flag, and not the absence of an `archive`, is what makes
it **service mode**: since [#333] the archive bound may be the service's own, and measuring drift
against it would be this page second-guessing the judgement it is only relaying.

* **Frames come from a frame source and results from a result source** ([#330], `liveSources.ts`).
  The loop asks `FrameSource.next()` for a frame and `ResultSource.resultFor()` for that frame's L0
  and L1; `null` sources are the camera (`cameraFrameSource.ts`, which reads the `<video>`
  `rr-viewer` mounted) and the model in this page (`localModelResultSource.ts`). Read **on
  connect**: a different source is a different session. The `null` the frame source gives after
  `stop()` is what ends the loop, and the source's pacing is the loop's — one animation frame per
  frame for the camera.
* **A source may hand over a picture instead of a stream, and may bring its own layout** ([#331]).
  `SourceFrame.src` is shown through `rr-viewer`'s `src` — the source owns the object URL and
  releases it, and nothing reads pixels back out of the viewer — and `ResultSource.layout` gives the
  sensors, the resolution and the DPT the answers are keyed on, read **every frame** so a manifest
  the source re-read reaches the viewer. With a layout the view takes all three from there rather
  than from `archive`, which is why an unsaved edit in the editor cannot move what it draws.
* **A turn with `fresh: false` carried no new picture.** The last one stays on screen, the rate
  drops to **0** rather than going stale, no drift sample is taken from it, and the answers that
  came with it are taken as usual — which is how every sensor reads `unknown` while a service is
  quiet instead of the last good answers freezing. `FrameResult.notice` is the reason, shown as a
  notice and cleared by the next answer; `FrameResult.detections` absent means no L0 was published
  at all (no boxes, no car count), where an empty list means a model looked and found none.
* **Service mode is `sources` set with no `archive`** ([#331]). It shows no drift banner,
  recorder, alignment readout, or model and DPT notices, and no Inference row (drift in service mode
  is [#336]). The camera path, with or without an archive, is as it was. A service's `open()`
  failure is still shown, in its own words.
* **Freeze adds the frame on screen to the archive** ([#334]). In service mode only, beside Details.
  A press reads `FrameSource.shownFrame` — the frame **this view last rendered**, not whatever the
  source holds now, because between the source taking a newer frame and this view drawing it the
  source is ahead of the screen — and sends it up as `rr-frame-add`. The picture does not stop and
  the loop is untouched: freezing a frame is taking a copy of it. The button is **disabled while the
  current answer carried no frame**: before the first one, on a `json`-only answer, and on a failed
  request. The last picture is still up in all three and it is out of date, so adding it would
  record a moment the service has just said it cannot see. Nothing here judges or records the add,
  and the camera path has no Freeze — the editor's Capture from Camera is that path.
* **Details** ([#332]): in service mode a Details button stands where the recorder does in local
  mode. It is closed each time the view opens. While it is open, `rr-service-details` sits below the
  viewer with the last answer's `FrameResult.details`, the viewer draws the layout's tracks as
  centerlines, and the result source is told `setPatches(true)`; closing it sends
  `setPatches(false)`.
* **This is the occupancy contract, not a demo.** The detector runs **once per frame** — not once per
  sensor — and every sensor is derived from its output by pure geometry, which is `../SPEC.md`
  § Occupancy Output: L1 is a function of L0 and never calls a second model, so it cannot contradict
  the boxes drawn beside it and costs the same for three sensors or three hundred. What stood here
  before (the CNN at each sensor point, emitting marker glyphs) was § Testing and Demo, and it is
  gone.
* `detect` is asked to answer in **`camera.resolution`**, the frame sensors and labels are authored
  in — by `localModelResultSource.ts`, which is the only thing in the live path that reads the
  manifest per frame. It also gives `detect` the layout's DPT in the capture's own pixels. The
  resample and the tiles stay inside `@rails49/detector`; nothing here scales a coordinate.
* **The loop runs whether or not a model loaded.** `occupancy()` is total, and with `detections:
  null` it answers every sensor `unknown` / `no-model` — a state SPEC names and the user needs to
  see. Suppressing the loop would leave the previous frame's answers on screen instead.
* Three banners, and each says what it costs: **no model** (every sensor `unknown`, with the command
  that builds one), **no calibration** (every sensor `unknown` and no cars detected, because
  `detect` needs the DPT), and **drift** (below). The calibration one is resolved when the archive arrives
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
* **"Record drift"** ([#217], `driftRecording.ts`) appends one row per drift sample while on, and
  turning it off downloads them as `drift-YYYYMMDD-HHMMSS.csv`: `time` (ISO 8601), `px`,
  `tolerance_px`, `dpt`, `past`, `overridden`, `stream_width`, `stream_height` (the frame source's
  `settings`, which is the camera track's `getSettings()`). The verdict cells are empty on an
  uncalibrated layout. Recording continues while refusing. Leaving the live view mid-recording
  downloads the rows recorded so far.
* Stops the frame source and closes the result source on disconnect — which releases the detector
  session and the camera tracks, or aborts a service's request in flight and closes its event
  stream — and the drift check is dropped with it, which is also what keeps an in-flight sample from
  writing into a detached view.

---

### `rr-diagnostics-view`

The shipped detector run over an opened archive, read against the labels a human authored ([#87]).

| Property | Type |
|---|---|
| `archive` | `R49Archive \| null` |

* **This is the first thing that measures the artifact that ships.** Nothing else scores the
  quantized model this app loads against labels; how it is trained and quantized is
  rails49/detector's. What this reports is **agreement between one model and one archive's labels**
  — not accuracy, and not a generalization estimate, which rails49/detector's `SPEC.md` § Accuracy makes a property
  of a held-out protocol over a corpus that does not exist yet.
* Sweeps images **sequentially**: one ORT session and one WASM heap, so concurrent `detect` calls
  would queue inside the session anyway while making the progress count meaningless and holding
  every decoded bitmap in memory at once.
* Starts the report at `@rails49/detector`'s `CONFIDENCE_THRESHOLD`, the default `detect` applies
  in the live view, so an untouched report describes what ships.
* Runs inference at a confidence floor **far below** `CONFIDENCE_THRESHOLD` and filters
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
| `cars` | `number \| null` | **L0**: detections above the confidence threshold in this frame. `null` where no L0 was published at all, and the row is then not rendered |
| `occupied` | `number` | **L1**: how many sensors read `occupied` |
| `inference` | `number \| null` | Milliseconds in `detect` — preprocessing, session, decode. Not the whole frame: L1 is pure geometry, and folding it in would attribute the render to the model. `null` where this page ran no model, and the row is then not rendered |
| `l0Age` | `number \| null` | How far behind the picture on screen the L0 drawn over it is, in milliseconds ([#331]). `null` where there is no L0 to be behind, and the row is then not rendered |
| `alignment` | `number \| null` | Estimated camera misalignment in `camera.resolution` pixels, or `null` before the first sample |
| `alignmentTolerance` | `number \| null` | What that is judged against — `maxDriftPx(dpt)`. `null` when no DPT resolves, and the row is then not rendered at all |

Both counts are shown because the pair is the readout: cars with no occupied sensor is either an
empty siding or a sensor in the wrong place, and one number cannot say which.

**`cars`, `inference` and `l0Age` are absent, not zero, when nobody measured them** ([#331]). A
service that publishes no L0 has no car count and no detector of this page's to time, and a row
reading `0` would claim a frame was inferred and held no cars — the same confident-looking miss
`clear` refuses to make. An empty detection list is a different fact and still reads `0`. The L0 age
is the readout that says whether a box sitting off a car is a bad box or an old one: a service
infers on its own cadence and may draw the newest L0 it has over a newer frame, and both times are
the service's clock.

**The alignment row is an instrument, and that is why it is here rather than in a banner.** The live
view's refusal banner is an *event*; alignment is a continuous measurement, and someone aiming a camera
needs to watch it move — a number that only appeared once it was already too large would leave them
adjusting a mount blind, and "how much margin is left" is exactly what the banner cannot say. It shows
measurement against tolerance rather than a red/green dot, because the ratio is what is being judged.
`null` renders as `—`, never `0.0`: "not measured yet" and "measured, and the camera has not moved" are
different facts, and this is the one readout where a zero is a claim. Past the tolerance the row turns
amber, not red — the refusal banner is already red and carries the button that acts on it.

---

### `rr-service-details`

What an occupancy service sent beyond L1, below the live view's viewer while Details is open
([#332]).

| Property | Type | Description |
|---|---|---|
| `details` | `ServiceDetails \| null` | The last answer's optional fields, with each patch as an object URL. `null` after a failed answer |
| `sensors` | `readonly Sensor[]` | The held manifest's sensors, in order: one row each |
| `states` | `ReadonlyMap<string, SensorState>` | L1, for the State column |
| `rate` | `number` | Frames per second the page gets |

**Emits:** nothing.

* Above the table, as far as the service sent them: camera state, the page's rate and the
  service's, time per stage, frame age, L0 age, threshold and drift (the reading against its
  tolerance, or why it is unmeasured). The page's rate is always shown.
* Columns: Sensor (id, and the name when it has one) and State always; Patch, Score, Changes and
  Last messages only when the service sent `patches`, `scores`, `changes` and `last_messages`. A
  sensor with no entry has an empty cell.
* State is `sensorMarker.ts`'s `stateText`, the marker's tooltip wording, so a clear sensor's score
  shows only in Score.
* A message's time is shown in local time, or as sent where it does not parse. It is never
  compared with the page's clock.
* It scrolls on its own, and the live view gives it `contain: inline-size` so its table cannot
  widen the view.

---

### `liveContract.ts`

The live contract an occupancy service answers, read in one place ([#331], [#333]). The contract is
`occupancy-service`'s, stated in its `LIVE.md`; this is the only file here that names a path, a part,
a field, a method or a header of it.

| Export | Description |
|---|---|
| `LIVE_BASE` | `'/live'`, on the page's own origin. One constant, not a setting |
| `LIVE_VERSION`, `LATEST_TIMEOUT_MS` | The one contract version this reads, and how long a `latest` may take |
| `manifestUrl`, `latestUrl`, `eventsUrl` | The three paths. `latestUrl(base, after)` sends the previous `frame_id` back **unchanged** |
| `MANIFEST_NAME`, `archiveFileUrl(base, name)` | One file of the service's archive, each path segment percent-encoded ([#333]) |
| `archiveBase(base)` | The archive's base, **absolute**, which is what `R49Archive.load` takes ([#333]) |
| `readEtag(response)` | The `ETag` an answer carries, or `null` |
| `putArchiveFile`, `deleteArchiveFile` | `PUT` and `DELETE` one file, with `If-Match` ([#333]) |
| `SAVE_STALE`, `SAVE_REFUSED`, `saveRefusalRule(response)` | 412 and 422, and the rule a refusal states in its `error` |
| `findService(base?)` | The service check: the manifest `Response` where this origin serves a service, else `null` |
| `readLatest(response)` | One answer: `{ payload, frame, details }`, with `frame` `null` for an answer with only the `json` part. Throws `LiveError` |
| `parsePayload(data)`, `l0AgeMs(payload)` | The JSON part validated field by field, and the L0 age in the service's own clock |
| `LivePayload`, `LiveSensorState`, `LiveL0`, `LiveAnswer`, `LiveError` | The wire's shapes |
| `LiveDetails`, `LiveTimings`, `LiveCamera`, `LiveDrift`, `LiveMessage` | The optional fields ([#332]) |

**`details` holds each optional field the answer sent in the right shape.** A field of the wrong
shape is left out and logged with `console.warn`; L1 and the frame stand. `details.patches` maps a
sensor id to the part `patches` names for it, because a part name cannot carry any sensor id. A
sensor with no entry, or whose entry names a missing part, has no patch. `latestUrl(base, after,
patches)` adds `patches=1`.

**`findService` returns the answer, not a boolean**, so the version in its `ETag` is read before the
archive is loaded ([#333]). **Only a JSON content type counts**: the cloud copy of this page answers
every unknown path with 200 `text/html`, so `response.ok` alone would find a service on a static
host. Any other answer, and any network failure, is "no service", with no toast.

**A write carries a `Blob` body** so the request has a `Content-Length`: a service following
`LIVE.md` answers 411 without one. Each path segment is percent-encoded, so an image named with a
space or a `#` addresses the file it names.

**`readLatest` uses `response.formData()`.** The browser already has a multipart parser; the
hand-rolled one in rails49/control#950 exists only because WebKit refused that type there, and if
`formData()` turns out to fail on a real iPhone ([#331]'s human step) this function is the one place
that changes. It throws rather than returning a partial answer, and the caller turns the throw into
`unknown` for every sensor.

---

### `occupancyService.ts`

An occupancy service as the live view's source — both halves of it ([#331]).

| Export | Description |
|---|---|
| `occupancyService(base?)` | One object that is the `FrameSource` **and** the `ResultSource`, for the service at `base` |

**One object, because the service answers a frame and that frame's L1 together.** Two sources would
mean two requests for one answer, and L1 that could belong to a different frame than the picture
under it. `rr-app` hands it to `rr-live-view` as both.

**It never rejects.** A request that failed, a body that will not parse, a version it does not read —
each becomes one answer in which every sensor reads `unknown` (`no-service`) under the notice "Cannot
reach the occupancy service", the picture on screen stays (`fresh: false`), and it asks again after
about a second. An answer with no frame keeps the picture too, under the notice "No picture from the
camera", with each sensor `unknown` and the service's reason as its `serviceReason`. A source that rejected would leave the last good answers frozen under a live-looking
screen, which is what [#341] named.

**A frame is new when its id *differs* from the last, not when it is greater.** The id is the
service's token, sent back as `after` unchanged; a service that restarted and numbered from scratch
recovers on its next answer. An answer repeating the id is not a frame and it asks again. `next()`
resolves only once the frame has **decoded**, so asks cannot outrun a slow device, and each object
URL is released when the next frame replaces it on screen and on leaving.

**`shownFrame` is the frame on screen, for Freeze** ([#334]): its `frame_id` and the part's bytes as
a `Blob`, held beside the object URL and replaced at the moment that URL is, so what Freeze adds is
the picture the person is looking at and never a newer answer still decoding. The bytes are held
rather than read back out of the URL — a revoked URL reads nothing, and fetching it would be a
second read of a frame this object already has. It is **`null`** where the current answer carried no
frame: before the first one, on a `json`-only answer, on a failed request, and after `close()`. The
picture stays on screen in those cases, which is why the frame on offer and the picture are not the
same question.

**The manifest is the service's.** Read from `<base>/archive/manifest.json` at `open()` and validated
by `R49Archive.setManifest`, it is what `ResultSource.layout` reports and therefore what the view
draws — so an unsaved edit in the editor cannot move it. One `<base>/events` connection is held and
**no L1 is read from it**: L1 on screen comes only from `latest`, so it always belongs to the frame
shown. Every connect after the first re-reads the manifest, because occupancy-service#7 drops every
event client after a save; a failed re-read keeps the held manifest. A connection that closed for
good — which a non-200 answer does, and `EventSource` does not retry — is reopened after a few
seconds.

**It loads no detector and measures no drift.** The service publishes states this page cannot
withhold, and drift in service mode is [#336].

**Details** ([#332]). `setPatches(on)` asks for `patches=1` from the next request on. Each result
carries `details`, the answer's optional fields with each patch as an object URL, and a failed
answer carries none. The patch URLs are released when the next answer arrives and on leaving. The
layout also holds the manifest's `tracks`.

---

### `serviceArchive.ts`

How an archive opened from an occupancy service is saved back to it ([#333]).

| Export | Description |
|---|---|
| `ServiceWriter` | `@rails49/r49`'s `ArchiveWriter` over the contract's requests. `etag` is the version the next request holds |
| `saveToService(archive, base, etag)` | One save: `archive.writeChanges` through a fresh `ServiceWriter`. Resolves `ServiceWrite` |
| `ServiceWrite` | `{ kind: 'wrote', etag }` or `{ kind: 'refused', message }` |

**The archive and the save are the format's, not this package's** (org ADR-0022). `R49Archive.load`
takes the service's base URL, `getImage` fetches an image as it is needed, `export()` fetches
whatever is still unread, and `writeChanges` puts the added images, then `manifest.json`, then
deletes each name the base held that the manifest no longer names — taking the manifest as it stood
when it was called, so an edit made during a save is the next save's. What is left here is the one
thing the format cannot state: how *this* page reaches a service.

* **`put` is `PUT <base>/archive/<name>` and `remove` is `DELETE`**, with each path segment
  percent-encoded and `If-Match` holding the version. The body is a `Blob` so the request carries a
  `Content-Length`, which a service following `LIVE.md` answers 411 without.
* **The manifest's answer replaces the version held**, so the deletes after it and the next save
  hold the new one. An answer carrying no `ETag` is followed by a read of the manifest, because
  holding the version from before the write would refuse every `DELETE` after it and the next save
  too, reporting a copy somebody else changed when nobody did.
* **A refused `put` ends the pass**, and comes back as `refused` rather than as a failure: 412 says
  the copy changed and names Save As, 422 quotes the answer's `error`, any other status is named.
  The files the pass did not reach stay unwritten and the next save carries them.
* **A failed `DELETE` is logged and resolves**, so the save stands and the deletes after it still
  run. The file stays on the service as an orphan, which occupancy-service#7 accepts, and r49
  forgets the name — the orphan is never retried. What the archive *is* is what the manifest names,
  and the manifest is already written by then.
* **A network failure rejects**, which the caller reports as a failed save.

`docs/UI.md` § An image is read when it is needed has what each caller does with a rejected
`getImage`, and § Saving is three routes has where a save goes.

---

### `tools.ts`

The editor's tools, in one list that drives both the rail's buttons and the session's gate.

| Export | Description |
|---|---|
| `EditorTool` | `'calibration' \| 'sensor' \| 'car' \| 'track'` |
| `TOOLS` | Each tool's icon, label and `needsDpt` |
| `GATE_REASON` | The disabled tools' tooltip while DPT is unresolved |

---

### `matte.ts`

The one colour a work pane may state outright ([#151]).

| Export | Description |
|---|---|
| `matteTokens` | `CSSResult`. Declares `--photo-matte` on `:host`. **Include it first** in the `static styles` of the components that mat a photograph — `rr-viewer`, `rr-thumbnail-bar`, `rr-diagnostics-report` |

The panes follow the theme and `tests/theme.test.ts` asserts that no pane module carries a hex
literal at all; this is the black that survives it, and it is a token so a reader can tell a
considered black from one that was never converted. It sits **behind a photograph or a video
frame**, and black is what a photograph is matted against under either preference.

`rr-viewer` is the one component that test does not scan, for the same reason: the matte behind the
photograph and the zoom band over it are the whole of what it draws, so it has no pane surface, and
its two colours are judged the way a marker ink is. See `ui/CLAUDE.md` § Shoelace for the rest.

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

### `imageAdd.ts`

The three steps every image add takes — prepare, judge, record — shared by the ways in ([#255],
[#260], [#334]).

| Export | Description |
|---|---|
| `captureFilename()` | `capture_<id>.jpg`, the name a captured or frozen frame is stored under |
| `portraitRefusal(name, size)` | Why a portrait image was not added, naming the file and its shape |
| `sizeRefusal(name, size, required)` | Why an image of another size was not added, naming both sizes |
| `addPrepared(session, filename, name, picked)` | One image: prepare, judge, `session.addImage` — the notice, or null |
| `addPickedFiles(session, files)` | A whole pick as one history entry, in filename order — one notice, or null |

It was private to `rr-editor-view` while the editor was the only way in. Capture from Camera, the
file picker and Live's **Freeze** ([#334]) now all come through here, so there is one set of
refusals to keep in step rather than two. `prepareImage` and `addRefusal` stay internal: a caller
that judged without recording, or recorded without preparing, is the bug this module exists to
prevent. Nothing here owns a toast — each function **returns** the notice and the component that was
pressed shows it, which is why the message names what the user chose and the session never sees it.

---

### `persistence.ts`

Where a session's work goes when it is saved, and the three ways of putting it there ([#48],
[#333]).

| Export | Description |
|---|---|
| `FileBinding` | `{ stem, handle?, service? }` — where this session writes back to. **A service means Save writes to the occupancy service; a handle means Save overwrites that file; neither means Save downloads a new generation.** |
| `ServiceBinding` | `{ base, etag }` — the archive on an occupancy service. `etag` `null` is a read-only copy ([#333]) |
| `SaveOutcome` | `{ kind: 'wrote' \| 'downloaded', binding, filename }`, `{ kind: 'served', binding }`, `{ kind: 'refused', binding, message }` or `{ kind: 'cancelled' }` |
| `OpenedArchive` | `{ file, binding }` |
| `READ_ONLY_NOTICE` | What a read-only service binding is told when Save goes to a file instead |
| `supportsFileSystemAccess()` | Whether a file can be written back in place |
| `fileStem(filename)` | `west-yard.r49` → `west-yard` |
| `timestampedName(stem, date?)` | `west-yard-20260802-1432.r49` — the download path's filename |
| `openArchive()` | Picker where one exists, file input everywhere else; `null` on dismissal |
| `writeArchive(archive, binding, { rebind?, notice? })` | Writes, and reports which way |

A browser cannot write to a file handed to it through `<input type="file">`. Only the File System
Access API yields a writable handle, and that API is **Chromium desktop only** — not Firefox, not
Safari, and on no phone at all. Since `ui/CLAUDE.md` supports all three engines equally and the
labeling device is a phone, write-back is an enhancement over a download path that **stays
permanently**, never a replacement for it. This module exists so that split lives in one place.

It takes the **archive**, not its bytes: the service route writes the files that changed and never
an archive, so a save there costs no export — and an archive on a service would otherwise fetch
every unread image for it. The file routes export **before the picker opens and before the first
write**, because an export that fails has to fail before a file has been named: otherwise a picker
save would leave an empty `.r49` at that name, and truncate whatever was there.

`writeArchive` takes five routes, in order:

0. A **service binding with an `ETag`**, `rebind` false — the changed files, the manifest and the
   deletes go to the service ([`serviceArchive.ts`](#servicearchivets)). No handle is involved, so
   this is the one write-back route that runs on a phone. A refusal comes back as `refused` and
   leaves the binding and the history marker alone; a network failure throws, as a failed file
   write does.
1. A service binding with **no `ETag`** — the service serves the archive read-only. `notice` is
   told `READ_ONLY_NOTICE`, before the picker opens, and the save takes a route below.
2. A bound handle, `rebind` false — **overwrite it, silently**. `createWritable` stages into a swap
   file and commits on `close()`, so an interrupted write cannot truncate the original. That
   atomicity is the whole safety net, by decision: no `.bak`, and no verification read, because
   re-parsing every image on every save costs more than the failure it would guard.
3. A bound handle whose write permission is **refused** — falls through to (5) rather than failing.
   A denied prompt must not cost the user a save, and a second dialog would be asking twice.
4. No handle (or `rebind`), API present — the **picker**, suggesting the binding's *plain* stem.
   Dismissal returns `cancelled`; the old binding stands. A picker save **moves a service binding
   to the file**: the binding returned carries the handle and no service.
5. No API — a **timestamped download**, returning the binding unchanged. A download binds nothing,
   so the next save asks the same question again and a service binding stays one.

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

The editor's undo stack. A plain module, not an element: each `EditSession` owns one. It is deliberately **not** part of `@rails49/r49`, which is a parser/serializer — an edit
history is an editing-session concept, coupled here to view state that means nothing to the training
exporter.

| Export | Description |
|---|---|
| `EditHistory` | `attach`, `record`, `beginGesture`, `undo`, `redo`, `markSaved(position?)`; `position`/`canUndo`/`canRedo`/`undoEntry`/`redoEntry`/`undoLabel`/`redoLabel`/`isDirty`/`size`/`bytes` |
| `HistoryTarget` | `{ kind: 'layout' }`, `{ kind: 'image', filename }`, or `{ kind: 'images' }` |
| `HistoryEntry` | What `undo`/`redo` return, so the caller can reveal what changed. Carries `highlights` |
| `HistoryHighlight` | One object an entry changed: `{ kind: 'car' \| 'sensor', id }` or `{ kind: 'calibration', px }` |
| `changedObjects(target, before, after)` | The diff behind `highlights`. Pure, and exported for its own tests |
| `revealTarget(entry)` | The image an entry must bring into view before it lands, or `undefined`. `EditSession` reads it before an undo or redo. Takes `null` too, since it is asked of a *pending* entry |
| `HistoryGesture` | An open gesture. One method, `commit()`, returning whether an entry was recorded |
| `DEFAULT_HISTORY_BUDGET_BYTES` | 256 MB. A UI constant — nothing outside `ui/` can read it |

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
archive is replaced — every caller owes it an ending. `rr-editor-view` ends a drag on a repeated
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
