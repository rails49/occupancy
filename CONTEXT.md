# occupancy

Camera-based track occupancy detection for model railroads: photographs of a layout are labeled, a detector is trained on them, and the live view reports occupancy at points the author chose.

## Language

### Layout and archive

**Layout**:
A model railroad as seen by one fixed overhead camera.
_Avoid_: scene

**Archive**:
A `.r49` file holding one layout's images, calibration, sensors and car labels.
_Avoid_: project, dataset

**Format**:
The rules every archive follows, independent of any program that reads or writes one.
_Avoid_: schema (for the rules themselves)

**Outside reader**:
A program that reads archives and is not part of this project, such as someone else's model trained on the corpus.
_Avoid_: consumer, classifier

**Corpus**:
The archives contributed to `rails49/r49`, which training draws from.

**Corpus rule**:
A requirement an archive must meet to be accepted into the corpus, beyond the format. Corpus rules keep archives consistent with each other, such as every class being in the vocabulary.

**Reader requirement**:
A condition one reader places on the archives it uses, such as a minimum DPT. The corpus may report it but never enforces it.

**Fixture**:
One of the six archives kept to exercise the code. They are below the minimum DPT and are not training data.

**Image**:
One photograph of the layout in an archive.
_Avoid_: frame (for a stored image; a frame is one picture from the live camera)

**Scale**:
The modelling scale of a layout (HO, N, Z, ...), which fixes its ratio to the prototype.

**Prototype**:
The real railway a model represents.

### Calibration

**DPT**:
Dots per track: image pixels per track gauge, measured on the reference plane.
_Avoid_: px/mm, resolution

**Minimum DPT**:
The DPT below which images are too coarse for this project's detector to train on. A reader requirement, not a corpus rule. The editor warns below it and never blocks.

**Recommended DPT**:
The DPT the corpus asks contributors to reach. A submission below it is warned, never refused. Set by the corpus, separately from the minimum DPT.

**Calibration**:
The reference points that fix a layout's DPT.

**Reference point**:
A point given both as an image position and as a layout position in millimetres.
_Avoid_: control point, calibration marker

**Camera height**:
The distance from layout zero up to the camera.

**Reference height**:
The height of the railhead above layout zero; the plane DPT is reported on.

**Residual**:
How far the reference points disagree with the fitted scale, in image pixels.

### Drift

**Pose**:
The camera position the images of an archive share.

**Reference image**:
The first image in an archive. Its pose is the one drift is measured against.

**Drift**:
How far the camera has moved from the pose, measured in pixels of the reference image.
_Avoid_: misalignment

**Drift tolerance**:
The largest drift accepted, as a fraction of a track width.

### Cars and labels

**Car**:
One piece of rolling stock, labeled by its two ends along its centerline.
_Avoid_: vehicle, object, stock (for the thing itself)

**Span**:
The two end points of a car label.

**Car width**:
The width every car is drawn with, derived from DPT and the standard width. Never stored.

**Standard width**:
The prototype width used for every car: the widest real stock, so boxes err toward covering a sensor.

**Train**:
Cars whose ends coincide. Derived from the labels, never stored.
_Avoid_: consist

**Coupling**:
The point where two cars' ends coincide. Derived, never labeled.

**Class**:
A dotted name for what a car is, such as `stock.loco.steam`.

**Stock**:
The root class. Every new car is `stock`, and every class sits under it.

**Vocabulary**:
The tree of classes an author may assign.
_Avoid_: taxonomy, label set

**Labeled complete**:
A person's assertion that no car in an image is unlabeled. Only a person can make it.

**Provenance**:
How a car label came to exist: `human`, `proposed` (a model's, accepted as is) or `corrected` (a model's, then edited).

**Proposal**:
A car label suggested by the detector for a person to accept, correct or reject.

**Track**:
A deferred concept. Nothing stores track geometry.
_Avoid_: using it for a sensor or a block

### Occupancy

**Sensor**:
A point on the layout where occupancy must be reported.
_Avoid_: detector, block, marker

**Detector**:
The model that finds cars in a frame: an oriented-box YOLO network.
_Avoid_: sensor, classifier

**Classifier**:
The CNN that judges occupancy at a single point. Kept retrainable; nothing loads it.

**Detection**:
One car the detector found: an oriented box, a class and a confidence.

**L0**:
Every detection in a frame, as the detector emitted it.

**L1**:
Each sensor's state, computed from L0 alone.

**Occupied**:
An L1 state: some detection's box contains the sensor.

**Clear**:
An L1 state: no detection's box contains the sensor. It carries no confidence.

**Unknown**:
An L1 state: the system could not look, because the sensor is outside the frame, DPT is unresolved, no model is loaded, or the camera has drifted. Never a confidence outcome.

**Phantom**:
A detection where there is no car.

**Miss**:
A car with no detection.

**Canvas**:
The fixed square every detector input is padded onto, at a constant DPT.

**Tile**:
A canvas-sized piece of a capture larger than the canvas.
