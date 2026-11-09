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

### Track

**Track**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Centerline**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Click**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Gap**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Straight gap**:
`r49`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/r49/blob/main/GLOSSARY.md).

**Free gap**:
`r49`'s word, owned by its [GLOSSARY.md § Tracks](https://github.com/rails49/r49/blob/main/GLOSSARY.md#tracks).

**Node**:
A point of a stored track with the direction the track runs there. Each join is stored as a node. See rails49/r49's [FORMAT § Node](https://github.com/rails49/r49/blob/main/FORMAT.md#node).
_Avoid_: control point, vertex

**Part**:
One straight or one arc of constant curvature in a track. Neighbouring parts are tangent where they meet. See [SPEC § Track centerlines](SPEC.md#track-centerlines).
_Avoid_: segment, section

**Join**:
Where two neighbouring parts of a track meet, with one heading shared by both. Each join is stored as a node.
_Avoid_: part boundary, break

**Tolerance**:
How far a click of a run of straight gaps may lie off the run's line. See [SPEC § Track centerlines](SPEC.md#track-centerlines).

**Chain**:
A run of clicks under the car tool or the track tool, each one going on from the last: the next car of a train, or more of a track. See [docs/UI.md § Chaining](docs/UI.md#chaining-33).

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
How far beyond a car's end, along the track, a sensor still reads occupied: two gauges. The same number for the detector and the classifier. See [ADR 0023](docs/adr/0023-occupied-has-a-two-gauge-margin.md).

**Unknown**:
An L1 state: the system could not look, because no model is loaded, DPT is unresolved, the sensor is outside the frame, the classifier finds no track under the sensor, the camera has drifted, or an occupancy service the page is watching has no frames to send. Not a confidence outcome. A cause the page found is one of a closed set; a cause a service found is the service's own words. See [SPEC § The vocabulary](SPEC.md#the-vocabulary).

**Phantom**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Miss**:
`detector`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/detector/blob/main/GLOSSARY.md).

**Occupancy service**:
`occupancy-service`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/occupancy-service/blob/main/GLOSSARY.md).

**Live contract**:
`occupancy-service`'s word, owned by its [GLOSSARY.md](https://github.com/rails49/occupancy-service/blob/main/GLOSSARY.md).

**Video file**:
A clip of the layout the live view plays in place of the camera, read locally. See [SPEC § Testing and Demo](SPEC.md#testing-and-demo).
_Avoid_: recording (a recording is the drift recording's CSV of samples), video stream (that is the camera's)
