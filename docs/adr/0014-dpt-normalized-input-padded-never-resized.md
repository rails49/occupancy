# DPT-normalized input, padded and never resized

*Superseded by [rails49/detector ADR 0014](https://github.com/rails49/detector/blob/main/docs/adr/0014-dpt-normalized-input-padded-never-resized.md).*

Status: accepted, not yet built.

Every image is resampled to a constant DPT and padded onto one authored square canvas, never resized. A capture larger than the canvas is tiled with overlap longer than the longest car, and tile detections are joined in full-frame coordinates. [#112](https://github.com/rails49/occupancy/issues/112) measured the model finding far fewer cars when car width in model pixels changes, so scale is normalized instead of following from an input grid.

Padding is required because Ultralytics rescales each image's long side to `imgsz` before letterboxing; an image already padded to the canvas makes that a no-op. The canvas is square because training takes a single `imgsz`, and authored because a size derived from the corpus would change with one large layout. Export stays static; a dynamic export was measured to work and is kept as a fallback. Neither the format nor the user sees any of this.

Decided in [#130](https://github.com/rails49/occupancy/issues/130).
