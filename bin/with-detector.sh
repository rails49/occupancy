#!/usr/bin/env bash
# Runs a command, bin/test.sh by default, against @rails49/detector as packed
# from the rails49/detector checkout beside this one, then puts the pinned
# version back.
#
#   bin/with-detector.sh [command...]
#   bin/with-detector.sh pnpm --filter @occupancy/ui dev
set -euo pipefail
cd "$(dirname "$0")/.."

pinned=(package.json pnpm-lock.yaml)
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

# A catalog entry cannot be a file: spec, so the tarball goes in as an override.
node - "$tarball" <<'JS'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
manifest.pnpm.overrides['@rails49/detector'] = `file:${process.argv[2]}`;
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
JS
pnpm install --no-frozen-lockfile

pnpm --filter @occupancy/ui ls @rails49/detector --json | node -e '
const [ui] = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const resolved = ui.dependencies["@rails49/detector"].resolved;
if (!resolved.startsWith("file:")) {
  console.error(`❌ the UI has @rails49/detector from ${resolved}, not the tarball`);
  process.exit(1);
}'

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
