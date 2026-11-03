# A track passes through every click, with gaps marked straight

Resolves [#317](https://github.com/rails49/occupancy/issues/317), on map [#287](https://github.com/rails49/occupancy/issues/287). Supersedes [ADR 0024](0024-centerlines-store-fitted-nodes-and-their-clicks.md).

Each archive stores its tracks under `tracks`, an optional field of the `.r49` format, in image pixels. The classifier needs them: a patch is placed on the track and turned to its direction, and its training labels come from where cars stand along it. A car belongs to the track nearest its span midpoint, which keeps a car on the next track from reading as occupied. Tracks are drawn once per archive, since its images share one pose. Turnouts and crossings are not traced, and a sensor with no track under it reads unknown. That is accepted as a limitation.

A track is stored as two things. Its nodes, each a position and a heading, are the geometry every reader uses. The format defines the curve between two nodes, and `@rails49/r49` and `rails49-r49` compute it, so every reader draws the same line from the same nodes ([#328](https://github.com/rails49/occupancy/issues/328)). Its clicks, the points a person marked on the middle of the track, are the editor's input and the only thing a person edits. A click may carry `"straight": true`: the gap from it to the next click is straight. Every other reader ignores the clicks and their marks. The format makes no promise that the nodes are a function of the clicks.

The editor builds the nodes from the clicks and their marks alone, by the rule in [SPEC § Track centerlines](../../SPEC.md#track-centerlines). The line passes through every click outside a run of straight gaps. Each such click takes a heading from its neighbours, and each free gap is two arcs that meet tangentially, so moving a click outside a run changes the line only within three gaps of it, and the clicks give the same line in either order. A run of straight gaps is one straight fitted to its clicks, and the curve next to it meets it tangentially with no click where the curve ends. The person marks which gaps are straight; the tool never guesses. The rule and its constants stay in occupancy as editor code and are never stored.

Stored nodes win on load: nothing rebuilds a line until a person edits it. A change to the rule then moves no existing track, and no sensor or car falls off it. A line without clicks is valid: it is drawn, sensors and cars land on it, and it can be deleted, but it cannot be edited.

Clicks are not snapped to the rails. That was tried in [#275](https://github.com/rails49/occupancy/issues/275) and was not accurate enough. The methods weighed for the rule are in [`docs/research/track-trace-local-curves.md`](../research/track-trace-local-curves.md) and [`docs/research/track-fitting-methods.md`](../research/track-fitting-methods.md); why it works in image pixels, not layout coordinates, is in [`docs/research/track-arcs-in-image.md`](../research/track-arcs-in-image.md).

## Considered options

- The projection rule ([#311](https://github.com/rails49/occupancy/issues/311)), which built each new part from the heading at the join and one click. The heading at the end of a line depended on every click before it, so moving or inserting a click changed the whole line after it, an error in an early click never died out, and the same clicks in reverse order gave another line. A part refit by least squares could miss a click by half a gauge. A straight after a curve was exact only if the last click on the arc put the arc's end heading along the straight, which is too fiddly to do by hand.
- Guessing which gaps are straight. At 0.1 G, a 50 G curve and a straight cannot be told apart over 9 G of track.
- A "one radius" mark for gaps on one arc, tried in the prototype. A broad curve clicked less often gives the same line without it.
- The clicks-to-nodes rule in rails49/r49, beside the curve between nodes. Every reader would then depend on the editor's rule and its version, and a change to it would move every line on load. No reader but the editor needs it.
- Clicks alone, rebuilt on load. Every reader would have to implement the rule, and a change to the rule would move stored track off the sensors and cars on it.
- Nodes alone. A later session could not rebuild a line from what the person placed, and [#284](https://github.com/rails49/occupancy/issues/284) showed that dragging a node or turning its heading gives a curve that is no longer an arc.

Why tracks are stored at all, against track labeled per image and track from the layout plan, was decided in [#272](https://github.com/rails49/occupancy/issues/272).
