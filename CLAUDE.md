# CLAUDE.md

Camera-based track occupancy detection for model railroads, with an
oriented-box object detector. UI served at https://occupancy.rails49.org.

The detector sometimes misses rolling stock or reports phantom trains. Present
nothing here as a safety interlock.

gate: pnpm install --frozen-lockfile && bin/test.sh

## Where things are

What each kind of doc holds: org [ADR-0021](https://github.com/rails49/.github/blob/main/docs/adr/0021-each-fact-has-one-owner-and-the-glossary-is-glossary-md.md). See `docs/agents/domain.md`.

- Commands: `README.md`.
- How the stages fit together, models, deploy: `docs/SYSTEM.md`.
- Terms: `GLOSSARY.md`. Decisions: `docs/adr/`. Requirements: `SPEC.md`.
- Before touching `lib/`, read `lib/CLAUDE.md`. Before touching `ui/`, read
  `ui/CLAUDE.md`.

## Traps

- `main` takes changes only through a squash-merged PR that passes the `test`
  check. Start each issue on a new branch from `origin/main`:
  `git fetch -q origin && git switch --no-track -c <issue>-<slug> origin/main`.
  Every code change passes the gate and the `code-review` skill before its PR.
- `SPEC.md` describes the target. Where it or an ADR disagrees with the code
  (for example `dptAtHeight(z)`, which `SPEC.md` § Camera height requires and
  nothing builds), the gap is the planned migration; leave it unless the task
  is that migration.
- The `.r49` format is `@rails49/r49`'s, pinned once in `pnpm-workspace.yaml`.
  A format change is a release in `rails49/r49`, then a bump here
  (org [ADR-0022](https://github.com/rails49/.github/blob/main/docs/adr/0022-the-r49-format-is-r49s-and-each-consumer-pins-it.md)).
- The detector is `@rails49/detector`, pinned in `pnpm-workspace.yaml`'s
  catalog. A detector change is a release in `rails49/detector`, then a bump
  here (ADR 0019). What the pinned version holds: `docs/SYSTEM.md` § The model.
- Everything the app fetches comes from origin (ADR 0006). Import
  `onnxruntime-web/wasm`, never the package root.
- The model filename is `@rails49/detector`'s: its `./model` exports entry and
  `DETECTOR_MODEL_FILE`. `ui/modelAssets.ts` re-exports the constant to fetch
  the model, and the build resolves the entry to copy it. No UI file names the
  filename (`ui/tests/modelAssets.test.ts`).
- The deploy budget in `bin/check-deploy-dir.sh` is in apparent bytes. `du`
  reports more; measure the way the script does.
- `bin/deploy.sh` needs Cloudflare credentials. Ask the user to run it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `rails49/occupancy`, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md`, `docs/adr/` and `SPEC.md`. See `docs/agents/domain.md`.
