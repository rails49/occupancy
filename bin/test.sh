#!/bin/bash
set -e

# Set working directory to project root
cd "$(dirname "$0")/.."

# No model is downloaded and no accuracy is asserted. The marker-driven
# regression test and its 99.5% gate were retired with the v4 conversion
# (SPEC.md § Accuracy, issue #8): they iterated point markers v4 deletes, and
# guarded an artifact the live path no longer loads with a number that was
# never a generalization estimate. Between here and the first detector there is
# no automated check that a model rebuild matches the published one — a known,
# accepted gap, not one to plug with a substitute gate.

# lib/config is generated from config.yaml and committed, so a fresh clone
# typechecks before anyone runs a generator. Regenerate into a temp tree and
# diff: editing config.yaml without regenerating fails here rather than
# surfacing at runtime. config.json is gitignored and not compared.
#
# This gate is NOT skippable. The Python *checks* below degrade to a warning
# when the environment cannot be resolved, because they test code this change
# does not touch. This is different: it is the only thing standing between a
# config.yaml edit and a silent runtime disagreement, so a missing uv is a
# hard failure rather than a quiet pass. uv is required to regenerate anyway.
echo "🔍 Checking lib/config is up to date with config.yaml..."
if ! command -v uv &>/dev/null; then
  echo "❌ uv is required to verify lib/config against config.yaml, and was not found."
  echo "   Install uv (https://github.com/astral-sh/uv), then re-run."
  echo "   The check regenerates lib/config and diffs it; without it, a stale"
  echo "   lib/config would reach runtime unnoticed."
  exit 1
fi

STALE_DIR=$(mktemp -d)
trap 'rm -rf "$STALE_DIR"' EXIT
if ! uv run --quiet --with pyyaml python3 bin/generate_config.py --out-dir "$STALE_DIR" >/dev/null; then
  echo "❌ Could not regenerate config to verify it. See the error above."
  exit 1
fi
if ! diff -r -q lib/config/src "$STALE_DIR/lib/config/src"; then
  echo ""
  echo "❌ lib/config is stale — config.yaml has changed since it was generated."
  echo "   Run: pnpm config:generate"
  echo "   Then commit the result. lib/config is generated but committed."
  exit 1
fi
echo "✅ lib/config matches config.yaml."

# Run TypeScript typechecks
echo "🔍 Running TypeScript typecheck..."
pnpm -r typecheck

# Run TypeScript tests
echo "🧪 Running TypeScript tests..."
pnpm test

# Run Python linting and formatting. uv is guaranteed present: the lib/config
# gate above already hard-failed without it.
echo "🐍 Running Python checks..."
for project in classifier/resnet detector; do
  echo "   $project"
  (cd "$project" && uv sync --quiet && uv run ruff check . && uv run black --check . && uv run pyright)
  # Only detector has tests, and only for one thing: the letterbox it writes a
  # second copy of because the browser needs the same arithmetic in TypeScript
  # (issue #100). Guarded by the directory rather than by project name so a
  # tests/ tree added to the other one is picked up without editing this.
  if [ -d "$project/tests" ]; then
    (cd "$project" && uv run pytest -q)
  fi
done

echo "🎉 All checks passed successfully!"
