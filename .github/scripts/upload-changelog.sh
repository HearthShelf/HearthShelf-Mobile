#!/usr/bin/env bash
# Build the structured changelog for the current tag and POST it to the
# HearthShelf website changelog API. Also renders a human CHANGELOG.md from the
# same structured items as a side effect (attached to the release build).
#
# Env:
#   CHANGELOG_API_KEY  Bearer token; must match the website binding (required)
#   CHANGELOG_API_URL  POST target (default https://hearthshelf.com/api/v1/changelogs)
#   PRODUCT            product key (default HearthShelf-Mobile)
#   RELEASE_VERSION    normalized version string (passed through to the generator)
#   DOWNLOAD_URL       optional store/download link
#   GITHUB_REF         refs/tags/vX.Y.Z on a tag push (upload is skipped otherwise)
set -euo pipefail

API_URL="${CHANGELOG_API_URL:-https://hearthshelf.com/api/v1/changelogs}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${CHANGELOG_API_KEY:-}" ]; then
  echo "SKIP: CHANGELOG_API_KEY not set" >&2
  exit 0
fi
if [ -n "${GITHUB_REF:-}" ] && [[ ! "$GITHUB_REF" =~ ^refs/tags/ ]]; then
  echo "SKIP: not a tag push ($GITHUB_REF)" >&2
  exit 0
fi

PAYLOAD="$("$SCRIPT_DIR/changelog-items.sh")"
COUNT="$(jq '.items | length' <<<"$PAYLOAD")"
VERSION="$(jq -r '.version' <<<"$PAYLOAD")"
echo "Uploading $COUNT items for version $VERSION" >&2

# Render CHANGELOG.md from the same structured items (same section order as the
# website). Tags are shown in parentheses after each line.
{
  echo "# HearthShelf Mobile $VERSION"
  echo
  for section in breaking feature fix change docs; do
    label="$(jq -r --arg s "$section" '
      {breaking:"### Breaking Changes",feature:"### Features",fix:"### Fixes",
       change:"### Changes",docs:"### Documentation"}[$s]' <<<'{}')"
    rows="$(jq -r --arg s "$section" '.items[]|select(.section==$s)|
      "- " + .text + (if (.tags|length)>0 then " (" + (.tags|join(", ")) + ")" else "" end)' \
      <<<"$PAYLOAD")"
    [ -n "$rows" ] && {
      echo "$label"
      echo
      echo "$rows"
      echo
    }
  done
} >CHANGELOG.md

HTTP_CODE="$(curl -sS -o /tmp/cl-resp.json -w '%{http_code}' \
  --connect-timeout 10 --max-time 30 -X POST "$API_URL" \
  -H "Authorization: Bearer $CHANGELOG_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD")" || {
  echo "curl failed to reach $API_URL" >&2
  exit 1
}

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "SUCCESS ($HTTP_CODE): $(cat /tmp/cl-resp.json)"
else
  echo "ERROR ($HTTP_CODE): $(cat /tmp/cl-resp.json)" >&2
  exit 1
fi
