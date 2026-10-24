#!/usr/bin/env bash
# Keep the newest N editor releases, delete older ones with their tags.
#
# Every manual build publishes a release, so without this the Releases page
# fills with superseded test builds. Only VS Code-version tags (1.140.07150)
# are touched; ext-* (pinned extension inputs) and mcp-v* are never deleted.
#
# usage: tvijo/prune_releases.sh <keep>   (needs GH_TOKEN and ASSETS_REPOSITORY)

set -euo pipefail

KEEP="${1:?usage: prune_releases.sh <keep>}"
REPO="${ASSETS_REPOSITORY:?ASSETS_REPOSITORY is not set}"

if ! [[ "${KEEP}" =~ ^[1-9][0-9]*$ ]]; then
  echo "keep must be a positive integer, got '${KEEP}'" >&2
  exit 1
fi

# Newest first; a release that is not a VS Code version is filtered out here.
OLD_TAGS="$( gh release list --repo "${REPO}" --limit 200 --json tagName,createdAt \
  --jq 'map(select(.tagName | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))) | sort_by(.createdAt) | reverse | .[] | .tagName' \
  | tail -n +"$(( KEEP + 1 ))" )"

if [[ -z "${OLD_TAGS}" ]]; then
  echo "nothing to prune (keeping up to ${KEEP})"
  exit 0
fi

while IFS= read -r TAG; do
  [[ -n "${TAG}" ]] || continue
  echo "deleting release ${TAG}"
  gh release delete "${TAG}" --repo "${REPO}" --cleanup-tag --yes < /dev/null
done <<< "${OLD_TAGS}"
