# Fixtures

`l1.json` is a copy of rails49/occupancy-service's `conformance/l1.json` at
commit `13be039aa44e56f9263b520cbdf04713fb546724`. Its format is the service's
`LIVE.md` § L1 cases. `tests/occupancy.shared.test.ts` runs it.

A copy rather than a dependency: the service is a separate program in another
language, and these bytes are what the page was checked against. Refreshing it
is a new copy and a new commit recorded here, in its own commit.
