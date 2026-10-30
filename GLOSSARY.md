# occupancy

Camera-based track occupancy detection for model railroads: photographs of a layout are labeled, a detector is trained on them in [rails49/detector](https://github.com/rails49/detector), and the live view reports occupancy at points the author chose.

## Language

### Layout and archive

**Layout**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Archive**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Format**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Outside reader**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Corpus**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Corpus rule**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Reader requirement**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Fixture**:
One of the six archives kept to exercise the code. See [docs/SYSTEM.md](docs/SYSTEM.md#the-pipeline).

**Image**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Scale**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Prototype**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

### Calibration

**DPT**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Minimum DPT**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Recommended DPT**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Calibration**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Reference point**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Camera height**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Reference height**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Residual**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

### Drift

**Pose**:
The camera position the images of an archive share. See [ADR 0020](docs/adr/0020-only-the-live-view-measures-drift.md).

**Reference image**:
The first image in an archive, whose pose drift is measured against. See [ADR 0020](docs/adr/0020-only-the-live-view-measures-drift.md).

**Drift**:
How far the camera has moved from the pose, measured in pixels of the reference image. See [SPEC § Image Alignment](SPEC.md#image-alignment).
_Avoid_: misalignment

**Drift tolerance**:
The largest drift accepted, as a fraction of a track width. See [ADR 0020](docs/adr/0020-only-the-live-view-measures-drift.md).

### Cars and labels

**Car**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Span**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Car width**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Standard width**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Train**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Coupling**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Class**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Stock**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Vocabulary**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Labeled complete**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Provenance**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Proposal**:
A car label suggested by the detector for a person to accept, correct or reject. See [SPEC § Assisted Labeling](SPEC.md#assisted-labeling).

**Track**:
The rails cars run on.
_Avoid_: using it for a sensor or a block

**Centerline**:
The line along the middle of a track, drawn once per archive and shared by all its images.

### Occupancy

**Sensor**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Detector**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Classifier**:
The model that judges whether a car covers a sensor, from the patch at that sensor.
_Avoid_: point detector

**Patch**:
The rectangle of image the classifier judges: centered on a sensor and turned to the direction of the track under it.
_Avoid_: crop

**Detection**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**L0**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**L1**:
Each sensor's state, from the detector's L0, the classifier, or both. With both, a sensor is occupied if either says so. See [ADR 0005](docs/adr/0005-l1-is-geometry-over-l0-biased-toward-occupied.md).

**Occupied**:
An L1 state: a car on the sensor's track comes within the margin of the sensor, as a detection or the classifier reports it. See [SPEC § The occupancy test](SPEC.md#the-occupancy-test).

**Clear**:
An L1 state: no car on the sensor's track comes within the margin of the sensor. See [SPEC § Confidence](SPEC.md#confidence).

**Margin**:
How far beyond a car's end, along the track, a sensor still reads occupied: two gauges.

**Unknown**:
An L1 state: the system could not look, because no model is loaded, DPT is unresolved, the sensor is outside the frame, the classifier finds no centerline under the sensor, or the camera has drifted. Not a confidence outcome. See [SPEC § The vocabulary](SPEC.md#the-vocabulary).

**Phantom**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Miss**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).
