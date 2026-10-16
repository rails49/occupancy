# Camera height corrects scale

DPT is corrected for height using one authored number, `camera_height_mm`, and reported at `reference_height_mm`, the railhead. Under a camera at height h, a length at height z reads z/(h−z) too large: 9.3% at track height under a 1 m camera. Focal length was rejected: it cancels from the error, Exif focal tags are optional, and `getUserMedia` exposes none.

The field is optional in the schema and required by the editor, which keeps the settings dialog open until it is supplied. Remaining perspective error gets a warning in the editor and nothing else; it was already present when the labels were drawn, so the live view never refuses on it. Images are never warped, and position is not corrected because nothing uses image-to-layout positions.

Decided in [#135](https://github.com/rails49/occupancy/issues/135), [#136](https://github.com/rails49/occupancy/issues/136) and [#139](https://github.com/rails49/occupancy/issues/139).
