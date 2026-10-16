# A glossary and ADRs alongside the spec

Status: accepted. Replaces the decision in [#9](https://github.com/rails49/occupancy/issues/9). Proposed in [#164](https://github.com/rails49/occupancy/issues/164).

Domain documentation has three parts with separate jobs. `CONTEXT.md` is the glossary. `docs/adr/` records each decision the code depends on, with its main reason. `SPEC.md` holds the requirements. Issues stay the full record, and an ADR links its issue instead of restating the discussion.

#9 kept everything in `SPEC.md` and the issues, to avoid three documents to keep in step. In practice the reasons collected in a fourth place, `CLAUDE.md`, and went stale there: it still described the camera-height model as unbuilt after #143 and #144 built it. Issues are outside the repository, so an agent working on the code cannot search them. An accepted ADR is never edited, only replaced by a later one, so it adds little upkeep.
