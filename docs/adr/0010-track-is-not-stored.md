# Track is not stored

*Superseded by [ADR 0021](0021-track-centerlines-are-stored.md).*

v4 stores no track geometry. Track has no consumer in the live path: it is not a detector class, and L1 does not match detections to track. Track belongs to the layout and the camera is fixed, so splines can be added to an existing archive later without invalidating a car label. Cars are authored as two clicks on the visible car ends, with no snapping.

The cost is that empty-track crops for the classifier cannot be derived; that is owed back only if the classifier returns. Decided in [#13](https://github.com/rails49/occupancy/issues/13); the questions a later track effort must answer are in [#14](https://github.com/rails49/occupancy/issues/14).
