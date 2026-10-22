#!/bin/bash
set -e

# Set working directory to project root
cd "$(dirname "$0")/.."

# No model is downloaded and no accuracy is asserted. The marker-driven
# regression test and its 99.5% gate were retired with the v4 conversion
# (rails49/detector's SPEC.md § Accuracy, issue #8): they iterated point markers v4 deletes, and
# guarded an artifact the live path no longer loads with a number that was
# never a generalization estimate. Between here and the first detector there is
# no automated check that a model rebuild matches the published one — a known,
# accepted gap, not one to plug with a substitute gate.

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

# A green gate merges a look bump pull request on its own (rails49/look#10), so
# the gate has to build the UI as well as test it.
echo "📦 Building the UI..."
pnpm --filter @occupancy/ui build

echo "🎉 All checks passed successfully!"
