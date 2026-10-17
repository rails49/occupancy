#!/bin/bash
# Refuse to deploy anything but a clean checkout of origin/main.
# `ui/tests/deploySource.test.ts` runs it against throwaway clones.
set -e

git fetch -q origin main

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Error: the working tree has uncommitted changes:"
  git status --short
  exit 1
fi

HEAD_SHA=$(git rev-parse HEAD)
MAIN_SHA=$(git rev-parse origin/main)
if [ "$HEAD_SHA" != "$MAIN_SHA" ]; then
  echo "❌ Error: HEAD ($(git rev-parse --short HEAD), $(git branch --show-current)) is not origin/main ($(git rev-parse --short origin/main))."
  exit 1
fi
