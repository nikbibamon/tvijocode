#!/usr/bin/env bash
# Embed the pinned Tvijo extensions into a packed app tree as built-ins.
#
# Runs after gulp "*-min-packing" and before prepare_assets.sh, i.e. on the
# folder the installers are made from. Copying into the packed tree (instead of
# vscode/extensions/) keeps gulp from trying to rebuild a prebuilt extension;
# it is the same layout the Tvijo Code 0.1.0 repack shipped with.
#
# usage: tvijo/embed_extensions.sh ../VSCode-win32-x64

set -euo pipefail

APP_DIR="${1:?usage: embed_extensions.sh <VSCode-platform-arch dir>}"
LOCK="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )/extensions.lock.json"

EXT_ROOT="$( find "${APP_DIR}" -maxdepth 6 -type d -path '*/resources/app/extensions' | head -1 )"
if [[ -z "${EXT_ROOT}" ]]; then
  echo "no resources/app/extensions under ${APP_DIR}" >&2
  exit 1
fi

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

WORK="$( mktemp -d )"
trap 'rm -rf "${WORK}"' EXIT

# Index loop, not mapfile: macOS runners may still start bash 3.2.
COUNT="$( jq 'length' "${LOCK}" )"
if [[ "${COUNT}" -eq 0 ]]; then
  echo "empty ${LOCK}" >&2
  exit 1
fi

for (( i = 0; i < COUNT; i++ )); do
  ENTRY="$( jq -c ".[${i}]" "${LOCK}" )"
  DIR="$( jq -r '.dir' <<< "${ENTRY}" )"
  URL="$( jq -r '.url' <<< "${ENTRY}" )"
  WANT_SHA="$( jq -r '.sha256' <<< "${ENTRY}" )"
  WANT_VERSION="$( jq -r '.version' <<< "${ENTRY}" )"

  curl -fsSL --retry 3 -o "${WORK}/${DIR}.vsix" "${URL}"
  GOT_SHA="$( sha256 "${WORK}/${DIR}.vsix" )"
  if [[ "${GOT_SHA}" != "${WANT_SHA}" ]]; then
    echo "sha256 mismatch for ${URL}: ${GOT_SHA}" >&2
    exit 1
  fi

  unzip -q "${WORK}/${DIR}.vsix" 'extension/*' -d "${WORK}/${DIR}"
  rm -rf "${EXT_ROOT:?}/${DIR}"
  mkdir -p "${EXT_ROOT}/${DIR}"
  cp -R "${WORK}/${DIR}/extension/." "${EXT_ROOT}/${DIR}/"

  GOT_VERSION="$( jq -r '.version' "${EXT_ROOT}/${DIR}/package.json" )"
  if [[ "${GOT_VERSION}" != "${WANT_VERSION}" ]]; then
    echo "${DIR}: expected ${WANT_VERSION}, unpacked ${GOT_VERSION}" >&2
    exit 1
  fi
  echo "embedded ${DIR} ${GOT_VERSION} into ${EXT_ROOT}"
done
