#!/bin/bash
# Refuse to publish a deploy directory containing anything unaccounted for.
#
# Every guard `bin/deploy.sh` had was one-directional — the ORT binary must be
# *present*, no single file may exceed Cloudflare's per-file limit — and none of
# them could see 21 MB of corpus archives sitting in the bundle: six files,
# individually small, with an ordinary extension, reached through a symlink the
# copy dereferenced (#122). This is the other direction: what may ship is a
# list, and anything else is a failure with a path attached.
#
# Its own script rather than a block inside `bin/deploy.sh` so that it can be
# run against a directory built for the purpose. `ui/tests/deployGuard.test.ts`
# does exactly that — it constructs deploy directories and runs *this* file, so
# the inventory below has no second copy anywhere to drift from.
#
# `pipefail` is not decoration: the total-size check reads the bundle through a
# pipe, and without it a `cat` that fails on one file still leaves `wc` exiting
# 0 — the gate would pass on an understated total. Measured: a 200 KB file made
# unreadable took 200 KB off the reported size and nothing said a word. Every
# other check here fails closed; that one would have failed open.
set -eo pipefail

DEPLOY_DIR="$1"

if [ -z "$DEPLOY_DIR" ]; then
  echo "❌ Error: usage: $(basename "$0") <deploy-directory>"
  exit 1
fi

if [ ! -d "$DEPLOY_DIR" ]; then
  echo "❌ Error: Deployment directory '$DEPLOY_DIR' not found."
  exit 1
fi

# --- The inventory -----------------------------------------------------------
#
# One level, and that is not a weakening of the two this had when the app was
# staged under `ui/` (rails49/control#47). Those two levels were the staging
# root and the build output's top level; the build output is now the deploy
# directory itself, so this one list names exactly the set the two used to. #122
# landed on that level — the archives appeared at `proto-fixtures/`, inside the
# subtree the build legitimately writes — and it is still the level checked.
#
# A list rather than a rule, following `ui/tests/publicDir.test.ts` and
# `ui/tests/modelAssets.test.ts`. Every cheaper rule has to guess which content
# counts, and what shipped was ordinary by every cheap measure. Membership, not
# equality: `ui/models/` is absent on a clone with no local detector, and the
# app ships a no-model banner instead (#85).
#
# One level is where it stops, and that is a real limit rather than an
# oversight: `shoelace/assets/icons/` is 2000 files two levels down, so a deeper
# inventory would have to enumerate a vendored tree. Payload buried under a name
# and extension the list allows is left to the size budget, which is why the
# budget is part of this and not a nicety.

# Everything the deploy directory may hold. `assets` is vite's hashed output,
# `ort` and `shoelace` and `models` are `viteStaticCopy` targets named in
# `ui/ortAssets.ts` and `ui/modelCopy.ts`, and `_headers` and the two SVGs are
# all of `ui/public/`, which vite copies to the root verbatim.
ROOT_ENTRIES="_headers index.html assets ort shoelace models favicon.svg icons.svg"

# Extensions that never belong in a web bundle. Redundant with the inventory
# above by design — each names a real directory in this repo or beside it that
# somebody could copy or link in, and this half of the guard still fires when
# the content arrives somewhere the inventory does not reach.
FORBIDDEN_EXTENSIONS="r49 pt onnx ipynb"

# The bundle measured 18.0 MiB over 2061 files on the day this was written:
# 12.4 MiB of ORT runtime, 3.4 MiB of INT8 detector, 1.5 MiB of shoelace icons,
# 0.6 MiB of app, 0.02 MiB of markup and SVGs. 24 MiB leaves a third again in
# headroom — enough for a detector retrained at a larger size, and well below
# the 38.7 MiB the bundle measured with the fixtures in it. Raise it
# deliberately, with a reason: the number is only worth having while it still
# means something.
#
# (Those are apparent bytes. The same tree is 25 MB by `du`, which is block
# size — 2000-odd shoelace icons of a few hundred bytes each rounding up to a
# 4 KiB block. Measure this one the way the check below does, or the budget
# ends up justified by a number 40% too big.)
#
# Not Cloudflare's limit, which is per file and is checked separately. This is
# the project's own, and it is the check that would have fired in #122.
MAX_TOTAL_BYTES=$((24 * 1024 * 1024))

# --- The checks --------------------------------------------------------------

# A symlink is the mechanism that made #122 invisible: the copy follows it, so
# what lands in the bundle is an ordinary file carrying no trace of its origin.
# Refuse the link itself, where the trace still exists.
LINKS=$(find "$DEPLOY_DIR" -type l)
if [ -n "$LINKS" ]; then
  echo "❌ Error: the deploy directory contains symlinks:"
  echo "$LINKS"
  echo "   A copy follows these, so what ships is indistinguishable from build output."
  exit 1
