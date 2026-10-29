#!/bin/bash
set -e

# Set working directory to project root
cd "$(dirname "$0")/.."

# Run TypeScript typechecks
echo "🔍 Running TypeScript typecheck..."
pnpm -r typecheck

echo "🧹 Linting the UI..."
pnpm lint

# Run TypeScript tests
echo "🧪 Running TypeScript tests..."
pnpm test

# The chrome is @rails49/look's (rails49/look#8): this fails on app code that
# styles it.
echo "🎨 Checking the UI styles none of look's chrome..."
ui/node_modules/.bin/look-check ui/src ui/index.html

# Every tool version is pinned: these come from PyPI at run time, so an
# unpinned one would let a release of ruff or pyright turn the gate red on code
# nobody touched. `uv` is all the environment has to provide (in CI,
# astral-sh/setup-uv); `uv tool run` is `uvx` without relying on that shim being
# on PATH. pyright is given the imports so it can resolve them, and `uv run`
# is told `--no-project` so nothing above the checkout can be picked up.
echo "🐍 Checking the Python scripts in bin/..."
uv tool run ruff@0.17.3 check bin/*.py
uv tool run ruff@0.17.3 format --check bin/*.py
uv tool run --with pillow==13.0.0 --with pytest==9.2.0 pyright@1.1.414 bin/*.py
uv run --no-project --with pillow==13.0.0 --with pytest==9.2.0 pytest bin/

# A green gate merges a look bump pull request on its own (rails49/look#10), so
# the gate has to build the UI as well as test it.
echo "📦 Building the UI..."
pnpm --filter @occupancy/ui build

echo "🎉 All checks passed successfully!"
