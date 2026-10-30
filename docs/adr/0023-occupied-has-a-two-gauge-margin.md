# Occupied has a two-gauge margin

Amends [ADR 0005](0005-l1-is-geometry-over-l0-biased-toward-occupied.md).

A sensor is occupied when a car on its track comes within 2 G of it along the track, for both the detector and the classifier. A miss costs a collision, so a car close to a sensor counts. One definition lets the two models be combined by "either says occupied" and scored against the same ground truth.

For the detector, each detection's box is lengthened by 2 G at both ends and the sensor is tested against it, as before. A detection is not matched to a centerline: [SPEC § The occupancy test](../../SPEC.md#the-occupancy-test) rejects that because a wrong match reports the wrong track occupied. The classifier's training labels do match each car to its nearest centerline, because those come from hand-made spans that a person can check.

The margin also covers lean. Seen from one camera, a car's roof appears up to about 2 G farther from the image center than its wheels at the ends of the 2 × 1 m layout. That lengthens a span at its outer end and never shortens it, so lean adds false occupied, not misses. No lean correction is made: car heights vary from about 8 to 25 mm in N, so a single correction would turn some of that false occupied into misses.

Decided in [#272](https://github.com/rails49/occupancy/issues/272).
