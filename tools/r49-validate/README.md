# `@occupancy/r49-validate`

The corpus repo's validator, living here rather than there.

`rails49/r49` holds `.r49` archives; this checks them. It runs from a checkout of
`rails49` at `main` (issue #55), so nothing is published, no schema is vendored,
and `@occupancy/config` supplies `MIN_DPT` and the class vocabulary — meaning
`config.yaml` gains no second home for values that must agree.

It sits in `tools/`, not `lib/` and not `dataset/`, for two reasons: it is an
executable whose consumer is a foreign CI rather than a library `ui/` imports,
and `dataset/` drags `sharp` and `onnxruntime-node`. Validating a zip here costs
`jszip` + `zod` + `tsx` and no native builds.

## Use

```bash
# Print the capture-guidance table for CONTRIBUTING.md. Takes no paths, so it
# does not care what the working directory is. --silent is required, not
# cosmetic: without it pnpm writes its script banner to stdout, and #62 diffs
# that stdout against committed prose.
pnpm --silent --filter @occupancy/r49-validate guidance
```

Validation takes **paths**, and `pnpm --filter` runs a script with the working
directory set to the package — so a corpus workflow must not go through it, or
every relative path resolves against `tools/r49-validate/`. Run the CLI from the
corpus root instead, with the `rails49` checkout named explicitly:

```bash
# cwd is the corpus checkout; rails49/ is this repo, checked out beside it.
rails49/tools/r49-validate/node_modules/.bin/tsx \
  rails49/tools/r49-validate/src/cli.ts --author <handle> <path>...
```

Both forms exist because the two subcommands have genuinely different needs, not
as a convenience.

`guidance --check` verifies instead of printing: it reads a document, pulls the
block out from between its `BEGIN GENERATED` / `END GENERATED` markers, and
compares it to what `guidance` would emit. It takes a **path**, so the corpus
workflow runs it the second way:

```bash
rails49/tools/r49-validate/node_modules/.bin/tsx \
  rails49/tools/r49-validate/src/cli.ts guidance --check CONTRIBUTING.md
```

Exit 1 on drift, 0 when it matches. The comparison and its failure message live
in `guidance.ts` rather than in the workflow's YAML for the same reason
`corpus.ts` holds the path rules: `pnpm test` covers this and YAML is covered by
nothing — and the message is the deliverable, because the usual cause of a
failure is `min_dpt` moving in *this* repository, which the contributor reading
it has never touched.

**stdout is machine, stderr is human — always both, no flag.** The workflow
pipes stdout through `jq` to build its `::warning` annotations and its job
summary; a person reads stderr. One code path serves both, so the rendering
nobody tests cannot drift from the one that matters.

| Exit | Meaning |
| :--- | :--- |
| `0` | No blocking errors. Warnings do not change this — that is what makes the bar soft. |
| `1` | At least one archive carries a blocking error. |
| `2` | The tool itself failed: bad arguments, an unreadable path, a bug. |

`1` and `2` are distinct on purpose. A crash here must never read as "your
archive is bad" to a contributor who did nothing wrong.

`--author` is the pull request author's handle, used only for the rule that a
submission sits under its own contributor directory. Omitting it skips that one
rule, so a contributor can run the tool locally without inventing a value.

## What it checks

Issue #57 decides the bar; `validate.ts` implements it and `corpus.ts` holds the
path rules from #56. Under `archives/<handle>/<slug>.r49` the blocking set is:
the archive loads as v4, the manifest and the zip name the same images in both
directions, no label is still `proposed`, every class is in the vocabulary, an
archive-level `id` is present, no two archives in one contributor directory
share an id, and the path is a slug under the author's own handle.

Every blocking error in the JSON carries a `rule` alongside its `code`: the id,
from `@occupancy/r49`'s closed `RULES` set, of the rule the archive broke
(#182). The two coincide for every corpus rule; they differ for an archive that
will not load, whose `code` is `archive/load` whatever the cause and whose
`rule` says which format rule refused it — `manifest/version`,
`manifest/unknown-key` and so on. Match on `rule`; the message may be reworded.
Warnings carry no rule, because nothing is refused on them. The field is
additive, so the report's `version` stays 1.

Warnings — DPT below `MIN_DPT`, calibration that does not resolve, images not
marked complete, and calibration points off the reference plane with no camera
height — are read by the maintainer and block nothing.

**A missing `camera_height_mm` is deliberately not one of them.** It would fire
on every submission from day one, fixtures included, and a warning that always
fires devalues the ones that mean something ([#139]). The editor is where the
height is *required*; here it is a fact in the table, alongside the reference
height and the obliquity the two of them imply. The narrower warning above is
the one place the fit silently means something other than the contributor
intends: without a height, points off the reference plane are excluded from it.

The geometry facts are **reported, never thresholded** — the `dptResidual`
precedent. The obliquity is quantified but its cost to detection accuracy is
unmeasured, so a bar here would be a number nothing earned ([#136]). It is also
a *lower* bound: the camera is assumed to hang over the centre of the calibrated
extent, and an archive calibrated on one patch of a larger layout under-reports.

[#136]: https://github.com/rails49/occupancy/issues/136
[#139]: https://github.com/rails49/occupancy/issues/139

`fixtures/<slug>.r49` is held to structure only and gets **no warnings**: the six
are known to be zero-label and below `min_dpt` by design, so annotating that on
every pull request would be noise.

## The guidance table is generated, never typed

`layout.min_dpt` is provisional. A per-scale capture table hand-written into
another repository's `CONTRIBUTING.md` would be `min_dpt` living in two places
with nothing checking that they agree, so the corpus workflow diffs the
committed prose against `guidance`'s output. That is why the output has a fixed
column order and fixed rounding, and why it states its reference image width:
the width is an input to every number, not a constant.
