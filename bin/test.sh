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

# A green gate merges a look bump pull request on its own (rails49/look#10), so
# the gate has to build the UI as well as test it.
echo "📦 Building the UI..."
pnpm --filter @occupancy/ui build

echo "🎉 All checks passed successfully!"
