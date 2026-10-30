# The classifier joins the live path

Supersedes [ADR 0004](0004-one-model-in-the-live-path.md).

The live view runs a second model, the classifier from `rails49/classifier`, which reads one patch per sensor. It costs a small fraction of the detector, which cannot run at a useful rate in the browser (rails49/detector#37). It reports sensor states only, with no car positions, counts or couplings. When both models run, a sensor is occupied if either says so, in line with [ADR 0005](0005-l1-is-geometry-over-l0-biased-toward-occupied.md).

Decided in [#272](https://github.com/rails49/occupancy/issues/272).
