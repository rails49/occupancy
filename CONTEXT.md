# occupancy

Camera-based track occupancy detection for model railroads: photographs of a layout are labeled, a detector is trained on them, and the live view reports occupancy at points the author chose.

## Language

### Layout and archive

**Layout**:
A model railroad as seen by one fixed overhead camera. See [SPEC § Assumption](SPEC.md#assumption).
_Avoid_: scene

**Archive**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Format**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Outside reader**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Corpus**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Corpus rule**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Reader requirement**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Fixture**:
One of the six archives kept to exercise the code. See [docs/SYSTEM.md](docs/SYSTEM.md#the-pipeline).

**Image**:
One photograph of the layout in an archive. See [SPEC § Images](SPEC.md#images).
_Avoid_: frame (for a stored image; a frame is one picture from the live camera)

**Scale**:
The modelling scale of a layout (HO, N, Z, ...), which fixes its ratio to the prototype. See [SPEC § Calibration](SPEC.md#establishes-the-relation-scale-to-the-prototype).

**Prototype**:
The real railway a model represents. See [SPEC § Calibration](SPEC.md#establishes-the-relation-scale-to-the-prototype).

### Calibration

**DPT**:
Dots per track: image pixels per track gauge, measured on the reference plane. See [SPEC § Calibration](SPEC.md#establishes-the-relation-between-image-pixels-and-physical-dimensions).
_Avoid_: px/mm, resolution

**Minimum DPT**:
The DPT below which images are too coarse for this project's detector to train on. A reader requirement. See [SPEC § Calibration](SPEC.md#establishes-the-relation-between-image-pixels-and-physical-dimensions).

**Recommended DPT**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Calibration**:
The reference points that fix a layout's DPT. See [SPEC § Calibration](SPEC.md#calibration).

**Reference point**:
A point given both as an image position and as a layout position in millimetres. See [SPEC § Reference points](SPEC.md#reference-points).
_Avoid_: control point, calibration marker

**Camera height**:
The distance from layout zero up to the camera. See [ADR 0015](docs/adr/0015-camera-height-corrects-scale.md).

**Reference height**:
The height of the railhead above layout zero; the plane DPT is reported on. See [ADR 0015](docs/adr/0015-camera-height-corrects-scale.md).

**Residual**:
How far the reference points disagree with the fitted scale, in image pixels. See [SPEC § Reference points](SPEC.md#reference-points).

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
One piece of rolling stock, labeled by its two ends along its centerline. See [SPEC § Location Data](SPEC.md#location-data-cars-and-sensors).
_Avoid_: vehicle, object, stock (for the thing itself)

**Span**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Car width**:
The width every car is drawn with, derived from DPT and the standard width. Never stored. See [SPEC § Location Data](SPEC.md#location-data-cars-and-sensors).

**Standard width**:
The prototype width used for every car: the widest real stock. See [SPEC § Location Data](SPEC.md#location-data-cars-and-sensors).

**Train**:
Cars whose ends coincide. Derived from the labels, never stored. See [SPEC § Authoring cars](SPEC.md#authoring-cars-and-the-trains-they-form).
_Avoid_: consist

**Coupling**:
The point where two cars' ends coincide. Derived, never labeled. See [SPEC § Authoring cars](SPEC.md#authoring-cars-and-the-trains-they-form).

**Class**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Stock**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Vocabulary**:
`r49`'s word, owned by its [CONTEXT.md](https://github.com/rails49/r49/blob/main/CONTEXT.md).

**Labeled complete**:
A person's assertion that no car in an image is unlabeled. See [SPEC § Labeling completeness](SPEC.md#labeling-completeness).

**Provenance**:
How a car label came to exist: `human`, `proposed` (a model's, accepted as is) or `corrected` (a model's, then edited). See [SPEC § Provenance](SPEC.md#provenance-is-required-not-optional).

**Proposal**:
A car label suggested by the detector for a person to accept, correct or reject. See [SPEC § Assisted Labeling](SPEC.md#assisted-labeling).

**Track**:
The rails cars run on. Nothing stores it. See [ADR 0010](docs/adr/0010-track-is-not-stored.md).
_Avoid_: using it for a sensor or a block

### Occupancy

**Sensor**:
A point on the layout where occupancy must be reported. See [SPEC § Location Data](SPEC.md#location-data-cars-and-sensors).
_Avoid_: detector, block, marker

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
