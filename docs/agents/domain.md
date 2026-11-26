# Domain docs

How the skills use a repository's domain docs is the organisation's
[domain.md](https://github.com/rails49/.github/blob/main/docs/agents/domain.md). This file holds what occupancy adds.

The detector, its training and their terms and ADRs are owned in [rails49/detector](https://github.com/rails49/detector); this repo's docs link there. [ADR 0001](../adr/0001-glossary-and-adrs-alongside-the-spec.md) adds `SPEC.md` for the requirements.

The wayfinder maps (label `wayfinder:map`) and their closed tickets hold the alternatives that were rejected; an ADR links them rather than restating them.

## Before exploring, also read `SPEC.md`

`SPEC.md` says what the area must do. It describes the target, not what ships. Parts of it are unbuilt, and it says so where that is the case. Where the spec and the code disagree, that gap is the planned migration, not a bug to fix. `docs/SYSTEM.md` and `ui/README.md` describe what exists today.

## The glossary and settled decisions

The terms have moved before: use a term as `GLOSSARY.md` defines it, and add a missing term to `GLOSSARY.md`.

A decision with no ADR yet may still be settled in a closed issue or in `SPEC.md`; cite that instead.
