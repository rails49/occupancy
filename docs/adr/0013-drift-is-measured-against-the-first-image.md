# Drift is measured against the first image

Camera drift is measured against one reference image, `images[0]`, the first thumbnail. Scoring the minimum over every image let a drifted image, which the editor warns about but keeps, widen the accepted pose permanently. The tolerance is a fraction of a track width, not a pixel count, because the failure is a sensor sliding off its car.

Past the tolerance the live view reports every sensor as unknown, with a visible override, while L0 keeps running. The editor warns and never blocks, because a person is there to judge. Correcting drift (homography, fiducials) is out of scope.

Decided in [#12](https://github.com/rails49/occupancy/issues/12), [#94](https://github.com/rails49/occupancy/issues/94), [#95](https://github.com/rails49/occupancy/issues/95) and [#118](https://github.com/rails49/occupancy/issues/118).
