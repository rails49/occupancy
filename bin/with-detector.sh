#!/usr/bin/env bash
# Runs a command, bin/test.sh by default, against @rails49/detector as packed
# from the rails49/detector checkout beside this one, then puts the pinned
# version back.
#
#   bin/with-detector.sh [command...]
#   bin/with-detector.sh pnpm --filter @occupancy/ui dev
set -euo pipefail
cd "$(dirname "$0")/.."

pinned=(pnpm-workspace.yaml pnpm-lock.yaml)
if ! git diff --quiet HEAD -- "${pinned[@]}"; then
  echo "❌ ${pinned[*]} have uncommitted changes, and the undo would discard them" >&2
  exit 1
fi

detector=$(cd ../detector && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/with-detector.XXXXXX")
trap 'git checkout -q HEAD -- "${pinned[@]}" && pnpm install --frozen-lockfile >/dev/null; rm -rf "$work"' EXIT

pnpm --dir "$detector" --filter @rails49/detector build
"$detector/bin/check-package.sh" "$work"
tarball=$(echo "$work"/*.tgz)

sed "s|^\(  \"@rails49/detector\":\).*|\1 file:$tarball|" pnpm-workspace.yaml > "$work/workspace.yaml"
cp "$work/workspace.yaml" pnpm-workspace.yaml
grep -q "file:$tarball" pnpm-workspace.yaml
pnpm install --no-frozen-lockfile >/dev/null

# One onnxruntime-web: the ort.env.wasm the UI configures must be the one the
# detector's session reads (ui/src/detectorSession.ts).
resolve() { (cd "$1" && node -p "require('fs').realpathSync(require.resolve('onnxruntime-web'))"); }
if [ "$(resolve ui)" != "$(resolve ui/node_modules/@rails49/detector)" ]; then
  echo "❌ @rails49/detector resolves a different onnxruntime-web from the UI's" >&2
  exit 1
fi
echo "✅ @rails49/detector from $detector, with the UI's onnxruntime-web"

if [ $# -eq 0 ]; then set -- bin/test.sh; fi
"$@"