fi

# Report entries of directory $1 whose names are not in the allow-list $2.
unaccounted() {
  local dir="$1" allowed=" $2 "
  [ -d "$dir" ] || return 0
  find "$dir" -mindepth 1 -maxdepth 1 | while read -r entry; do
    case "$allowed" in
      *" $(basename "$entry") "*) ;;
      *) echo "$entry" ;;
    esac
  done
}

UNACCOUNTED=$(unaccounted "$DEPLOY_DIR" "$ROOT_ENTRIES")
if [ -n "$UNACCOUNTED" ]; then
  echo "❌ Error: the deploy directory contains entries the inventory does not name:"
  echo "$UNACCOUNTED"
  echo "   Remove them, or add them to the inventory in $(basename "$0") if they belong in a release."
  exit 1
fi

FIND_FORBIDDEN=()
for ext in $FORBIDDEN_EXTENSIONS; do
  FIND_FORBIDDEN+=(-o -name "*.$ext")
done
FORBIDDEN=$(find "$DEPLOY_DIR" -type f \( "${FIND_FORBIDDEN[@]:1}" \))
if [ -n "$FORBIDDEN" ]; then
  echo "❌ Error: these files have an extension that never ships:"
  echo "$FORBIDDEN"
  exit 1
fi

# `_headers` must ship, and must still isolate. It used to be a tracked file in
# the staging directory, where it could not go missing without someone deleting
# it from git; it comes through the build now (`ui/public/`), and the inventory
# above is what *may* appear rather than what must. Its absence is the quietest
# failure here — the app works, nothing logs anything, and ORT drops to a single
# WASM thread for ~1.5x on every inference (#15). Checked like the ORT binary
# below, and for the same reason: silent, and only visible at this point.
HEADERS_FILE="$DEPLOY_DIR/_headers"
if [ ! -f "$HEADERS_FILE" ]; then
  echo "❌ Error: _headers is missing from the bundle; the app would lose cross-origin"
  echo "   isolation silently. It ships from ui/public/ — check the build copied it."
  exit 1
fi
if ! grep -qi '^[[:space:]]*Cross-Origin-Embedder-Policy:[[:space:]]*require-corp' "$HEADERS_FILE"; then
  echo "❌ Error: _headers ships but no longer sets Cross-Origin-Embedder-Policy:"
  echo "   require-corp, so the app would not be crossOriginIsolated."
  exit 1
fi

# The ONNX Runtime WASM binary must ship from origin: `_headers` sets
# Cross-Origin-Embedder-Policy: require-corp on /* so the app is
# crossOriginIsolated and ORT can use more than one thread (#15), and a
# cross-origin CDN would fail that check. Only the plain build is copied
# (see ui/ortAssets.ts) — the jsep one is over Cloudflare's limit.
ORT_WASM="ort-wasm-simd-threaded.wasm"
if [ ! -f "$DEPLOY_DIR/ort/$ORT_WASM" ]; then
  echo "❌ Error: $ORT_WASM is missing from the bundle; the app would not run."
  exit 1
fi

# Fail loudly rather than deploying a bundle Cloudflare will reject.
OVERSIZED=$(find "$DEPLOY_DIR" -type f -size +25M)
if [ -n "$OVERSIZED" ]; then
  echo "❌ Error: these files exceed Cloudflare's 25 MiB limit:"
  echo "$OVERSIZED"
  exit 1
fi

# Summed by reading the files rather than with `du`, which reports disk blocks:
# 2000-odd shoelace icons round up to a 4 KiB block each and report the bundle
# 40% larger than it is. Bytes are what gets uploaded.
TOTAL_BYTES=$(find "$DEPLOY_DIR" -type f -exec cat {} + | wc -c)
TOTAL_MIB=$(awk "BEGIN { printf \"%.1f\", $TOTAL_BYTES / 1048576 }")
BUDGET_MIB=$((MAX_TOTAL_BYTES / 1024 / 1024))
if [ "$TOTAL_BYTES" -gt "$MAX_TOTAL_BYTES" ]; then
  echo "❌ Error: the deploy directory is $TOTAL_MIB MiB, over the $BUDGET_MIB MiB budget."
  echo "   The largest entries:"
  # `|| true` because this is the diagnostic, not the verdict: `head` closing
  # the pipe early is a pipefail failure, and it must not pre-empt the two
  # lines below that say what to do about it.
  du -sh "$DEPLOY_DIR"/* 2>/dev/null | sort -rh | head -5 || true
  echo "   Either something is in there that should not be, or the budget needs"
  echo "   raising on purpose in $(basename "$0")."
  exit 1
fi

echo "✅ Deploy directory checks passed — $TOTAL_MIB MiB of a $BUDGET_MIB MiB budget."
