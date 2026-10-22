#!/bin/bash
set -e

# Set working directory to project root (parent of bin/)
cd "$(dirname "$0")/.."

echo "🔍 Checking that the checkout is origin/main..."
bin/check-deploy-source.sh

# Ensure CLOUDFLARE_API_TOKEN is set
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  if command -v op &>/dev/null; then
    echo "🔑 Retrieving Cloudflare credentials dynamically from 1Password..."
    CLOUDFLARE_API_TOKEN=$(op read "op://rails49/Cloudflare Pages/token")
    CLOUDFLARE_ACCOUNT_ID=$(op read "op://rails49/Cloudflare Pages/account_id")
    export CLOUDFLARE_API_TOKEN
    export CLOUDFLARE_ACCOUNT_ID
  fi
fi

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "❌ Error: CLOUDFLARE_API_TOKEN is not set in the environment and could not be retrieved via 1Password."
  exit 1
fi

# The app has an origin to itself (rails49/control#47). It used to share the
# apex with a landing page, which is why it built under `/ui/` and staged into a
# tracked `rails49.org/` directory beside `index.html` and `_headers`. Both are
# gone: the landing page lives in `rails49/rails49.org`, `_headers` ships from
# `ui/public/`, and `base` is `/`. So the deploy directory *is* the build output
# — no staging copy, and nothing untracked can accumulate beside it, because
# vite empties `dist/` on every build.
PROJECT_NAME="occupancy-rails49"
DEPLOY_DIR="ui/dist"

# 1. Build the Lit UI assets
echo "📦 Building UI..."
pnpm --filter @occupancy/ui build

# 2. Refuse to publish anything unaccounted for. Every check lives in the guard
#    script — an inventory of what may ship, no symlinks, a total-size budget,
#    plus the ORT-binary and per-file checks that used to sit here. It is a
#    separate script so it can be run against a directory built to fail it;
#    `ui/tests/deployGuard.test.ts` does that. `set -e` aborts on its exit code,
#    which is what keeps a refused deploy from uploading anything.
echo "🔍 Checking '$DEPLOY_DIR' before uploading..."
bin/check-deploy-dir.sh "$DEPLOY_DIR"

# 3. Attempt to create the project in case it doesn't exist yet
echo "🌐 Ensuring Cloudflare Pages project '$PROJECT_NAME' exists..."
if [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then
  npx wrangler@3 pages project create "$PROJECT_NAME" --production-branch=main 2>/dev/null || echo "ℹ️  Project creation skipped or already exists."
else
  echo "⚠️  CLOUDFLARE_ACCOUNT_ID is not set. Attempting project creation without account ID..."
  npx wrangler@3 pages project create "$PROJECT_NAME" --production-branch=main 2>/dev/null || echo "ℹ️  Project creation skipped or already exists."
fi

# 4. Deploy the static assets
echo "🚀 Deploying static files from '$DEPLOY_DIR' to Cloudflare Pages..."
npx wrangler@3 pages deploy "$DEPLOY_DIR" --project-name="$PROJECT_NAME" --branch=main

echo "✅ Deployment successful! Your site is live on Cloudflare Pages."
