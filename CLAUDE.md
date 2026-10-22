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

- `SPEC.md` describes the target. Where it or an ADR disagrees with the code
  (for example `detector.input: [960, 544]` against ADR 0014), the gap is the
  planned migration; leave it unless the task is that migration.
- The `.r49` format is `@rails49/r49`'s, pinned once in `pnpm-workspace.yaml`.
  A format change is a release in `rails49/r49`, then a bump here (ADR 0018).
- `config.json` and `lib/config/src/` are generated. Edit `config.yaml` and run
  `pnpm config:generate`. `detector.classes` is append-only (ADR 0009).
- `dataset/src/data_prep.ts` and `dataset/src/online_diagnostics.ts` stay
  parked stubs. v4 stores no point markers; see `SPEC.md` § v4 cannot produce a
  trainable CNN dataset.
- Everything the app fetches comes from origin (ADR 0006). Import
  `onnxruntime-web/wasm`, never the package root.
- The model filename is written only in `ui/modelAssets.ts`.
- `detector/models/version.txt` stays `unreleased`: the current model is
  trained on the 46 fixture images and nothing measures it. There is no
  automated model gate, and no substitute for one (ADR 0007).
- `@occupancy/classifier` keeps its three entry points, so `onnxruntime-node`
  and `sharp` stay out of the browser bundle. `ui` does not depend on it
  (ADR 0004).
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
