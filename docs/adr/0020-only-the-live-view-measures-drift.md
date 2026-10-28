# Only the live view measures drift

Resolves [#252](https://github.com/rails49/occupancy/issues/252). Supersedes [ADR 0013](0013-drift-is-measured-against-the-first-image.md).

Camera drift is measured against one reference image, `images[0]`, the first thumbnail. Scoring the minimum over every image let a drifted image widen the accepted pose permanently. The tolerance is a fraction of a track width, not a pixel count, because the failure is a sensor sliding off its car.

Past the tolerance the live view reports every sensor as unknown, with a visible override, while L0 keeps running. Correcting drift (homography, fiducials) is out of scope.

The editor measures no drift. Its warning cost about 1.5 s of frozen page per 48 MP image, and drift does not reach training data: a car label is drawn on its own image's pixels. What a person loses is the readout that moved when a reorder changed the reference, so dragging a thumbnail to the front now changes the live view's reference with nothing on screen showing it.

Decided in [#12](https://github.com/rails49/occupancy/issues/12), [#94](https://github.com/rails49/occupancy/issues/94), [#118](https://github.com/rails49/occupancy/issues/118) and [#252](https://github.com/rails49/occupancy/issues/252).
