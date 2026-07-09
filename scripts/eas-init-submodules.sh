#!/usr/bin/env bash
# EAS Build pre-install hook: ensure the @hearthshelf/core submodule content is
# present. EAS Workflows' CI checkout uploads the submodule pointer + .gitmodules
# but not the submodule's file contents, so packages/core/src arrives empty and
# Metro fails to resolve @hearthshelf/core. HearthShelf-Core is public, so we can
# populate it over HTTPS with no SSH key or secret.
set -euo pipefail

CORE_DIR="packages/core"
CORE_URL="https://github.com/HearthShelf/HearthShelf-Core.git"

# The pinned commit recorded by the parent repo's submodule gitlink. Building
# against this (not a moving branch) keeps the build matching the committed
# pointer. Falls back to origin/main if the gitlink can't be read.
PINNED_SHA="$(git rev-parse ":$CORE_DIR" 2>/dev/null || echo '')"

if [ -f "$CORE_DIR/src/index.ts" ]; then
  echo "core submodule already populated"
  exit 0
fi

echo "core submodule empty - populating from $CORE_URL"

if git submodule update --init --recursive "$CORE_DIR" 2>/dev/null && [ -f "$CORE_DIR/src/index.ts" ]; then
  echo "populated via git submodule update"
  exit 0
fi

echo "submodule update did not populate contents; cloning directly"
rm -rf "$CORE_DIR"
git clone "$CORE_URL" "$CORE_DIR"
if [ -n "$PINNED_SHA" ]; then
  git -C "$CORE_DIR" checkout "$PINNED_SHA"
else
  echo "WARNING: could not read pinned submodule SHA; using default branch"
fi

test -f "$CORE_DIR/src/index.ts" && echo "core submodule ready" || {
  echo "ERROR: core submodule still missing src/index.ts" >&2
  exit 1
}
