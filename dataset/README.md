# Occupancy Dataset Preparation

Tools for deriving training data from `.r49` railroad layout archives. One
runs — the **detector** export. The two **classifier** scripts are parked and
exit non-zero; the reasons are below and they are not defects to fix.

## Scripts

### `pnpm run export:yolo` — the detector dataset

Derives the Ultralytics OBB layout directly from a directory of archives, with
no intermediate database:

```bash
pnpm --filter dataset run export:yolo -- --in ../../r49/fixtures --out yolo
```

`--in` defaults to `r49` and is scanned recursively; `--out` defaults to `yolo`
and is **replaced wholesale** on every run (it refuses to delete a directory
that holds no `data.yaml`, so a mistyped `--out` cannot eat your home
directory). Both are gitignored. Point `--in` at a checkout of
[`rails49/r49`](https://github.com/rails49/r49); the labels live there, not here.

```
yolo/
  data.yaml                                 path/train/val + the class names
  images/{train,val}/<archive>__<image>.jpeg
  labels/{train,val}/<archive>__<image>.txt  class + 8 normalized corners
```

The rules it applies are `SPEC.md` § YOLO annotations:

* **`labeled_complete` is the one hard gate.** An image a human has not vouched
  for is skipped whole — one unlabeled car in an exported frame teaches the
  detector that cars are background, and that loss is shared across the image
  so it cannot be scoped away per class. A complete image with *no* cars is
  legitimate and exports an empty label file: it is an all-background sample.
* **Everything else that could drop a car is fatal**, never a silent skip: a
  class no entry of `detector.classes` prefixes, an uncalibrated archive (no
  DPT means no derivable width), a zero-length span, a missing image.
* **Width is derived, not stored** — `DPT × standard_width / standard_gauge`.
  The scale ratio cancels, so a car is 2.09 track-widths wide in every scale.
* **The split is by image and by hash**, so re-exporting reshuffles nothing and
  two cars in one frame cannot land on opposite sides. Ratio:
  `detector.val_split`.
* Corners are **clamped** into `[0, 1]`; Ultralytics rejects a label file
  carrying one outside, and a clamped box beats no box. The run reports how
  many moved.

`src/yolo_rules.ts` holds the arithmetic with no filesystem in it, and is where the
tests point. The car box itself is not there: `carWidthPx` and `spanToPolygon`
are `@occupancy/detector`'s, so that the width constant has one home and the UI
can draw ground truth beside detections without importing `node:crypto`.

### `pnpm run prep` — ⚠️ PARKED (exits non-zero)

It scanned a local `r49/` directory for archives and cut one 144×144 crop per point marker, tagged
by the marker's type, split deterministically 80/20 by a hash of archive, image
and marker id.

v4 stores no point markers. A label is a **car** — a two-point span along the
car's centerline — and a **sensor** is a per-layout query point, not a tagged
sample. Deriving crops from car spans alone puts every crop centre on a car, so
every crop earns the same tag: the vocabulary does not shrink from three tags to
two, it collapses to **one, degenerate, with no negatives at all**. That is why
`classifier.labels` was deleted from `config.yaml` rather than corrected.

**The route back** is sampling background crops as *verified* negatives.
`labeled_complete` asserts that no car in an image is unlabeled, which makes any
crop centre intersecting no span a verified negative rather than a presumed one.
That changes the negative distribution and so invalidates any gate built on the
old one — it is an experiment to run, not a schema question to answer, and it
stays dormant while the ResNet does.

**Do not revive this by inventing a substitute vocabulary or synthesising
negatives.** See `SPEC.md` § v4 cannot produce a trainable CNN dataset
(issues #8, #18).

### `pnpm run online-diagnostics` — ⚠️ PARKED (exits non-zero)

It re-classified every marker with the exported model and printed a confusion
matrix. Same cause: no markers, no per-marker ground-truth tag.

It also measured nothing generalizable, having scored the same archives the
model trained on. A replacement belongs to the held-out accuracy protocol that
does not yet exist (`SPEC.md` § Accuracy).

## Directory Structure

There are no `.r49` archives here any more (#63). The corpus is
[`rails49/r49`](https://github.com/rails49/r49), which takes submissions by pull
request under CC BY 4.0. The six this directory used to hold are in that repo's
`fixtures/` tree — **fixtures, not training data**, sitting below
`layout.min_dpt`, so no number derived from them predicts model accuracy.
Training reads the corpus from a local checkout of it, passed as `--in`.

*   `yolo/`: The generated detector dataset (gitignored; `export:yolo` writes
    it). `data.yaml` names an absolute path, so it is machine-specific by
    construction — regenerate rather than copy it.
*   `r49/`: The default `--in`, if you keep a corpus checkout here (gitignored).
*   `data/`: The generated CNN crop database (gitignored; nothing generates it
    today).
*   `src/yolo_export.ts`, `src/yolo_rules.ts`: the detector export and its arithmetic
    (the car box is `@occupancy/detector`'s).
*   `src/data_prep.ts`, `src/online_diagnostics.ts`: parked stubs carrying the
    reasoning above.
