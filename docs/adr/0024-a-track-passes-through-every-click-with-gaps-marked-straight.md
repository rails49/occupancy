# A track passes through every click, with gaps marked straight

Resolves [#317](https://github.com/rails49/occupancy/issues/317), on map [#287](https://github.com/rails49/occupancy/issues/287). Supersedes [ADR 0021](0021-track-centerlines-are-stored.md).

Each archive stores its tracks under `tracks`, an optional field of the `.r49` format, in image pixels. The classifier needs them: a patch is placed on the track and turned to its direction, and its training labels come from where cars stand along it. A car belongs to the track nearest its span midpoint, which keeps a car on the next track from reading as occupied. Tracks are drawn once per archive, since its images share one pose. Turnouts and crossings are not traced, and a sensor with no track under it reads unknown. That is accepted as a limitation.

A track is stored as two things. Its nodes, each a position and a heading, are the geometry every reader uses. The format defines the curve between two nodes, and `@rails49/r49` and `rails49-r49` compute it, so every reader draws the same line from the same nodes ([#328](https://github.com/rails49/occupancy/issues/328)). Its clicks, the points a person marked on the middle of the track, are the editor's input and the only thing a person edits. A click may carry `"straight": true`: the gap from it to the next click is straight. Every other reader ignores the clicks and their marks. The format makes no promise that the nodes are a function of the clicks.

The editor builds the nodes from the clicks and their marks alone, by the rule in [SPEC § Track centerlines](../../SPEC.md#track-centerlines). The line passes through every click outside a run of straight gaps. Each such click takes a heading from its neighbours, and each free gap is two arcs that meet tangentially, so moving a click outside a run changes the line only within three gaps on each side of it, and the clicks give the same line in either order. A run of straight gaps is one straight fitted to its clicks, and the curve next to it meets it tangentially with no click where the curve ends. The person marks which gaps are straight; the tool never guesses. An arc that turns more than 90° is cut into pieces of at most 90°, each between two nodes, because the format's curve follows an arc closely only up to 90°. The rule and its constants stay in occupancy as editor code and are never stored.

Stored nodes win on load: nothing rebuilds a line until a person edits it. A change to the rule then moves no existing track, and no sensor or car falls off it. A line without clicks is valid: it is drawn, sensors and cars land on it, and it can be deleted, but it cannot be edited.

Clicks are not snapped to the rails. That was tried in [#275](https://github.com/rails49/occupancy/issues/275) and was not accurate enough. The methods weighed for the rule are in [`docs/research/track-trace-local-curves.md`](../research/track-trace-local-curves.md) and [`docs/research/track-fitting-methods.md`](../research/track-fitting-methods.md); why it works in image pixels, not layout coordinates, is in [`docs/research/track-arcs-in-image.md`](../research/track-arcs-in-image.md).

## Considered options

- The projection rule of [#311](https://github.com/rails49/occupancy/issues/311): weighed in [#317](https://github.com/rails49/occupancy/issues/317).
- Guessing which gaps are straight: [#317](https://github.com/rails49/occupancy/issues/317).
- A "one radius" mark for gaps on one arc: [#317](https://github.com/rails49/occupancy/issues/317).
- The clicks-to-nodes rule in rails49/r49: [#328](https://github.com/rails49/occupancy/issues/328).
- Clicks alone, rebuilt on load: [#291](https://github.com/rails49/occupancy/issues/291).
- Nodes alone: [#291](https://github.com/rails49/occupancy/issues/291).
- The rule's settings stored in the archive: [#291](https://github.com/rails49/occupancy/issues/291).

Why tracks are stored at all, against track labeled per image and track from the layout plan, was decided in [#272](https://github.com/rails49/occupancy/issues/272).
