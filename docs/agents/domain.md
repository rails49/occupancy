# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Single context. What each kind of doc holds, and how ADRs change, is set by org [ADR-0021](https://github.com/rails49/.github/blob/main/docs/adr/0021-each-fact-has-one-owner-and-the-glossary-is-glossary-md.md). [ADR 0001](../adr/0001-glossary-and-adrs-alongside-the-spec.md) adds `SPEC.md` for the requirements.

The wayfinder maps (label `wayfinder:map`) and their closed tickets hold the alternatives that were rejected; an ADR links them rather than restating them.

## Before exploring, read these

- **`GLOSSARY.md`**, for the vocabulary.
- **The ADRs** in the area you are touching.
- **`SPEC.md`**, for what the area must do.

**`SPEC.md` describes the target, not what ships.** Parts of it are unbuilt, and it says so where that is the case. Where the spec and the code disagree, that gap is the planned migration, not a bug to fix. `docs/SYSTEM.md` and `ui/README.md` describe what exists today.

## File structure

```
/
├── GLOSSARY.md           ← glossary
├── SPEC.md              ← requirements, whole project
├── CLAUDE.md            ← pointers, conventions and traps
├── docs/
│   ├── adr/             ← decisions
│   ├── agents/          ← these files
│   ├── SYSTEM.md        ← what exists, across the stages
│   ├── UI.md            ← how ui/ works, and its invariants
│   └── research/        ← research notes cited by SPEC.md and the ADRs
├── lib/
├── tools/
└── ui/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as `GLOSSARY.md` defines it, and not the words it lists under _Avoid_. The terms have moved before.

If the concept you need isn't in the glossary, either you're inventing language the project doesn't use (reconsider) or there's a real gap (add the term to `GLOSSARY.md`).

## Flag conflicts with settled decisions

If your output contradicts an ADR, say so rather than silently overriding it:

> _Contradicts ADR 0010 (track is not stored) — but worth reopening because…_

A decision with no ADR yet may still be settled in a closed issue or in `SPEC.md`; cite that instead.
