# Track centerlines are stored

Supersedes [ADR 0010](0010-track-is-not-stored.md).

Each archive stores its track centerlines as polylines in image pixels, an optional field of the `.r49` format. The classifier needs them: a patch is placed on the track and turned to its direction, and its training labels come from where cars stand along it. A car belongs to the centerline nearest its span midpoint, which keeps a car on the next track from reading as occupied.

Centerlines are drawn once per archive, since its images share one pose. The editor snaps rough clicks to the rails. Turnouts and crossings are not traced: their rails confuse the snap, and a sensor with no centerline under it reads unknown. That is accepted as a limitation.

## Considered options

- Splines through fewer clicks. Every reader of the format would have to implement the curve; snapping to the rails takes away the tedium that splines would.
- Free track labeled per image. Far more work than one tracing per archive, which car labels and labeled complete already turn into free and occupied positions.
- Track from the RailModeller plan (`Gotthard.pdf`). Its coordinates have not been compared with the built layout, and it ties the tool to one layout.

Decided in [#272](https://github.com/rails49/occupancy/issues/272).
