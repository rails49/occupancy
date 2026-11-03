# Centerlines store fitted nodes and the clicks they came from

*Superseded by [ADR 0025](0025-a-track-passes-through-every-click-with-gaps-marked-straight.md).*

Resolves [#291](https://github.com/rails49/occupancy/issues/291), on map [#287](https://github.com/rails49/occupancy/issues/287). Supersedes [ADR 0021](0021-track-centerlines-are-stored.md).

Each archive stores its track centerlines, an optional field of the `.r49` format, in image pixels. The classifier needs them: a patch is placed on the track and turned to its direction, and its training labels come from where cars stand along it. A car belongs to the centerline nearest its span midpoint, which keeps a car on the next track from reading as occupied. Centerlines are drawn once per archive, since its images share one pose. Turnouts and crossings are not traced, and a sensor with no centerline under it reads unknown. That is accepted as a limitation.

A centerline is stored as two things. Its nodes, each a position and a heading, are the geometry every reader uses. Its clicks, the points a person marked on the middle of the track, are the editor's input and the only thing a person edits; every other reader ignores them. The editor fits straights and circular arcs to the clicks, tangent where they meet, in image pixels, and writes each join as a node. An arc that turns more than 90° also gets a node at its midpoint, because the format draws a node pair as one cubic, which follows an arc closely only up to 90°. The format never says "arc". It makes no promise that the nodes are a function of the clicks.

Stored nodes win on load: nothing refits a line until a person edits it. A change to the fit then moves no existing track, and no sensor or car falls off it. How the editor fits, and its settings, are the editor's constants and are never stored. A line without clicks is valid: it is drawn, sensors and cars land on it, and it can be deleted, but it cannot be refitted.

Clicks are not snapped to the rails. That was tried in [#275](https://github.com/rails49/occupancy/issues/275) and was not accurate enough. The methods weighed for the fit are in [`docs/research/track-fitting-methods.md`](../research/track-fitting-methods.md); why it works in image pixels, not layout coordinates, is in [`docs/research/track-arcs-in-image.md`](../research/track-arcs-in-image.md).

## Considered options

- Clicks alone, refitted on load. Every reader would have to implement the fit, the argument ADR 0021 made against splines; the detector's Python side reads centerlines and must not need the solver. A change to the fit would also move stored track, and the sensors and cars on it would no longer sit on it.
- Fitted parts alone. A later session could not refit a line from what the person placed. The person would edit nodes instead, and [#284](https://github.com/rails49/occupancy/issues/284) showed that dragging a node or turning its heading gives a curve that is no longer an arc. Storing the parts as straights and arcs with a length and a curvature was not needed either: a tangent chain of straights and arcs is a node list the format already expresses.
- The fit stored as an algorithm, with its settings in the archive, so that any reader can rebuild a line from its clicks. Every reader would depend on the editor's solver and its version, and a change to the solver would change every line on load.

Why centerlines are stored at all, against track labeled per image and track from the layout plan, was decided in [#272](https://github.com/rails49/occupancy/issues/272). The editing rules that make a finished line a function of its clicks are in [#294](https://github.com/rails49/occupancy/issues/294).
