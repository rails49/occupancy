# Undo is scoped snapshots

The editor has one linear undo stack per opened archive, covering every image. An entry holds before and after copies of the one part of the manifest it touched, not an inverse command, so there is no inverse to get wrong; code therefore finds labels by `id`, never by object identity. An undo selects the image it affects before applying and then highlights what changed. While a chain of cars is being placed, undo removes the chain's last car and cannot reach past the chain's start.

The stack is bounded by bytes, not entries, and is never persisted or written into the `.r49`. Decided in [#25](https://github.com/rails49/occupancy/issues/25).
