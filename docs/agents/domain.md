# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Single context. Three documents, each with one job ([ADR 0001](../adr/0001-glossary-and-adrs-alongside-the-spec.md)):

- **`CONTEXT.md`** at the repo root: the glossary. Terms and nothing else.
- **`docs/adr/`**: one short record per decision the code depends on, with its main reason and a link to the issue that settled it.
- **`SPEC.md`** at the repo root: the requirements, and what is ruled out or still open.

GitHub issues stay the full record. The wayfinder maps (label `wayfinder:map`) and their closed tickets hold the alternatives that were rejected; an ADR links them rather than restating them.

## Before exploring, read these

- **`CONTEXT.md`**, for the vocabulary.
- **The ADRs** in the area you are touching.
- **`SPEC.md`**, for what the area must do.

**`SPEC.md` describes the target, not what ships.** Parts of it are unbuilt, and it says so where that is the case. Where the spec and the code disagree, that gap is the planned migration, not a bug to fix. `CLAUDE.md` and `ui/README.md` describe what exists today.

## File structure

```
/
├── CONTEXT.md           ← glossary
├── SPEC.md              ← requirements, whole project
├── CLAUDE.md            ← what exists, and how to build it
├── docs/
│   ├── adr/             ← decisions
│   ├── agents/          ← these files
│   └── research/        ← research notes cited by SPEC.md and the ADRs
├── lib/
├── ui/
├── dataset/
├── detector/
└── classifier/
```

Some research notes cited by `SPEC.md` live on their own branches rather than on `main` (`research/label-derivation`, `prototype/yolo-bench`). The citation names the branch where that is the case.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as `CONTEXT.md` defines it, and not the words it lists under _Avoid_. The terms have moved before.

If the concept you need isn't in the glossary, either you're inventing language the project doesn't use (reconsider) or there's a real gap (add the term to `CONTEXT.md`).

## Flag conflicts with settled decisions

If your output contradicts an ADR, say so rather than silently overriding it:

> _Contradicts ADR 0010 (track is not stored) — but worth reopening because…_

A decision with no ADR yet may still be settled in a closed issue or in `SPEC.md`; cite that instead. A decision that is reversed gets a new ADR that names the one it replaces; the old ADR is not edited.
