# The repository stays public

`rails49/occupancy` must stay public. The corpus repository `rails49/r49` checks this repository out at `main` in CI to run `tools/r49-validate`. `GITHUB_TOKEN` is scoped to the repository running the workflow, so a private `rails49/occupancy` returns 404. No token fixes it: contributor submissions are fork pull requests, and GitHub passes them no secrets. Nothing in this repository fails when the constraint is broken.

Decided in [#74](https://github.com/rails49/occupancy/issues/74), written down in #75.
