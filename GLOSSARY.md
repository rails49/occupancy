# occupancy

Camera-based track occupancy detection for model railroads: photographs of a layout are labeled, a detector is trained on them, and the live view reports occupancy at points the author chose.

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
The DPT below which images are too coarse for this project's detector to train on. A reader requirement. See [SPEC § Calibration](SPEC.md#establishes-the-relation-between-image-pixels-and-physical-dimensions).

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
The camera position the images of an archive share. See [ADR 0013](docs/adr/0013-drift-is-measured-against-the-first-image.md).

**Reference image**:
The first image in an archive, whose pose drift is measured against. See [ADR 0013](docs/adr/0013-drift-is-measured-against-the-first-image.md).

**Drift**:
How far the camera has moved from the pose, measured in pixels of the reference image. See [SPEC § Image Alignment](SPEC.md#image-alignment).
_Avoid_: misalignment

**Drift tolerance**:
The largest drift accepted, as a fraction of a track width. See [ADR 0013](docs/adr/0013-drift-is-measured-against-the-first-image.md).

### Cars and labels

**Car**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Span**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Car width**:
The width every car is drawn with, derived from DPT and the standard width. Never stored. See [SPEC § Location Data](SPEC.md#location-data-cars-and-sensors).

**Standard width**:
The prototype width used for every car: the widest real stock. See [SPEC § Location Data](SPEC.md#location-data-cars-and-sensors).

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
The rails cars run on. Nothing stores it. See [ADR 0010](docs/adr/0010-track-is-not-stored.md).
_Avoid_: using it for a sensor or a block

### Occupancy

**Sensor**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Detector**:
The model that finds cars in a frame: an oriented-box YOLO network. See [SPEC § The detector](SPEC.md#the-detector-is-yolo26n-obb).
_Avoid_: sensor, classifier

**Classifier**:
The CNN that judges occupancy at a single point. See [ADR 0004](docs/adr/0004-one-model-in-the-live-path.md).

**Detection**:
One car the detector found: an oriented box, a class and a confidence. See [SPEC § Output encoding](SPEC.md#output-encoding).

**L0**:
Every detection in a frame, as the detector emitted it. See [SPEC § Occupancy Output](SPEC.md#occupancy-output).

**L1**:
Each sensor's state, computed from L0 alone. See [ADR 0005](docs/adr/0005-l1-is-geometry-over-l0-biased-toward-occupied.md).

**Occupied**:
An L1 state: some detection's box contains the sensor. See [SPEC § The occupancy test](SPEC.md#the-occupancy-test).

**Clear**:
An L1 state: no detection's box contains the sensor. See [SPEC § Confidence](SPEC.md#confidence).

**Unknown**:
An L1 state: the system could not look, because no model is loaded, DPT is unresolved, the sensor is outside the frame, or the camera has drifted. Not a confidence outcome. See [SPEC § The vocabulary](SPEC.md#the-vocabulary).

**Phantom**:
A detection where there is no car. See [SPEC § Accuracy](SPEC.md#accuracy).

**Miss**:
A car with no detection. See [SPEC § Accuracy](SPEC.md#accuracy).

**Canvas**:
The fixed square every detector input is padded onto, at a constant DPT. See [ADR 0014](docs/adr/0014-dpt-normalized-input-padded-never-resized.md).

**Tile**:
A canvas-sized piece of a capture larger than the canvas. See [ADR 0014](docs/adr/0014-dpt-normalized-input-padded-never-resized.md).
