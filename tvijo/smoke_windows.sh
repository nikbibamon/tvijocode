#!/usr/bin/env bash
# Smoke test of the portable Windows zip on the CI runner, before release.
#
# Checks what a user would hit first: the app starts and reports a version,
# it is called Tvijo Code, it talks to Open VSX (not the Microsoft gallery),
# auto-update is off, the Tvijo extension is inside at the pinned version.

set -euo pipefail

TVIJO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ZIP="$( ls assets/"${APP_NAME}"-win32-"${VSCODE_ARCH}"-*.zip | head -1 )"
DIR="$( mktemp -d )"
trap 'rm -rf "${DIR}"' EXIT

7z.exe x -y -o"${DIR}" "${ZIP}" > /dev/null

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

PRODUCT="${DIR}/resources/app/product.json"
[[ -f "${PRODUCT}" ]] || fail "no product.json in ${ZIP}"

[[ "$( jq -r '.nameShort' "${PRODUCT}" )" == "Tvijo Code" ]] || fail "nameShort is $( jq -r '.nameShort' "${PRODUCT}" )"
[[ "$( jq -r '.applicationName' "${PRODUCT}" )" == "tvijocode" ]] || fail "applicationName"
jq -e '.extensionsGallery.serviceUrl | startswith("https://open-vsx.org/")' "${PRODUCT}" > /dev/null || fail "gallery is not Open VSX"
jq -e 'has("updateUrl") | not' "${PRODUCT}" > /dev/null || fail "updateUrl is set"
if grep -qiE 'vortex\.data\.microsoft\.com|dc\.services\.visualstudio\.com|mobile\.events\.data\.microsoft\.com' "${PRODUCT}"; then
  fail "Microsoft telemetry endpoint in product.json"
fi

mapfile -t ENTRIES < <( jq -c '.[]' "${TVIJO_DIR}/extensions.lock.json" )
for ENTRY in "${ENTRIES[@]}"; do
  EXT_DIR="$( jq -r '.dir' <<< "${ENTRY}" )"
  WANT="$( jq -r '.version' <<< "${ENTRY}" )"
  PKG="${DIR}/resources/app/extensions/${EXT_DIR}/package.json"
  [[ -f "${PKG}" ]] || fail "${EXT_DIR} is not embedded"
  [[ "$( jq -r '.version' "${PKG}" )" == "${WANT}" ]] || fail "${EXT_DIR} version $( jq -r '.version' "${PKG}" ) != ${WANT}"
done

[[ -f "${DIR}/Tvijo Code.exe" ]] || fail "no 'Tvijo Code.exe' at the zip root"

# The .cmd launcher runs the CLI under Electron-as-node, which prints to stdout.
VERSION_OUT="$( cmd.exe //c "$( cygpath -w "${DIR}/bin/${BINARY_NAME}.cmd" )" --version | tr -d '\r' )"
echo "${VERSION_OUT}"
[[ "$( head -1 <<< "${VERSION_OUT}" )" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "--version did not print a version"

echo "SMOKE OK: ${ZIP}"
