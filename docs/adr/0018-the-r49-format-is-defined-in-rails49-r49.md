# The .r49 format is defined in rails49/r49

*Superseded by [ADR 0019](0019-detection-and-training-move-to-rails49-detector.md).*

Status: accepted, not yet built. Replaces the decision in [#55](https://github.com/rails49/occupancy/issues/55).

The corpus is CC BY 4.0 so that others can train on it. An outside reader should not have to read this repository to understand an archive. `rails49/r49` therefore owns the format: a written definition, a TypeScript implementation that reads and writes, a Python implementation that only reads, and conformance cases both must pass. The cases are archives or bare manifests with the expected result, the rule that failed, and the expected DPT within a tolerance. The scales, gauge, vocabulary and recommended DPT sit in one JSON file there that both implementations and the validator read. Code is MIT; archives and the written definition stay CC BY 4.0. Each tag publishes `@rails49/r49` to npm and `rails49-r49` to PyPI, so installing either never downloads the corpus.

The corpus rules (format validity, `id`, path, no `proposed` label, every class in the vocabulary) block a submission. DPT is a reader requirement, not a corpus rule: r49 reports it, warns below its own recommended DPT, and never refuses. This repository's `min_dpt` is the detector's requirement and is set separately. The DPT fit, its residual and the camera-height correction belong to the implementations in r49, since every reader filters on the same number. Car width does not: it is this project's choice, set wide so boxes cover sensors.

This repository depends on `@rails49/r49` pinned to a version and deletes `lib/r49`, `lib/uid` and `tools/r49-validate`. `config.yaml` keeps `min_dpt`, `standard_width` and `detector.classes`, and the generator checks `classes` against the package's vocabulary. A format change is a release in r49 followed by a version bump here. Unknown keys stay rejected by readers and writers alike, so a reader on an older version refuses a newer archive until it upgrades.

## Considered options

- Keep the format here and have r49 run this repository's validator at `main` (#55). Outside readers would need both repositories, and the TypeScript source cannot be installed outside this workspace or used from Python.
- Keep the definition here and generate a checked copy into r49. The copy would be a document, not code an outside reader can run.
- Install the packages from git. Every install would download the corpus.
- Let read-only loading ignore unknown keys. That gives two load modes and two expected results per conformance case, to spare readers an upgrade that schema changes rarely require.

## Consequences

ADR 0002 is retired once r49's CI no longer checks out this repository, not before. ADR 0008 moves to r49 with the format.
